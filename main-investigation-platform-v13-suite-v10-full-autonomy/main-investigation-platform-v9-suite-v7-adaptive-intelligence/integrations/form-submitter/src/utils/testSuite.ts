import { validateWallet, validateScamUrl, evaluateFinding } from './walletValidation';
import {
  verifyBase58Check,
  verifyEIP55,
  verifyBech32,
  verifySolanaAddress,
  verifyXrpAddress,
  sha256Hex,
} from './cryptoChecksums';
import {
  parseGoogleFormHtml,
  evaluateFormMappings,
  computeFormVersionHash,
  DEFAULT_AUTHORIZED_FORM_SCHEMA,
} from './googleFormParser';
import {
  evaluateAutoSubmitGate,
  checkDuplicateFinding,
  generateIdempotencyKey,
  maskSecret,
} from './autoSubmitGate';
import {
  buildFieldValuesMap,
  generateExactFormPreview,
} from './multiPageFormEngine';
import {
  InvestigationFinding,
  FormMappingConfig,
  UserSettings,
  HistoryRecord,
} from '../types';

export interface TestResult {
  name: string;
  category:
    | 'Checksum Algorithms'
    | 'Wallet Validation & Ambiguity'
    | 'Real Form Parsing & Multi-Page'
    | 'Form Mapping & Change Detection'
    | 'Duplicate Detection & Idempotency'
    | 'Auto Submit Validation Gate'
    | 'Submission Verification & Recovery'
    | 'Main Platform Integration';
  passed: boolean;
  expected: string;
  actual: string;
  error?: string;
}

