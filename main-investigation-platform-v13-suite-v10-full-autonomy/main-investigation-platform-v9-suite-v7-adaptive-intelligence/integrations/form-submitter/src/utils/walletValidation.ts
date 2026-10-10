import { CryptoNetwork, ValidationStatus, WalletFinding, InvestigationFinding } from '../types';
import {
  verifyBase58Check,
  verifyEIP55,
  verifyBech32,
  verifySolanaAddress,
  verifyXrpAddress,
  decodeBase58,
} from './cryptoChecksums';

export interface WalletValidationResult {
  status: ValidationStatus;
  checksumValid: boolean | null;
  detectedNetworks: CryptoNetwork[];
  isAmbiguous: boolean;
  ambiguityReason?: string;
  notes: string[];
}

/**
 * Validates a single cryptocurrency wallet against its selected network
 * and detects possible alternative networks or format conflicts.
 */
export function validateWallet(
  rawAddress: string,
  selectedNetwork: CryptoNetwork,
  context?: { hasTokenContext?: boolean; userProvidedNetwork?: boolean; sourceEvidence?: string }
): WalletValidationResult {
  const address = (rawAddress || '').trim();
  const notes: string[] = [];
  const detectedNetworks: CryptoNetwork[] = [];

  if (!address) {
    return {
      status: 'BLOCKED',
      checksumValid: false,
      detectedNetworks: [],
      isAmbiguous: false,
      notes: ['Wallet address is blank or missing'],
    };
  }

  // 1. Detect candidate networks purely based on format and checksum
  const candidates = detectPossibleNetworks(address);
  detectedNetworks.push(...candidates);

  // 2. Ambiguity check: 0x addresses MUST NOT be blindly assumed without explicit context
  const isEvmFormat = /^0x[0-9a-fA-F]{40}$/.test(address);
  if (isEvmFormat) {
    const eip55 = verifyEIP55(address);

    // If the user selected UNKNOWN or didn't explicitly specify token/chain context
    if (selectedNetwork === 'UNKNOWN') {
      return {
        status: 'NEEDS_REVIEW',
        checksumValid: eip55.hasChecksum ? eip55.valid : null,
        detectedNetworks,
        isAmbiguous: true,
        ambiguityReason: '0x... address can represent Ethereum (ETH), USDT ERC20, BSC, USDT BEP20, Polygon, or Arbitrum. Network context required.',
        notes: [
          'Address conforms to 40-character EVM hexadecimal format',
          eip55.hasChecksum
            ? (eip55.valid ? 'EIP-55 mixed-case checksum is VALID' : 'WARNING: EIP-55 checksum capitalization mismatch')
            : 'Address is all lowercase/uppercase without embedded EIP-55 checksum',
          'Strict Policy: Never guess EVM network. Select the intended network/token.',
        ],
      };
    }

    // If EVM format, check if selected network is an EVM family network
    const isSelectedEvmFamily = ['ETH', 'USDT_ERC20', 'USDT_BEP20'].includes(selectedNetwork);
    if (!isSelectedEvmFamily) {
      return {
        status: 'BLOCKED',
        checksumValid: false,
        detectedNetworks,
        isAmbiguous: false,
        notes: [
          `Format Conflict: Address is an EVM 0x hex address, but selected network is ${selectedNetwork}.`,
          'Change selected network to Ethereum (ETH), USDT ERC20, or USDT BEP20.',
        ],
      };
    }

    // Check EIP-55 validity
    if (eip55.hasChecksum && !eip55.valid) {
      return {
        status: 'BLOCKED',
        checksumValid: false,
        detectedNetworks,
        isAmbiguous: false,
        notes: [
          'Cryptographic Checksum Error: EIP-55 capitalization checksum verification failed.',
          'Expected capitalization: ' + eip55.expectedChecksumAddress,
        ],
      };
    }

    // If valid EVM format, check if it's all lowercase and no explicit token context was provided
    if (!eip55.hasChecksum && !context?.hasTokenContext && selectedNetwork === 'ETH') {
      notes.push('Valid EVM hex format (no EIP-55 mixed-case checksum).');
      return {
        status: 'READY',
        checksumValid: null,
        detectedNetworks,
        isAmbiguous: false,
        notes,
      };
    }

    notes.push(eip55.hasChecksum ? 'EIP-55 mixed-case checksum verified' : 'Hexadecimal format valid');
    return {
      status: 'READY',
      checksumValid: eip55.hasChecksum ? true : null,
      detectedNetworks,
      isAmbiguous: false,
      notes,
    };
  }

  // 3. Network-specific validations
  switch (selectedNetwork) {
    case 'BTC': {
      // Legacy P2PKH (starts with 1)
      if (address.startsWith('1')) {
        const check = verifyBase58Check(address, [0x00]);
        if (!check.valid) {
          return {
            status: 'BLOCKED',
            checksumValid: false,
            detectedNetworks,
            isAmbiguous: false,
            notes: [`Bitcoin Legacy (P2PKH) checksum error: ${check.reason}`],
          };
        }
        return {
          status: 'READY',
          checksumValid: true,
          detectedNetworks,
          isAmbiguous: false,
          notes: ['Bitcoin Legacy P2PKH address: Base58Check double-SHA256 verified'],
        };
      }

      // P2SH (starts with 3)
      if (address.startsWith('3')) {
        const check = verifyBase58Check(address, [0x05]);
        if (!check.valid) {
          // Could also be Litecoin P2SH, let's inform
          return {
            status: 'BLOCKED',
            checksumValid: false,
            detectedNetworks,
            isAmbiguous: true,
            ambiguityReason: 'Addresses starting with 3 can be Bitcoin P2SH or Litecoin P2SH',
            notes: [`Bitcoin P2SH checksum error: ${check.reason}`],
          };
        }
        return {
          status: 'READY',
          checksumValid: true,
          detectedNetworks,
          isAmbiguous: true, // Addresses starting with 3 are shared with Litecoin legacy
          ambiguityReason: 'Starts with 3 (shared between Bitcoin P2SH and Litecoin P2SH)',
          notes: [
            'Bitcoin P2SH address: Base58Check double-SHA256 verified',
            'Note: Address format also matches Litecoin P2SH (version byte 0x05). Confirm website context.',
          ],
        };
      }

      // Native SegWit (bc1q...) or Taproot (bc1p...)
      if (address.toLowerCase().startsWith('bc1')) {
        const bech = verifyBech32(address, 'bc');
        if (!bech.valid) {
          return {
            status: 'BLOCKED',
            checksumValid: false,
            detectedNetworks,
            isAmbiguous: false,
            notes: [`Bitcoin SegWit/Taproot error: ${bech.reason}`],
          };
        }
        return {
          status: 'READY',
          checksumValid: true,
          detectedNetworks,
          isAmbiguous: false,
          notes: [
            bech.version === 'bech32m'
              ? 'Bitcoin Taproot (v1) address: Bech32m polymod checksum verified'
              : 'Bitcoin Native SegWit (v0) address: Bech32 polymod checksum verified',
          ],
        };
      }

      return {
        status: 'BLOCKED',
        checksumValid: false,
        detectedNetworks,
        isAmbiguous: false,
        notes: [
          'Invalid Bitcoin address format. Must start with 1 (Legacy), 3 (P2SH), or bc1 (SegWit/Taproot).',
        ],
      };
    }

    case 'ETH':
    case 'USDT_ERC20':
    case 'USDT_BEP20': {
      // Reaching here means isEvmFormat was false (e.g. Bitcoin, Tron, or other address selected as ETH)
      return {
        status: 'BLOCKED',
        checksumValid: false,
        detectedNetworks,
        isAmbiguous: false,
        notes: [
          `Network Conflict Guard: Address is not an EVM 0x address (detected candidate networks: ${detectedNetworks.join(', ') || 'none'}), but selected network is ${selectedNetwork}.`,
        ],
      };
    }

    case 'TRX':
    case 'USDT_TRC20': {
      if (!address.startsWith('T') || address.length !== 34) {
        return {
          status: 'BLOCKED',
          checksumValid: false,
          detectedNetworks,
          isAmbiguous: false,
          notes: ['TRON / USDT TRC20 address must start with "T" and be exactly 34 characters'],
        };
      }
      // TRON version byte is 0x41
      const check = verifyBase58Check(address, [0x41]);
      if (!check.valid) {
        return {
          status: 'BLOCKED',
          checksumValid: false,
          detectedNetworks,
          isAmbiguous: false,
          notes: [`TRON Base58Check error: ${check.reason}`],
        };
      }

      const isUsdtSelected = selectedNetwork === 'USDT_TRC20';
      return {
        status: 'READY',
        checksumValid: true,
        detectedNetworks,
        isAmbiguous: false,
        notes: [
          `TRON Base58Check double-SHA256 verified (prefix 0x41).`,
          isUsdtSelected
            ? 'USDT TRC20 token contract deposit target verified'
            : 'Native TRON (TRX) deposit target verified',
        ],
      };
    }

    case 'SOL': {
      const sol = verifySolanaAddress(address);
      if (!sol.valid) {
        return {
          status: 'BLOCKED',
          checksumValid: false,
          detectedNetworks,
          isAmbiguous: false,
          notes: [`Solana address error: ${sol.reason}`],
        };
      }
      return {
        status: 'READY',
        checksumValid: true,
        detectedNetworks,
        isAmbiguous: false,
        notes: ['Solana Base58 Ed25519 32-byte public key verified'],
      };
    }

    case 'XRP': {
      const xrp = verifyXrpAddress(address);
      if (!xrp.valid) {
        return {
          status: 'BLOCKED',
          checksumValid: false,
          detectedNetworks,
          isAmbiguous: false,
          notes: [`XRP address error: ${xrp.reason}`],
        };
      }
      return {
        status: 'READY',
        checksumValid: true,
        detectedNetworks,
        isAmbiguous: false,
        notes: ['XRP Base58 double-SHA256 checksum verified'],
      };
    }

    case 'LTC': {
      // Starts with L (P2PKH, 0x30), M (P2SH, 0x32), 3 (legacy P2SH, 0x05), or ltc1 (Bech32)
      if (address.startsWith('L')) {
        const check = verifyBase58Check(address, [0x30]);
        if (!check.valid) {
          return { status: 'BLOCKED', checksumValid: false, detectedNetworks, isAmbiguous: false, notes: [`Litecoin Legacy error: ${check.reason}`] };
        }
        return { status: 'READY', checksumValid: true, detectedNetworks, isAmbiguous: false, notes: ['Litecoin P2PKH Base58Check verified'] };
      }
      if (address.startsWith('M')) {
        const check = verifyBase58Check(address, [0x32]);
        if (!check.valid) {
          return { status: 'BLOCKED', checksumValid: false, detectedNetworks, isAmbiguous: false, notes: [`Litecoin P2SH error: ${check.reason}`] };
        }
        return { status: 'READY', checksumValid: true, detectedNetworks, isAmbiguous: false, notes: ['Litecoin P2SH (M-prefix) Base58Check verified'] };
      }
      if (address.toLowerCase().startsWith('ltc1')) {
        const bech = verifyBech32(address, 'ltc');
        if (!bech.valid) {
          return { status: 'BLOCKED', checksumValid: false, detectedNetworks, isAmbiguous: false, notes: [`Litecoin SegWit error: ${bech.reason}`] };
        }
        return { status: 'READY', checksumValid: true, detectedNetworks, isAmbiguous: false, notes: ['Litecoin Native SegWit Bech32 polymod verified'] };
      }
      if (address.startsWith('3')) {
        const check = verifyBase58Check(address, [0x05]);
        return {
          status: check.valid ? 'NEEDS_REVIEW' : 'BLOCKED',
          checksumValid: check.valid,
          detectedNetworks,
          isAmbiguous: true,
          ambiguityReason: 'Addresses starting with 3 are shared with Bitcoin P2SH. Confirm with screenshot evidence.',
          notes: [check.valid ? 'Base58Check valid, but prefix "3" is ambiguous with Bitcoin' : `Checksum error: ${check.reason}`],
        };
      }
      return {
        status: 'BLOCKED',
        checksumValid: false,
        detectedNetworks,
        isAmbiguous: false,
        notes: ['Invalid Litecoin address format. Expected L..., M..., or ltc1...'],
      };
    }

    case 'DOGE': {
      // Starts with D (0x1e), 9 (0x16), or A (0x16)
      if (!/^[D9A][1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
        return {
          status: 'BLOCKED',
          checksumValid: false,
          detectedNetworks,
          isAmbiguous: false,
          notes: ['Dogecoin address must start with D, 9, or A and be 34 Base58 characters'],
        };
      }
      const check = verifyBase58Check(address, [0x1e, 0x16]);
      if (!check.valid) {
        return {
          status: 'BLOCKED',
          checksumValid: false,
          detectedNetworks,
          isAmbiguous: false,
          notes: [`Dogecoin Base58Check error: ${check.reason}`],
        };
      }
      return {
        status: 'READY',
        checksumValid: true,
        detectedNetworks,
        isAmbiguous: false,
        notes: ['Dogecoin Base58Check verified'],
      };
    }

    case 'ADA': {
      if (address.startsWith('addr1')) {
        const bech = verifyBech32(address, 'addr');
        if (!bech.valid) {
          return { status: 'BLOCKED', checksumValid: false, detectedNetworks, isAmbiguous: false, notes: [`Cardano error: ${bech.reason}`] };
        }
        return { status: 'READY', checksumValid: true, detectedNetworks, isAmbiguous: false, notes: ['Cardano Shelley addr1 Bech32 verified'] };
      }
      return { status: 'BLOCKED', checksumValid: false, detectedNetworks, isAmbiguous: false, notes: ['Expected Cardano Shelley format (addr1...)'] };
    }

    case 'XMR': {
      if (!/^[48][0-9ABa-b][1-9A-HJ-NP-Za-km-z]{93}$/.test(address) && !/^[48][0-9ABa-b][1-9A-HJ-NP-Za-km-z]{104}$/.test(address)) {
        return { status: 'BLOCKED', checksumValid: false, detectedNetworks, isAmbiguous: false, notes: ['Monero address must start with 4 or 8 and be 95 or 106 Base58 characters'] };
      }
      return { status: 'READY', checksumValid: true, detectedNetworks, isAmbiguous: false, notes: ['Monero base58 format verified'] };
    }

    case 'UNKNOWN':
    default: {
      return {
        status: 'NEEDS_REVIEW',
        checksumValid: null,
        detectedNetworks,
        isAmbiguous: true,
        ambiguityReason: detectedNetworks.length > 0 ? `Unassigned network. Address matches: ${detectedNetworks.join(', ')}` : 'Unknown address format',
        notes: ['Please select an authorized network from the dropdown list.'],
      };
    }
  }
}

/**
 * Heuristically detects possible networks for an address string.
 */
export function detectPossibleNetworks(address: string): CryptoNetwork[] {
  const clean = (address || '').trim();
  const list: CryptoNetwork[] = [];

  if (/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    list.push('ETH', 'USDT_ERC20', 'USDT_BEP20');
  }

  if (clean.startsWith('1') && verifyBase58Check(clean, [0x00]).valid) {
    list.push('BTC');
  }

  if (clean.startsWith('3') && verifyBase58Check(clean, [0x05]).valid) {
    list.push('BTC', 'LTC');
  }

  if (clean.toLowerCase().startsWith('bc1') && verifyBech32(clean, 'bc').valid) {
    list.push('BTC');
  }

  if (clean.startsWith('T') && clean.length === 34 && verifyBase58Check(clean, [0x41]).valid) {
    list.push('TRX', 'USDT_TRC20');
  }

  if (clean.length >= 32 && clean.length <= 44 && verifySolanaAddress(clean).valid) {
    list.push('SOL');
  }

  if (clean.startsWith('r') && verifyXrpAddress(clean).valid) {
    list.push('XRP');
  }

  if ((clean.startsWith('L') || clean.startsWith('M') || clean.toLowerCase().startsWith('ltc1'))) {
    list.push('LTC');
  }

  if (/^[D9A][1-9A-HJ-NP-Za-km-z]{33}$/.test(clean) && verifyBase58Check(clean, [0x1e, 0x16]).valid) {
    list.push('DOGE');
  }

  if (clean.startsWith('addr1') && verifyBech32(clean, 'addr').valid) {
    list.push('ADA');
  }

  if (/^[48][0-9ABa-b][1-9A-HJ-NP-Za-km-z]{93,104}$/.test(clean)) {
    list.push('XMR');
  }

  return Array.from(new Set(list));
}

/**
 * Normalizes and validates a scam website URL.
 * Detects malformed URLs, localhost, private IP ranges, missing domain, or protocol errors.
 */
export function validateScamUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl: string;
  domain: string;
  issues: string[];
} {
  const issues: string[] = [];
  let input = (rawUrl || '').trim();

  if (!input) {
    return { valid: false, normalizedUrl: '', domain: '', issues: ['Website URL is empty'] };
  }

  // Prepend https:// if no protocol provided
  if (!/^https?:\/\//i.test(input)) {
    input = 'https://' + input;
  }

  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.toLowerCase();

    if (!hostname) {
      issues.push('Could not determine a valid hostname');
      return { valid: false, normalizedUrl: input, domain: '', issues };
    }

    // Check for localhost or private IPs
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      /^192\.168\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      issues.push('Invalid target: Localhost and private intranet IP addresses are not external scam websites');
      return { valid: false, normalizedUrl: input, domain: hostname, issues };
    }

    // Check for valid TLD dot
    if (!hostname.includes('.') && !/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname)) {
      issues.push('Target domain is missing a top-level domain extension (e.g. .com, .top, .vip)');
      return { valid: false, normalizedUrl: input, domain: hostname, issues };
    }

    return {
      valid: true,
      normalizedUrl: parsed.origin + parsed.pathname + (parsed.search || ''),
      domain: hostname,
      issues: [],
    };
  } catch (err: unknown) {
    issues.push(`Malformed URL syntax: ${err instanceof Error ? err.message : 'Failed to parse URL'}`);
    return { valid: false, normalizedUrl: input, domain: '', issues };
  }
}

