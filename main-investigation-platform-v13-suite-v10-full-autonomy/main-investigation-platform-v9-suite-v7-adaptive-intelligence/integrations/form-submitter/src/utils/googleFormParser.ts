import {
  FormQuestion,
  FormSection,
  ParsedFormSchema,
  FormQuestionType,
  FormFieldMapping,
} from '../types';
import { sha256Hex } from './cryptoChecksums';
import { extractGoogleFormId } from './formMapping';

/**
 * Maps Google Form internal question type IDs to standard schema types
 */
function mapQuestionType(typeCode: number): FormQuestionType {
  switch (typeCode) {
    case 0:
      return 'SHORT_ANSWER';
    case 1:
      return 'PARAGRAPH';
    case 2:
      return 'MULTIPLE_CHOICE';
    case 3:
      return 'DROPDOWN';
    case 4:
      return 'CHECKBOXES';
    case 5:
      return 'SCALE';
    case 7:
      return 'PAGE_BREAK';
    case 8:
      return 'PAGE_BREAK';
    case 9:
      return 'DATE';
    case 10:
      return 'TIME';
    default:
      return 'SHORT_ANSWER';
  }
}

/**
 * Standard Default Authorized Defensive Investigation Form Schema
 * Used as reliable fallback and baseline structure for testing and offline operation
 */
export const DEFAULT_AUTHORIZED_FORM_SCHEMA: ParsedFormSchema = {
  formId: '1FAIpQLScamReportIntake2026DefensiveV1',
  formTitle: 'Official Crypto Scam & Phishing Report Form',
  formUrl: 'https://docs.google.com/forms/d/e/1FAIpQLScamReportIntake2026DefensiveV1/viewform',
  versionHash: '', // computed below
  parsedAt: new Date().toISOString(),
  rawInspectionSource: 'FALLBACK_SCHEMA',
  sections: [
    {
      pageIndex: 1,
      title: 'Section 1: Target Scam Website & Domain',
      description: 'Document the verified scam domain or URL hosting illicit deposit addresses',
      questions: [
        {
          id: 'q-site-url',
          entryKey: 'entry.1849204812',
          title: 'Scam Website URL / Domain',
          description: 'Full URL or domain name of the fraudulent website',
          type: 'SHORT_ANSWER',
          required: true,
          pageIndex: 1,
        },
        {
          id: 'q-site-category',
          entryKey: 'entry.1492019401',
          title: 'Scam Category',
          description: 'Type of scam lure or phishing mechanism',
          type: 'DROPDOWN',
          required: true,
          choices: [
            'Fake Crypto Staking / Yield Vault',
            'Phishing Airdrop Drainer',
            'Impersonation Exchange',
            'Fake Cloud Mining',
            'Pig Butchering / Romance Fraud',
            'Other Cryptocurrency Scam',
          ],
          pageIndex: 1,
        },
      ],
    },
    {
      pageIndex: 2,
      title: 'Section 2: Cryptocurrency Deposit Wallets',
      description: 'List public deposit addresses collected from account modals or payment screens',
      questions: [
        {
          id: 'q-wallets-list',
          entryKey: 'entry.928471029',
          title: 'Cryptocurrency Deposit Wallets',
          description: 'Numbered list of deposit wallets with verified network tags and checksums',
          type: 'PARAGRAPH',
          required: true,
          pageIndex: 2,
        },
        {
          id: 'q-primary-wallet',
          entryKey: 'entry.394820194',
          title: 'Primary Deposit Wallet Address',
          description: 'Primary or highest priority deposit address',
          type: 'SHORT_ANSWER',
          required: true,
          pageIndex: 2,
        },
        {
          id: 'q-primary-network',
          entryKey: 'entry.582910482',
          title: 'Primary Blockchain Network',
          description: 'Token or blockchain network of the primary wallet',
          type: 'DROPDOWN',
          required: true,
          choices: ['BTC', 'ETH', 'USDT_ERC20', 'USDT_TRC20', 'USDT_BEP20', 'TRX', 'SOL', 'XRP', 'LTC', 'DOGE', 'Other'],
          pageIndex: 2,
        },
      ],
    },
    {
      pageIndex: 3,
      title: 'Section 3: Investigator Identification & Evidence',
      description: 'Accountability attribution and supporting evidence',
      questions: [
        {
          id: 'q-username',
          entryKey: 'entry.749201847',
          title: 'Investigator Username',
          description: 'Your authorized handle within the defensive investigation coalition',
          type: 'SHORT_ANSWER',
          required: true,
          pageIndex: 3,
        },
        {
          id: 'q-team-code',
          entryKey: 'entry.628491038',
          title: 'Team Invite Code',
          description: 'Unit authorization code',
          type: 'SHORT_ANSWER',
          required: true,
          pageIndex: 3,
        },
        {
          id: 'q-evidence-notes',
          entryKey: 'entry.482019482',
          title: 'Supporting Evidence & Notes',
          description: 'Investigation details, deposit flow, and contextual indicators',
          type: 'PARAGRAPH',
          required: false,
          pageIndex: 3,
        },
        {
          id: 'q-investigation-id',
          entryKey: 'entry.102938475',
          title: 'Investigation Provenance ID',
          description: 'Main Platform reference tracking number',
          type: 'SHORT_ANSWER',
          required: false,
          pageIndex: 3,
        },
      ],
    },
  ],
  allQuestions: [],
};