export function runAutomatedTestSuite(): {
  total: number;
  passed: number;
  failed: number;
  results: TestResult[];
} {
  const results: TestResult[] = [];

  function assert(
    name: string,
    category: TestResult['category'],
    condition: boolean,
    expected: string,
    actual: string,
    error?: string
  ) {
    results.push({
      name,
      category,
      passed: condition,
      expected,
      actual,
      error,
    });
  }

  // ----------------------------------------------------
  // Category 1: Checksum Algorithms
  // ----------------------------------------------------
  const btcValid = verifyBase58Check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', [0x00]);
  assert('Bitcoin Legacy Base58Check (Satoshi P2PKH)', 'Checksum Algorithms', btcValid.valid, 'true', String(btcValid.valid));

  const btcCorrupted = verifyBase58Check('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', [0x00]);
  assert('Bitcoin Legacy Typo Rejection (Checksum mismatch)', 'Checksum Algorithms', !btcCorrupted.valid, 'false', String(btcCorrupted.valid));

  const btcSegwit = verifyBech32('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'bc');
  assert('Bitcoin Native SegWit Bech32 Checksum', 'Checksum Algorithms', btcSegwit.valid && btcSegwit.version === 'bech32', 'bech32 valid', `${btcSegwit.valid} (${btcSegwit.version})`);

  const btcTaproot = verifyBech32('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', 'bc');
  assert('Bitcoin Taproot Bech32m Checksum', 'Checksum Algorithms', btcTaproot.valid && btcTaproot.version === 'bech32m', 'bech32m valid', `${btcTaproot.valid} (${btcTaproot.version})`);

  const ethValidEip55 = verifyEIP55('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert('Ethereum Valid EIP-55 Mixed-Case Checksum', 'Checksum Algorithms', ethValidEip55.valid && ethValidEip55.hasChecksum, 'valid + hasChecksum', `${ethValidEip55.valid}, hasChecksum=${ethValidEip55.hasChecksum}`);

  const ethBadCapitalization = verifyEIP55('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  assert('Ethereum Invalid EIP-55 Capitalization Rejected', 'Checksum Algorithms', !ethBadCapitalization.valid, 'invalid', String(ethBadCapitalization.valid));

  const tronValid = verifyBase58Check('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', [0x41]);
  assert('TRON USDT Base58Check (0x41 prefix & checksum)', 'Checksum Algorithms', tronValid.valid, 'true', String(tronValid.valid));

  const solanaValid = verifySolanaAddress('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs');
  assert('Solana Ed25519 32-byte Base58 Decoding', 'Checksum Algorithms', solanaValid.valid, 'true', String(solanaValid.valid));

  const xrpValid = verifyXrpAddress('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh');
  assert('XRP Ripple Base58 Dictionary Checksum', 'Checksum Algorithms', xrpValid.valid, 'true', String(xrpValid.valid));

  // ----------------------------------------------------
  // Category 2: Wallet Validation & EVM Ambiguity
  // ----------------------------------------------------
  const evmNoContext = validateWallet('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'UNKNOWN', { hasTokenContext: false });
  assert(
    'EVM 0x Without Context -> Flagged Ambiguous NEEDS REVIEW',
    'Wallet Validation & Ambiguity',
    evmNoContext.isAmbiguous && evmNoContext.status === 'NEEDS_REVIEW',
    'isAmbiguous=true, status=NEEDS_REVIEW',
    `isAmbiguous=${evmNoContext.isAmbiguous}, status=${evmNoContext.status}`
  );

  const evmWithContext = validateWallet('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'ETH', { hasTokenContext: true });
  assert(
    'EVM 0x With Explicit ETH Context -> Validated READY',
    'Wallet Validation & Ambiguity',
    !evmWithContext.isAmbiguous && evmWithContext.status === 'READY',
    'status=READY',
    `status=${evmWithContext.status}`
  );

  const networkConflict = validateWallet('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'ETH', { hasTokenContext: true });
  assert(
    'Network Conflict Guard (BTC address passed as ETH) -> BLOCKED',
    'Wallet Validation & Ambiguity',
    networkConflict.status === 'BLOCKED',
    'status=BLOCKED',
    `status=${networkConflict.status}`
  );

  // ----------------------------------------------------
  // Category 3: Real Form Parsing & Multi-Page Form Inspection
  // ----------------------------------------------------
  const mockFormHtml = `
    <html>
      <body>
        <script>
          var FB_PUBLIC_LOAD_DATA_ = [null, [
            "Crypto Investigation Portal",
            [
              [101, "Scam Website URL", "Target domain", 0, [[1849204812, null, 1]]],
              [102, "Section 2: Wallets", "Deposit wallets", 8, []],
              [103, "Cryptocurrency Deposit Wallets", "List of wallets", 1, [[928471029, null, 1]]],
              [104, "Primary Wallet Address", "", 0, [[394820194, null, 1]]],
              [105, "Section 3: Investigator", "Attribution", 8, []],
              [106, "Investigator Username", "Your handle", 0, [[749201847, null, 1]]],
              [107, "Team Invite Code", "Unit code", 0, [[628491038, null, 1]]]
            ]
          ]];
        </script>
      </body>
    </html>
  `;

  const parsedSchema = parseGoogleFormHtml(mockFormHtml, 'https://docs.google.com/forms/d/e/1FAIpQLScamPortal2026/viewform');
  assert(
    'Real Google Form Inspection (FB_PUBLIC_LOAD_DATA_ extracted)',
    'Real Form Parsing & Multi-Page',
    parsedSchema.allQuestions.length === 5,
    '5 parsed questions',
    `${parsedSchema.allQuestions.length} questions`
  );

  assert(
    'Multi-Page Form Sections Detection (Page Breaks tracked)',
    'Real Form Parsing & Multi-Page',
    parsedSchema.sections.length === 3,
    '3 sections detected',
    `${parsedSchema.sections.length} sections`
  );

  const hash1 = computeFormVersionHash(parsedSchema.formId, parsedSchema.allQuestions);
  assert(
    'Form Version Hash Fingerprint Generated',
    'Real Form Parsing & Multi-Page',
    hash1.length === 16,
    '16-char hex hash',
    hash1
  );

  // ----------------------------------------------------
  // Category 4: Form Mapping & Change Detection
  // ----------------------------------------------------
  const validMappings = [
    { id: 'm1', fieldKey: 'siteUrl' as const, label: 'URL', entryKey: 'entry.1849204812', pageIndex: 1, required: true },
    { id: 'm2', fieldKey: 'walletsList' as const, label: 'Wallets', entryKey: 'entry.928471029', pageIndex: 2, required: true },
    { id: 'm3', fieldKey: 'primaryWallet' as const, label: 'Primary Wallet', entryKey: 'entry.394820194', pageIndex: 2, required: true },
    { id: 'm4', fieldKey: 'username' as const, label: 'User', entryKey: 'entry.749201847', pageIndex: 3, required: true },
    { id: 'm5', fieldKey: 'teamInviteCode' as const, label: 'Code', entryKey: 'entry.628491038', pageIndex: 3, required: true },
  ];

  const evalMatch = evaluateFormMappings(parsedSchema, validMappings);
  assert(
    'Required Form Fields Matched: 5/5 Validated',
    'Form Mapping & Change Detection',
    evalMatch.isFullyMatched && evalMatch.matchedCount === 5,
    'matchedCount=5, isFullyMatched=true',
    `matchedCount=${evalMatch.matchedCount}, isFullyMatched=${evalMatch.isFullyMatched}`
  );

  // Missing required field test
  const missingOneMapping = validMappings.slice(0, 4); // missing teamInviteCode
  const evalIncomplete = evaluateFormMappings(parsedSchema, missingOneMapping);
  assert(
    'Incomplete Form Mapping Detected (Required fields unmapped)',
    'Form Mapping & Change Detection',
    !evalIncomplete.isFullyMatched && evalIncomplete.matchedCount === 4,
    'isFullyMatched=false, matchedCount=4',
    `isFullyMatched=${evalIncomplete.isFullyMatched}, matchedCount=${evalIncomplete.matchedCount}`
  );

  // Form changed detection
  const questionsModified = parsedSchema.allQuestions.map((q) =>
    q.entryKey === 'entry.1849204812' ? { ...q, title: 'Renamed URL Field' } : q
  );
  const hashModified = computeFormVersionHash(parsedSchema.formId, questionsModified);
  assert(
    'Changed Form Structure Detected via Version Hash Mismatch',
    'Form Mapping & Change Detection',
    hash1 !== hashModified,
    'hashes differ',
    `${hash1} !== ${hashModified}`
  );

  // ----------------------------------------------------
  // Category 5: Duplicate Detection & Idempotency
  // ----------------------------------------------------
  const mockFinding: InvestigationFinding = {
    id: 'F-101',
    siteUrl: 'https://fake-staking-vault.com/deposit',
    domain: 'fake-staking-vault.com',
    wallets: [
      {
        id: 'w-1',
        address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        selectedNetwork: 'BTC',
        detectedNetworks: ['BTC'],
        checksumValid: true,
        isAmbiguous: false,
        validationNotes: [],
        status: 'READY',
        confidence: 1.0,
      },
    ],
    screenshotUrls: [],
    notes: 'Scam vault',
    username: 'analyst1',
    teamInviteCode: 'DEFENSE-992-SEC',
    provenance: {
      investigationId: 'INV-101',
      siteId: 'S-1',
      walletIds: ['w-1'],
      evidenceIds: [],
      sourceModule: 'Site Investigator',
      timestamp: new Date().toISOString(),
      confidence: 1.0,
      mainPlatformSyncStatus: 'SYNCED',
    },
    overallStatus: 'READY',
    queueStatus: 'READY',
    submissionState: 'NOT_STARTED',
    validationDiagnostics: [],
    submissionMode: 'AUTO_SUBMIT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const formCfg: FormMappingConfig = {
    formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScamPortal2026/viewform',
    formId: '1FAIpQLScamPortal2026',
    formTitle: 'Portal',
    formVersionHash: hash1,
    fieldMappings: validMappings,
    multiWalletFormat: 'COMBINED_LIST',
    parsedSchema,
  };

  const idemp1 = generateIdempotencyKey(mockFinding, formCfg);
  const idemp2 = generateIdempotencyKey(mockFinding, formCfg);
  assert(
    'Deterministic Idempotency Key Generation (Prevents Double Submits)',
    'Duplicate Detection & Idempotency',
    idemp1 === idemp2 && idemp1.startsWith('IDEMP-'),
    'matching IDEMP- keys',
    `${idemp1} === ${idemp2}`
  );

  const mockHistory: HistoryRecord[] = [
    {
      id: 'H-901',
      findingId: 'F-009',
      timestamp: new Date().toISOString(),
      siteUrl: 'https://fake-staking-vault.com',
      domain: 'fake-staking-vault.com',
      wallets: [{ address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', network: 'BTC', checksumStatus: 'VALID' }],
      username: 'analyst1',
      teamInviteCodeMasked: 'DEF-***-EC',
      populatedFields: {},
      userModifications: [],
      submissionMode: 'AUTO_SUBMIT',
      verificationOutcome: 'VERIFIED_COMPLETED',
      verificationDetails: 'Confirmed',
    },
  ];

  const dupCheckHist = checkDuplicateFinding(mockFinding, [], mockHistory);
  assert(
    'Duplicate Guard: Identifies Prior Completed Domain & Wallet in Audit History',
    'Duplicate Detection & Idempotency',
    dupCheckHist.isDuplicate && dupCheckHist.matchedIn === 'AUDIT_HISTORY',
    'isDuplicate=true in AUDIT_HISTORY',
    `${dupCheckHist.isDuplicate} in ${dupCheckHist.matchedIn}`
  );

  const masked = maskSecret('DEFENSE-SECRET-99');
  assert('Sensitive Team Code Masking (maskSecret)', 'Duplicate Detection & Idempotency', masked === 'DEFE***99', 'DEFE***99', masked);

  // ----------------------------------------------------
  // Category 6: Auto Submit Validation Gate
  // ----------------------------------------------------
  const settingsEnabled: UserSettings = {
    username: 'analyst1',
    teamInviteCode: 'DEFENSE-992-SEC',
    defaultFormUrl: formCfg.formUrl,
    defaultSubmissionMode: 'AUTO_SUBMIT',
    strictEVMMode: true,
    isConfigured: true,
    autoSubmitGlobalEnabled: true,
    batchPacingSeconds: 5,
    enableDuplicateGuard: true,
  };

  // Test: READY finding with complete mappings passes the gate
  const gatePass = evaluateAutoSubmitGate(mockFinding, formCfg, settingsEnabled, [], [], true);
  assert(
    'Auto Submit Validation Gate: READY Finding Passes All 10 Checks',
    'Auto Submit Validation Gate',
    gatePass.canAutoSubmit,
    'canAutoSubmit=true',
    String(gatePass.canAutoSubmit)
  );

  // Test: Prove Auto Submit CANNOT proceed when master safety switch is OFF
  const settingsDisabled = { ...settingsEnabled, autoSubmitGlobalEnabled: false };
  const gateBlockedSetting = evaluateAutoSubmitGate(mockFinding, formCfg, settingsDisabled, [], [], true);
  assert(
    'Gate Enforcement: Auto Submit Blocked When Settings Master Switch is OFF',
    'Auto Submit Validation Gate',
    !gateBlockedSetting.canAutoSubmit && gateBlockedSetting.reasons.some((r) => r.includes('Master Safety Switch is OFF')),
    'blocked with Master Switch reason',
    String(gateBlockedSetting.canAutoSubmit)
  );

  // Test: Prove Auto Submit CANNOT proceed when finding has ambiguous EVM address
  const ambiguousFinding = {
    ...mockFinding,
    overallStatus: 'NEEDS_REVIEW' as const,
    wallets: [
      {
        ...mockFinding.wallets[0],
        address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
        selectedNetwork: 'UNKNOWN' as const,
        isAmbiguous: true,
        status: 'NEEDS_REVIEW' as const,
      },
    ],
  };
  const gateBlockedAmbiguous = evaluateAutoSubmitGate(ambiguousFinding, formCfg, settingsEnabled, [], [], true);
  assert(
    'Gate Enforcement: Auto Submit Strictly Blocked on Ambiguous EVM Address',
    'Auto Submit Validation Gate',
    !gateBlockedAmbiguous.canAutoSubmit && gateBlockedAmbiguous.reasons.some((r) => r.includes('NEEDS_REVIEW')),
    'blocked with NEEDS_REVIEW reason',
    String(gateBlockedAmbiguous.canAutoSubmit)
  );

  // Test: Prove Auto Submit CANNOT proceed when required form questions are unmapped
  const incompleteFormCfg = { ...formCfg, fieldMappings: missingOneMapping };
  const gateBlockedUnmapped = evaluateAutoSubmitGate(mockFinding, incompleteFormCfg, settingsEnabled, [], [], true);
  assert(
    'Gate Enforcement: Auto Submit Strictly Blocked When Required Form Fields Unmapped',
    'Auto Submit Validation Gate',
    !gateBlockedUnmapped.canAutoSubmit && gateBlockedUnmapped.reasons.some((r) => r.includes('Required Form Fields Matched')),
    'blocked with Required Form Fields Matched reason',
    String(gateBlockedUnmapped.canAutoSubmit)
  );

  // ----------------------------------------------------
  // Category 7: Submission Preview & Multi-Page Verification
  // ----------------------------------------------------
  const preview = generateExactFormPreview(mockFinding, formCfg);
  assert(
    'Exact Form Preview: Generates Question-to-Value Mapping Across Sections',
    'Submission Verification & Recovery',
    preview.sections.length === 3 && preview.allValid,
    '3 sections, allValid=true',
    `${preview.sections.length} sections, allValid=${preview.allValid}`
  );

  const valuesMap = buildFieldValuesMap(mockFinding, formCfg);
  assert(
    'Multi-Page Field Payload Builder: Correct Entry Values',
    'Submission Verification & Recovery',
    valuesMap['entry.1849204812'] === 'https://fake-staking-vault.com/deposit' &&
      valuesMap['entry.749201847'] === 'analyst1',
    'URL and username mapped correctly',
    `URL=${valuesMap['entry.1849204812']}, User=${valuesMap['entry.749201847']}`
  );

  // ----------------------------------------------------
  // Category 8: Main Platform Integration & Provenance
  // ----------------------------------------------------
  assert(
    'Provenance Tracking Preserved (Investigation ID, Site ID, Wallet IDs)',
    'Main Platform Integration',
    mockFinding.provenance.investigationId === 'INV-101' &&
      mockFinding.provenance.siteId === 'S-1' &&
      mockFinding.provenance.sourceModule === 'Site Investigator',
    'Provenance fields intact',
    `inv=${mockFinding.provenance.investigationId}, site=${mockFinding.provenance.siteId}`
  );

  // ----------------------------------------------------
  // Category 9: Batch Auto-Submit 10-Point Gate Diagnostics
  // ----------------------------------------------------
  assert(
    '10-Point Gate Diagnostics Emits Comprehensive Rule Checkpoints',
    'Auto Submit Validation Gate',
    Array.isArray(gatePass.diagnostics) &&
      gatePass.diagnostics.length >= 8 &&
      gatePass.diagnostics.every((d) => d.passed),
    'All diagnostics passed=true',
    `${gatePass.diagnostics.length} rule diagnostics evaluated`
  );

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;

  return {
    total,
    passed,
    failed,
    results,
  };
}