/**
 * Evaluates an entire finding against all rules:
 * - URL validation
 * - At least one wallet
 * - Each wallet's validation
 * - Duplicate wallet check inside finding
 * - Username & Team Invite Code presence
 * - Overall status: READY | NEEDS_REVIEW | BLOCKED
 */
export function evaluateFinding(
  finding: InvestigationFinding,
  existingQueue: InvestigationFinding[] = []
): {
  overallStatus: ValidationStatus;
  diagnostics: { rule: string; passed: boolean; status: ValidationStatus; message: string }[];
  updatedWallets: WalletFinding[];
} {
  const diagnostics: { rule: string; passed: boolean; status: ValidationStatus; message: string }[] = [];
  let finalStatus: ValidationStatus = 'READY';

  // Rule 1: Website URL
  const urlCheck = validateScamUrl(finding.siteUrl);
  if (!urlCheck.valid) {
    finalStatus = 'BLOCKED';
    diagnostics.push({
      rule: 'Website URL Format',
      passed: false,
      status: 'BLOCKED',
      message: `Invalid scam website URL: ${urlCheck.issues.join(', ')}`,
    });
  } else {
    diagnostics.push({
      rule: 'Website URL Format',
      passed: true,
      status: 'READY',
      message: `Valid target domain: ${urlCheck.domain}`,
    });
  }

  // Rule 2: Duplicate Website in queue
  const duplicateSite = existingQueue.find(
    (f) => f.id !== finding.id && f.domain && urlCheck.domain && f.domain.toLowerCase() === urlCheck.domain.toLowerCase()
  );
  if (duplicateSite) {
    diagnostics.push({
      rule: 'Duplicate Website Detection',
      passed: false,
      status: 'NEEDS_REVIEW',
      message: `Website "${urlCheck.domain}" is already present in this queue (Finding ID: ${duplicateSite.id})`,
    });
    if (finalStatus === 'READY') {
      finalStatus = 'NEEDS_REVIEW';
    }
  }

  // Rule 3: Wallets presence
  if (!finding.wallets || finding.wallets.length === 0) {
    finalStatus = 'BLOCKED';
    diagnostics.push({
      rule: 'Cryptocurrency Deposit Wallets',
      passed: false,
      status: 'BLOCKED',
      message: 'At least one cryptocurrency deposit wallet address is required for reporting',
    });
  }

  // Rule 4: Validate each wallet & check internal duplicates
  const seenAddresses = new Set<string>();
  const updatedWallets: WalletFinding[] = (finding.wallets || []).map((w, idx) => {
    const val = validateWallet(w.address, w.selectedNetwork, {
      hasTokenContext: w.selectedNetwork !== 'UNKNOWN',
      sourceEvidence: finding.notes,
    });

    const isInternalDuplicate = seenAddresses.has(w.address.toLowerCase());
    seenAddresses.add(w.address.toLowerCase());

    const walletNotes = [...val.notes];
    let walletStatus = val.status;

    if (isInternalDuplicate) {
      walletStatus = 'BLOCKED';
      walletNotes.unshift('Duplicate wallet address detected within this finding');
    }

    // Check cross-queue wallet duplicate
    const crossQueueDuplicate = existingQueue.find(
      (f) => f.id !== finding.id && f.wallets.some((other) => other.address.toLowerCase() === w.address.toLowerCase())
    );
    if (crossQueueDuplicate) {
      walletNotes.push(`Warning: Wallet was also logged in Finding ID: ${crossQueueDuplicate.id}`);
      if (walletStatus === 'READY') {
        walletStatus = 'NEEDS_REVIEW';
      }
    }

    // Update overall finding status based on wallet status
    if (walletStatus === 'BLOCKED') {
      finalStatus = 'BLOCKED';
    } else if (walletStatus === 'NEEDS_REVIEW' && finalStatus !== 'BLOCKED') {
      finalStatus = 'NEEDS_REVIEW';
    }

    return {
      ...w,
      status: walletStatus,
      checksumValid: val.checksumValid,
      isAmbiguous: val.isAmbiguous,
      ambiguityReason: val.ambiguityReason,
      detectedNetworks: val.detectedNetworks,
      validationNotes: walletNotes,
    };
  });

  // Diagnostics summary for wallets
  const blockedWallets = updatedWallets.filter((w) => w.status === 'BLOCKED');
  const reviewWallets = updatedWallets.filter((w) => w.status === 'NEEDS_REVIEW');
  const readyWallets = updatedWallets.filter((w) => w.status === 'READY');

  if (blockedWallets.length > 0) {
    diagnostics.push({
      rule: 'Wallet Integrity & Checksum',
      passed: false,
      status: 'BLOCKED',
      message: `${blockedWallets.length} wallet(s) have invalid format or failed cryptographic checksum`,
    });
  } else if (reviewWallets.length > 0) {
    diagnostics.push({
      rule: 'Wallet Ambiguity / Review Required',
      passed: false,
      status: 'NEEDS_REVIEW',
      message: `${reviewWallets.length} wallet(s) marked NEEDS REVIEW due to ambiguous network or shared prefix`,
    });
  } else if (readyWallets.length > 0) {
    diagnostics.push({
      rule: 'Wallet Cryptographic Verification',
      passed: true,
      status: 'READY',
      message: `All ${readyWallets.length} wallet(s) passed checksum and network validation`,
    });
  }

  // Rule 5: User & Team Credentials
  if (!finding.username || !finding.username.trim()) {
    finalStatus = 'BLOCKED';
    diagnostics.push({
      rule: 'Investigator Username',
      passed: false,
      status: 'BLOCKED',
      message: 'Investigator Username is required. Configure in Settings or initial setup.',
    });
  } else {
    diagnostics.push({
      rule: 'Investigator Username',
      passed: true,
      status: 'READY',
      message: `Investigator assigned: ${finding.username}`,
    });
  }

  if (!finding.teamInviteCode || !finding.teamInviteCode.trim()) {
    finalStatus = 'BLOCKED';
    diagnostics.push({
      rule: 'Team Invite Code',
      passed: false,
      status: 'BLOCKED',
      message: 'Team Invite Code is required for authorized submission.',
    });
  } else {
    diagnostics.push({
      rule: 'Team Invite Code',
      passed: true,
      status: 'READY',
      message: 'Team Invite Code attached',
    });
  }

  return {
    overallStatus: finalStatus,
    diagnostics,
    updatedWallets,
  };
}