// Flatten all questions and compute versionHash
DEFAULT_AUTHORIZED_FORM_SCHEMA.allQuestions = DEFAULT_AUTHORIZED_FORM_SCHEMA.sections.flatMap(
  (s) => s.questions
);
DEFAULT_AUTHORIZED_FORM_SCHEMA.versionHash = computeFormVersionHash(
  DEFAULT_AUTHORIZED_FORM_SCHEMA.formId,
  DEFAULT_AUTHORIZED_FORM_SCHEMA.allQuestions
);

/**
 * Computes a deterministic SHA-256 fingerprint hash of all form questions and required rules.
 * If questions, required flags, or entry keys change in Google Forms, this hash will change.
 */
export function computeFormVersionHash(formId: string, questions: FormQuestion[]): string {
  const normalized = questions
    .slice()
    .sort((a, b) => a.entryKey.localeCompare(b.entryKey))
    .map((q) => `${q.entryKey}:${q.title.trim()}:${q.required ? 'REQ' : 'OPT'}:${q.type}:${q.pageIndex}`)
    .join('||');

  return sha256Hex(`${formId}@@${normalized}`).slice(0, 16);
}

/**
 * Parses Google Form HTML and extracts the raw `FB_PUBLIC_LOAD_DATA_` JavaScript payload
 */
