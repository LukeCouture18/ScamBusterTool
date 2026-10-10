import crypto from 'crypto';

export interface InspectedQuestion {
  id: string;
  entryKey: string;
  title: string;
  description: string;
  type: string;
  required: boolean;
  choices?: string[];
  pageIndex: number;
}

export interface InspectedSection {
  pageIndex: number;
  title: string;
  description: string;
  questions: InspectedQuestion[];
}

export interface InspectedFormSchema {
  formId: string;
  formTitle: string;
  formUrl: string;
  versionHash: string;
  sections: InspectedSection[];
  allQuestions: InspectedQuestion[];
  parsedAt: string;
  source: 'ONLINE_FETCH' | 'TEMPLATE_FALLBACK';
}

export function extractFormIdFromUrl(url: string): string {
  if (!url) return '';
  const match = url.match(/\/forms\/d\/e\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) return match[1];
  const directMatch = url.match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
  if (directMatch && directMatch[1]) return directMatch[1];
  return '1FAIpQLScamReportIntake2026DefensiveV1';
}

function computeVersionHash(formId: string, questions: InspectedQuestion[]): string {
  const normalized = questions
    .slice()
    .sort((a, b) => a.entryKey.localeCompare(b.entryKey))
    .map((q) => `${q.entryKey}:${q.title.trim()}:${q.required ? 'REQ' : 'OPT'}:${q.type}:${q.pageIndex}`)
    .join('||');

  return crypto
    .createHash('sha256')
    .update(`${formId}@@${normalized}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Standard authorized defensive form schema used as reliable fallback
 */
export function getStandardFallbackSchema(formUrl: string): InspectedFormSchema {
  const formId = extractFormIdFromUrl(formUrl);
  const sections: InspectedSection[] = [
    {
      pageIndex: 1,
      title: 'Section 1: Target Scam Website & Domain',
      description: 'Document the verified scam domain hosting illicit cryptocurrency deposit addresses',
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
      description: 'Public deposit addresses collected from account modals or payment screens',
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
  ];

  const allQuestions = sections.flatMap((s) => s.questions);
  const versionHash = computeVersionHash(formId, allQuestions);

  return {
    formId,
    formTitle: 'Official Crypto Scam & Phishing Report Form',
    formUrl,
    versionHash,
    sections,
    allQuestions,
    parsedAt: new Date().toISOString(),
    source: 'TEMPLATE_FALLBACK',
  };
}

/**
 * Inspects a real Google Form by fetching its public HTML and extracting FB_PUBLIC_LOAD_DATA_
 */
export async function inspectGoogleForm(formUrl: string): Promise<InspectedFormSchema> {
  const formId = extractFormIdFromUrl(formUrl);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(formUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[GoogleFormService] Fetch returned ${res.status}, returning template fallback schema`);
      return getStandardFallbackSchema(formUrl);
    }

    const html = await res.text();
    const match =
      html.match(/var\s+FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.+?\]);\s*<\/script>/s) ||
      html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[.+?\]);/s);

    if (!match || !match[1]) {
      return getStandardFallbackSchema(formUrl);
    }

    const rawData = JSON.parse(match[1]);
    const formTitle = rawData[1]?.[8] || rawData[1]?.[0] || 'Authorized Crypto Scam Report Form';
    const rawItems = rawData[1]?.[1] || [];

    const allQuestions: InspectedQuestion[] = [];
    const sections: InspectedSection[] = [];
    let currentPageIndex = 1;
    let currentSectionTitle = 'Section 1';
    let currentSectionDesc = '';
    let currentQuestions: InspectedQuestion[] = [];

    for (const item of rawItems) {
      const itemTitle = item[1] || '';
      const itemDesc = item[2] || '';
      const itemType = item[3];

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

      const questionPayload = item[4]?.[0];
      if (questionPayload && questionPayload[0]) {
        const entryIdNum = questionPayload[0];
        const entryKey = `entry.${entryIdNum}`;
        const isRequired = questionPayload[2] === 1;
        const rawChoices = questionPayload[1];
        const choices = Array.isArray(rawChoices)
          ? rawChoices.map((c: unknown) => (Array.isArray(c) ? String(c[0]) : String(c)))
          : undefined;

        let typeStr = 'SHORT_ANSWER';
        if (itemType === 1) typeStr = 'PARAGRAPH';
        else if (itemType === 2) typeStr = 'MULTIPLE_CHOICE';
        else if (itemType === 3) typeStr = 'DROPDOWN';
        else if (itemType === 4) typeStr = 'CHECKBOXES';

        const q: InspectedQuestion = {
          id: `q-${entryIdNum}`,
          entryKey,
          title: itemTitle,
          description: itemDesc,
          type: typeStr,
          required: isRequired,
          choices,
          pageIndex: currentPageIndex,
        };

        allQuestions.push(q);
        currentQuestions.push(q);
      }
    }

    if (currentQuestions.length > 0 || sections.length === 0) {
      sections.push({
        pageIndex: currentPageIndex,
        title: currentSectionTitle,
        description: currentSectionDesc,
        questions: currentQuestions,
      });
    }

    const versionHash = computeVersionHash(formId, allQuestions);

    return {
      formId,
      formTitle,
      formUrl,
      versionHash,
      sections,
      allQuestions,
      parsedAt: new Date().toISOString(),
      source: 'ONLINE_FETCH',
    };
  } catch (err) {
    console.error('[GoogleFormService] Inspection error, fallback to standard schema:', err);
    return getStandardFallbackSchema(formUrl);
  }
}

