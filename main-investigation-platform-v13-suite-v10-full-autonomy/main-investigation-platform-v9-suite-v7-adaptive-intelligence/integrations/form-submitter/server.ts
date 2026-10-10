import express from 'express';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { durableStorage } from './server/durableStorage';
import { inspectGoogleForm, submitGoogleFormResponse } from './server/googleFormService';
import {startPlatformReportWorker} from './server/integration/platform_worker';

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

dotenv.config();
startPlatformReportWorker().catch(error=>console.error('Form platform worker startup:',error));

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

// Body parser with 25mb limit for screenshot uploads
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ==========================================
// 1. Health & Recovery Endpoints
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Crypto Scam Report Form Submitter v1.1',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    recoveryLogs: durableStorage.getRecoveryLogs(),
    timestamp: new Date().toISOString(),
  });
});

// `python3` does not exist on a standard Windows install (or is the Microsoft Store alias), so try the
// interpreters in the same order as the rest of the suite: MIP_PYTHON, then python3/python, py -3.
function makeProjectZip(): void {
  const candidates: [string, string[]][] = [
    ...(process.env.MIP_PYTHON ? [[process.env.MIP_PYTHON, []] as [string, string[]]] : []),
    ...(process.platform === 'win32' ? [['python', []], ['py', ['-3']]] as [string, string[]][] : [['python3', []], ['python', []]] as [string, string[]][]),
  ];
  let last: unknown;
  for (const [command, prefix] of candidates) {
    try {
      execFileSync(command, [...prefix, 'scripts/make_zip.py', 'public/project-archive.zip'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch (err) { last = err; }
  }
  throw last;
}

app.get('/api/download-zip', (req, res) => {
  const zipPath = path.join(process.cwd(), 'public', 'project-archive.zip');
  try {
    makeProjectZip();
  } catch (err: unknown) {
    console.warn('Zip generation notice:', errorMessage(err));
  }

  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="crypto-scam-report-submitter.zip"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(zipPath);
  } else {
    res.status(500).json({ error: 'Archive could not be generated' });
  }
});

app.get('/api/zip-base64', (req, res) => {
  const zipPath = path.join(process.cwd(), 'public', 'project-archive.zip');
  try {
    makeProjectZip();
  } catch (err: unknown) {
    console.warn('Zip generation notice:', errorMessage(err));
  }

  if (fs.existsSync(zipPath)) {
    const buffer = fs.readFileSync(zipPath);
    const base64 = buffer.toString('base64');
    res.json({
      success: true,
      filename: 'crypto-scam-report-submitter.zip',
      sizeBytes: buffer.length,
      base64,
    });
  } else {
    res.status(500).json({ error: 'Archive could not be generated' });
  }
});

// ==========================================
// 2. Durable Structured Storage API
// ==========================================
app.get('/api/storage/state', (req, res) => {
  try {
    const state = durableStorage.getState();
    res.json({
      success: true,
      state,
      recoveryLogs: durableStorage.getRecoveryLogs(),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to read durable state', details: errorMessage(err) });
  }
});

app.post('/api/storage/sync', (req, res) => {
  try {
    const result = durableStorage.syncFullState(req.body);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to sync durable state', details: errorMessage(err) });
  }
});

app.post('/api/storage/finding', (req, res) => {
  try {
    const finding = req.body;
    if (!finding || !finding.id) {
      res.status(400).json({ error: 'Finding payload requires an id' });
      return;
    }
    const result = durableStorage.upsertFinding(finding);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to persist finding', details: errorMessage(err) });
  }
});

app.delete('/api/storage/finding/:id', (req, res) => {
  try {
    const success = durableStorage.deleteFinding(req.params.id);
    res.json({ success, deletedId: req.params.id });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to delete finding', details: errorMessage(err) });
  }
});

app.post('/api/storage/history', (req, res) => {
  try {
    const record = req.body;
    if (!record || !record.id) {
      res.status(400).json({ error: 'History record requires an id' });
      return;
    }
    durableStorage.appendHistoryRecord(record);
    res.json({ success: true, recordId: record.id });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to append history record', details: errorMessage(err) });
  }
});

app.get('/api/storage/recovery', (req, res) => {
  res.json({
    recoveryLogs: durableStorage.getRecoveryLogs(),
  });
});

// ==========================================
// 3. Real Google Form Inspection & Submission
// ==========================================
app.post('/api/forms/inspect', async (req, res) => {
  try {
    const { formUrl } = req.body;
    if (!formUrl) {
      res.status(400).json({ error: 'Missing formUrl parameter' });
      return;
    }
    const schema = await inspectGoogleForm(formUrl);
    res.json({ success: true, schema });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to inspect Google Form', details: errorMessage(err) });
  }
});

app.post('/api/forms/submit', async (req, res) => {
  try {
    const { formId, formUrl, fieldValues, idempotencyKey, domain, username } = req.body;

    if (!formUrl || !fieldValues) {
      res.status(400).json({ error: 'Missing formUrl or fieldValues' });
      return;
    }

    // Check duplicate registry for idempotencyKey
    const state = durableStorage.getState();
    if (idempotencyKey && state.duplicateRegistry.idempotencyKeys[idempotencyKey]) {
      const prior = state.duplicateRegistry.idempotencyKeys[idempotencyKey];
      res.status(409).json({
        success: false,
        error: `Duplicate Submission Blocked: Idempotency key '${idempotencyKey}' was already submitted on ${prior.timestamp}`,
        outcome: 'FAILED',
      });
      return;
    }

    const result = await submitGoogleFormResponse(formId, formUrl, fieldValues, idempotencyKey);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({
      success: false,
      outcome: 'VERIFICATION_UNKNOWN',
      error: `Internal server error while executing form submission: ${errorMessage(err)}`,
    });
  }
});

// ==========================================
// 4. Main Investigation Platform Integration & Events
// ==========================================
app.post('/api/platform/findings', (req, res) => {
  try {
    const finding = req.body;
    if (!finding || !finding.siteUrl) {
      res.status(400).json({ error: 'Finding payload must include siteUrl' });
      return;
    }

    const id = finding.id || `FINDING-${Date.now()}`;
    const domain =
      finding.domain ||
      (finding.siteUrl.startsWith('http')
        ? new URL(finding.siteUrl).hostname
        : finding.siteUrl.split('/')[0]);

    const sanitizedFinding = {
      ...finding,
      id,
      domain,
      overallStatus: finding.overallStatus || 'NEEDS_REVIEW',
      queueStatus: finding.queueStatus || 'PENDING',
      submissionState: 'NOT_STARTED',
      createdAt: finding.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provenance: {
        investigationId: finding.provenance?.investigationId || id,
        siteId: finding.provenance?.siteId || `SITE-${Date.now().toString().slice(-4)}`,
        walletIds: finding.provenance?.walletIds || (finding.wallets || []).map((w: { id?: string; address?: string }) => w.id || w.address),
        evidenceIds: finding.provenance?.evidenceIds || [],
        sourceModule: finding.provenance?.sourceModule || 'Main Investigation Platform',
        timestamp: new Date().toISOString(),
        confidence: finding.provenance?.confidence || 0.9,
        mainPlatformSyncStatus: 'SYNCED',
        schemaVersion: '1.1.0',
      },
    };

    durableStorage.upsertFinding(sanitizedFinding);

    // Emit event
    durableStorage.emitPlatformEvent({
      eventId: `EVT-${Date.now()}`,
      findingId: id,
      investigationId: sanitizedFinding.provenance.investigationId,
      eventType: 'report.received',
      timestamp: new Date().toISOString(),
      payload: {
        domain,
        status: sanitizedFinding.overallStatus,
        walletsCount: (sanitizedFinding.wallets || []).length,
      },
    });

    res.status(201).json({
      success: true,
      message: 'Finding accepted from Main Investigation Platform into durable queue',
      findingId: id,
      status: sanitizedFinding.overallStatus,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to process finding submission', details: errorMessage(err) });
  }
});

app.get('/api/platform/findings', (req, res) => {
  const state = durableStorage.getState();
  res.json({
    total: state.findings.length,
    findings: state.findings,
  });
});

app.get('/api/platform/findings/:id/status', (req, res) => {
  const state = durableStorage.getState();
  const item = state.findings.find((f) => f.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Finding ID not found' });
    return;
  }
  res.json({
    id: item.id,
    siteUrl: item.siteUrl,
    status: item.overallStatus,
    submissionState: item.submissionState,
    completedAt: item.completedAt,
    updatedAt: item.updatedAt,
  });
});

app.post('/api/platform/findings/:id/status', (req, res) => {
  const state = durableStorage.getState();
  const item = state.findings.find((f) => f.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Finding ID not found' });
    return;
  }
  const { status, submissionState, completedAt } = req.body;
  if (status) item.overallStatus = status;
  if (submissionState) item.submissionState = submissionState;
  if (completedAt) item.completedAt = completedAt;
  item.updatedAt = new Date().toISOString();

  durableStorage.upsertFinding(item);

  res.json({
    success: true,
    id: item.id,
    status: item.overallStatus,
    submissionState: item.submissionState,
    updatedAt: item.updatedAt,
  });
});

app.post('/api/platform/events', (req, res) => {
  try {
    const event = req.body;
    durableStorage.emitPlatformEvent(event);
    res.json({ success: true, eventId: event.eventId });
  } catch (err: unknown) {
    res.status(500).json({ error: 'Failed to record event', details: errorMessage(err) });
  }
});

app.get('/api/platform/events', (req, res) => {
  const state = durableStorage.getState();
  res.json({
    total: state.platformEvents.length,
    events: state.platformEvents,
  });
});

// ==========================================
// 5. Screenshot Candidate Extraction via Gemini Vision
// ==========================================
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

app.post('/api/extract-screenshot', async (req, res) => {
  try {
    const { imageBase64, mimeType = 'image/png' } = req.body;

    if (!imageBase64) {
      res.status(400).json({ error: 'Missing imageBase64 in request body' });
      return;
    }

    const ai = getGeminiClient();
    if (!ai) {
      res.json({
        candidate: {
          url: '',
          wallets: [],
          scamTypeIndicators: ['API key not configured: manual review required'],
          reasoning:
            'Gemini API key is not configured. Please review the screenshot manually or attach credentials in Settings.',
        },
      });
      return;
    }

    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');

    const prompt = `You are an expert defensive cryptocurrency scam investigator analyzing an evidence screenshot from a suspected scam website, fraudulent investment vault, phishing portal, or fake exchange.
Task:
1. Identify any scam website URL, domain name, or page title visible in the address bar, page header, or content.
2. Carefully detect and extract all publicly displayed cryptocurrency deposit wallet addresses or QR code address captions.
3. Identify the token or network associated with each wallet (e.g. Bitcoin / BTC, Ethereum / ERC20, TRON / USDT TRC20, BSC / BEP20, Solana / SOL, XRP, Litecoin, Dogecoin).
4. CRITICAL RULE: NEVER hallucinate, guess, or truncate wallet addresses. Only extract complete, visible character sequences. If unsure or partially obscured, state confidence is low.
5. Identify scam indicators (e.g. "guaranteed 300% return", "fake cloud mining", "deposit bonus", "urgent timer", "fake customer service deposit instructions").

Respond in valid JSON with this exact schema:
{
  "url": "https://example-scam.com",
  "wallets": [
    {
      "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      "suggestedNetwork": "BTC",
      "confidence": 0.95,
      "rawContext": "Visible under Bitcoin Deposit Address label"
    }
  ],
  "scamTypeIndicators": ["Guaranteed returns", "Fake staking", "Deposit countdown timer"],
  "reasoning": "Clear deposit address found under USDT TRC20 tab in screenshot."
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: cleanBase64,
            },
          },
          { text: prompt },
        ],
      },
      config: {
        responseMimeType: 'application/json',
      },
    });

    const responseText = response.text || '{}';
    let parsedData = {};
    try {
      parsedData = JSON.parse(responseText);
    } catch {
      parsedData = { reasoning: responseText, wallets: [] };
    }

    res.json({ candidate: parsedData });
  } catch (error: unknown) {
    console.error('Error extracting screenshot:', error);
    res.status(500).json({
      error: 'Failed to process image with Gemini Vision',
      details: errorMessage(error),
    });
  }
});

// ==========================================
// 6. Vite Dev Server / Static Hosting
// ==========================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[Crypto Scam Report Form Submitter v1.1] Running on port ${PORT}`);
  });
}

startServer();