export function parseGoogleFormHtml(html: string, formUrl: string): ParsedFormSchema {
  const formId = extractGoogleFormId(formUrl) || 'google-form-detected';

  // Try extracting the FB_PUBLIC_LOAD_DATA_ embedded script variable
  const match = html.match(/var\s+FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.+?\]);\s*<\/script>/s) ||
                html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.+?\]);/s);

  if (!match || !match[1]) {
    // If form HTML does not have public load data (or is blocked), return standard schema with formId
    const fallback = JSON.parse(JSON.stringify(DEFAULT_AUTHORIZED_FORM_SCHEMA)) as ParsedFormSchema;
    fallback.formId = formId;
    fallback.formUrl = formUrl;
    fallback.versionHash = computeFormVersionHash(formId, fallback.allQuestions);
    return fallback;
  }

  try {
    const rawData = JSON.parse(match[1]);
    const formTitle = rawData[1]?.[8] || rawData[1]?.[0] || 'Authorized Crypto Scam Report Form';
    const rawItems = rawData[1]?.[1] || [];

    const allQuestions: FormQuestion[] = [];
    const sections: FormSection[] = [];
    let currentPageIndex = 1;
    let currentSectionTitle = 'Section 1';
    let currentSectionDesc = '';
    let currentQuestions: FormQuestion[] = [];

    for (const item of rawItems) {
      const itemTitle = item[1] || '';
      const itemDesc = item[2] || '';
      const itemType = item[3];

      // Type 7 or 8 represents Section Header / Page Break in Google Forms
      if (itemType === 7 || itemType === 8) {
        if (currentQuestions.length > 0 || currentPageIndex === 1) {
          sections.push({
            pageIndex: currentPageIndex,
            title: currentSectionTitle,
            description: currentSectionDesc,
            questions: currentQuestions,
          });
        }
        currentPageIndex++;
        currentSectionTitle = itemTitle || `Section ${currentPageIndex}`;
        currentSectionDesc = itemDesc || '';
        currentQuestions = [];
        continue;
      }

      // Check for question entry ID
      const questionPayload = item[4]?.[0];
      if (questionPayload && questionPayload[0]) {
        const entryIdNum = questionPayload[0];
        const entryKey = `entry.${entryIdNum}`;
        const isRequired = questionPayload[2] === 1;
        const rawChoices = questionPayload[1];
        const choices = Array.isArray(rawChoices)
          ? rawChoices.map((c: unknown) => (Array.isArray(c) ? String(c[0]) : String(c)))
          : undefined;

        const q: FormQuestion = {
          id: `q-${entryIdNum}`,
          entryKey,
          title: itemTitle,
          description: itemDesc,
          type: mapQuestionType(itemType),
          required: isRequired,
          choices,
          pageIndex: currentPageIndex,
        };

        allQuestions.push(q);
        currentQuestions.push(q);
      }
    }

    // Push the final section
    if (currentQuestions.length > 0 || sections.length === 0) {
      sections.push({
        pageIndex: currentPageIndex,
        title: currentSectionTitle,
        description: currentSectionDesc,
        questions: currentQuestions,
      });
    }

    const versionHash = computeFormVersionHash(formId, allQuestions);

    return {
      formId,
      formTitle,
      formUrl,
      versionHash,
      sections,
      allQuestions,
      parsedAt: new Date().toISOString(),
      rawInspectionSource: 'GOOGLE_HTML_SCRAPE',
    };
  } catch (err) {
    console.error('Failed to parse FB_PUBLIC_LOAD_DATA_, using template:', err);
    const fallback = JSON.parse(JSON.stringify(DEFAULT_AUTHORIZED_FORM_SCHEMA)) as ParsedFormSchema;
    fallback.formId = formId;
    fallback.formUrl = formUrl;
    fallback.versionHash = computeFormVersionHash(formId, fallback.allQuestions);
    return fallback;
  }
}

/**
 * Inspects field mappings against the current form questions to determine:
 * 1. Required Form Fields Matched: X/X
 * 2. Unmapped required fields
 * 3. Changed or missing form questions
 */
export function evaluateFormMappings(
  schema: ParsedFormSchema,
  mappings: FormFieldMapping[]
): {
  matchedCount: number;
  totalRequiredCount: number;
  unmappedRequiredQuestions: FormQuestion[];
  isFullyMatched: boolean;
  missingOrChangedQuestions: string[];
} {
  const requiredQuestions = schema.allQuestions.filter((q) => q.required);
  const totalRequiredCount = requiredQuestions.length;

  const mappedEntryKeys = new Set(
    mappings.filter((m) => m.entryKey && m.entryKey.trim()).map((m) => m.entryKey.trim())
  );

  const unmappedRequiredQuestions: FormQuestion[] = [];
  let matchedCount = 0;

  for (const rq of requiredQuestions) {
    if (mappedEntryKeys.has(rq.entryKey)) {
      matchedCount++;
    } else {
      unmappedRequiredQuestions.push(rq);
    }
  }

  // Check if any mapping references an entry key that no longer exists in the form schema
  const existingFormEntryKeys = new Set(schema.allQuestions.map((q) => q.entryKey));
  const missingOrChangedQuestions: string[] = [];

  for (const m of mappings) {
    if (m.entryKey && !existingFormEntryKeys.has(m.entryKey)) {
      missingOrChangedQuestions.push(`Field '${m.label}' points to entry key ${m.entryKey} which is missing in the current form structure.`);
    }
  }

  return {
    matchedCount,
    totalRequiredCount,
    unmappedRequiredQuestions,
    isFullyMatched: matchedCount >= totalRequiredCount && missingOrChangedQuestions.length === 0,
    missingOrChangedQuestions,
  };
}

/**
 * Fetches and inspects Google Form structure via server inspection proxy, with offline fallback
 */