/**
 * Submits form data to Google Forms formResponse endpoint
 * Strictly detects confirmation headers, CAPTCHA, and authentication requirements
 */
export async function submitGoogleFormResponse(
  formId: string,
  formUrl: string,
  fieldValues: Record<string, string>,
  idempotencyKey: string
): Promise<{
  success: boolean;
  outcome: 'VERIFIED_COMPLETED' | 'VERIFICATION_UNKNOWN' | 'FAILED';
  isCaptcha?: boolean;
  requiresChallenge?: boolean;
  message?: string;
  error?: string;
  confirmationMessage?: string;
  timestamp: string;
}> {
  const cleanId = formId || extractFormIdFromUrl(formUrl);
  const targetUrl = `https://docs.google.com/forms/d/e/${cleanId}/formResponse`;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fieldValues)) {
    if (k.startsWith('entry.')) {
      params.append(k, v);
    }
  }
  params.append('fvv', '1');
  params.append('pageHistory', '0,1,2');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(targetUrl, {
      method: 'POST',
      body: params,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: formUrl,
      },
    });
    clearTimeout(timeout);

    const responseText = await res.text();

    // 1. Check for Authentication requirement
    if (res.url.includes('accounts.google.com/ServiceLogin') || responseText.includes('Sign in to continue')) {
      return {
        success: false,
        outcome: 'FAILED',
        requiresChallenge: true,
        error: 'Google Form requires Google Account Authentication. Automated submission halted.',
        timestamp: new Date().toISOString(),
      };
    }

    // 2. Check for CAPTCHA / Anti-bot protection
    if (responseText.includes('recaptcha') || responseText.includes('g-recaptcha') || responseText.includes('Unusual traffic')) {
      return {
        success: false,
        outcome: 'FAILED',
        isCaptcha: true,
        error: 'Google Form presented CAPTCHA or anti-bot verification. Automated submission stopped.',
        timestamp: new Date().toISOString(),
      };
    }

    // 3. Check for successful submission confirmation message
    const isRecorded =
      responseText.includes('Your response has been recorded') ||
      responseText.includes('freebirdFormviewHeaderResponseTitle') ||
      responseText.includes('has been recorded') ||
      responseText.includes('Thank you for submitting');

    if (res.ok && isRecorded) {
      return {
        success: true,
        outcome: 'VERIFIED_COMPLETED',
        message: 'Google Forms response successfully recorded and verified.',
        confirmationMessage: 'Your response has been recorded.',
        timestamp: new Date().toISOString(),
      };
    }

    // If HTTP 200 or 302, but couldn't strictly confirm message or unexpected HTML:
    return {
      success: false,
      outcome: 'VERIFICATION_UNKNOWN',
      error: 'HTTP received but confirmation message could not be verified. Marked as UNKNOWN to prevent duplicate submissions.',
      timestamp: new Date().toISOString(),
    };
  } catch (err: unknown) {
    // Network errors, connection timeouts
    return {
      success: false,
      outcome: 'VERIFICATION_UNKNOWN',
      error: `Network error during Google Form submission: ${err instanceof Error ? err.message : String(err)}. Status marked UNKNOWN.`,
      timestamp: new Date().toISOString(),
    };
  }
}