export async function inspectGoogleFormOnline(formUrl: string): Promise<ParsedFormSchema> {
  try {
    const res = await fetch(`/api/forms/inspect?url=${encodeURIComponent(formUrl)}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.allQuestions && data.allQuestions.length > 0) {
        return data as ParsedFormSchema;
      }
    }
  } catch (err) {
    console.warn('Online form inspection proxy failed, falling back to local extractor:', err);
  }

  // Fallback: Use standard authorized form schema tailored to this form URL
  const formId = extractGoogleFormId(formUrl) || '1FAIpQLScamReportIntake2026DefensiveV1';
  const schema = JSON.parse(JSON.stringify(DEFAULT_AUTHORIZED_FORM_SCHEMA)) as ParsedFormSchema;
  schema.formId = formId;
  schema.formUrl = formUrl;
  schema.versionHash = computeFormVersionHash(formId, schema.allQuestions);
  return schema;
}

/**
 * Intelligent Auto-Mapper: Matches investigation fields to newly parsed Google Form questions
 * based on semantic keywords in question titles.
 */
export function autoSuggestFieldMappings(
  questionsOrSchema: FormQuestion[] | ParsedFormSchema
): FormFieldMapping[] {
  const questions = Array.isArray(questionsOrSchema)
    ? questionsOrSchema
    : questionsOrSchema.allQuestions || [];

  const result: FormFieldMapping[] = [];

  const KEYWORD_RULES: {
    fieldKey: FormFieldMapping['fieldKey'];
    label: string;
    keywords: string[];
    priority: number;
  }[] = [
    {
      fieldKey: 'siteUrl',
      label: 'Scam Website URL',
      keywords: ['website', 'url', 'domain', 'link', 'site', 'target'],
      priority: 10,
    },
    {
      fieldKey: 'walletsList',
      label: 'Cryptocurrency Deposit Wallets',
      keywords: ['wallets', 'addresses', 'deposit wallets', 'crypto wallets', 'crypto deposit'],
      priority: 9,
    },
    {
      fieldKey: 'primaryWallet',
      label: 'Primary Wallet Address',
      keywords: ['primary wallet', 'primary address', 'single wallet', 'main wallet'],
      priority: 8,
    },
    {
      fieldKey: 'primaryNetwork',
      label: 'Primary Network / Token',
      keywords: ['network', 'blockchain', 'token', 'chain', 'crypto network', 'currency'],
      priority: 8,
    },
    {
      fieldKey: 'username',
      label: 'Investigator Username',
      keywords: ['username', 'investigator', 'reporter', 'analyst', 'name', 'handle'],
      priority: 7,
    },
    {
      fieldKey: 'teamInviteCode',
      label: 'Team Invite Code',
      keywords: ['invite code', 'team code', 'team', 'unit code', 'organization code', 'auth code'],
      priority: 7,
    },
    {
      fieldKey: 'evidenceNotes',
      label: 'Evidence & Notes',
      keywords: ['evidence', 'notes', 'details', 'description', 'context', 'comments'],
      priority: 6,
    },
    {
      fieldKey: 'investigationId',
      label: 'Investigation Provenance ID',
      keywords: ['investigation id', 'case id', 'reference id', 'tracking id', 'case number'],
      priority: 5,
    },
  ];

  const matchedEntryKeys = new Set<string>();

  for (const rule of KEYWORD_RULES) {
    let bestQuestion: FormQuestion | null = null;
    let highestScore = 0;

    for (const q of questions) {
      if (matchedEntryKeys.has(q.entryKey)) continue;

      const titleLower = q.title.toLowerCase();
      let score = 0;

      for (const kw of rule.keywords) {
        if (titleLower.includes(kw)) {
          score += kw.length;
        }
      }

      if (score > highestScore) {
        highestScore = score;
        bestQuestion = q;
      }
    }

    if (bestQuestion) {
      matchedEntryKeys.add(bestQuestion.entryKey);
      result.push({
        id: `map-${rule.fieldKey}`,
        fieldKey: rule.fieldKey,
        label: rule.label,
        entryKey: bestQuestion.entryKey,
        pageIndex: bestQuestion.pageIndex,
        required: bestQuestion.required,
        notes: `Mapped to "${bestQuestion.title}"`,
        matchedQuestionTitle: bestQuestion.title,
      });
    }
  }

  return result;
}
