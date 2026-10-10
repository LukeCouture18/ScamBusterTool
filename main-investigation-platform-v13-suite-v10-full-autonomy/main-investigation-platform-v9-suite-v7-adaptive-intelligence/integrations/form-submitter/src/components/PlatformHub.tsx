import React, { useState, useEffect } from 'react';
import {
  Network,
  ArrowRight,
  Database,
  CheckCircle2,
  RefreshCw,
  Copy,
  Check,
  Send,
  Code,
  Shield,
  Layers,
  Terminal,
} from 'lucide-react';
import { InvestigationFinding } from '../types';

interface PlatformHubProps {
  onImportCandidate: (finding: InvestigationFinding) => void;
}

export const PlatformHub: React.FC<PlatformHubProps> = ({ onImportCandidate }) => {
  const [platformFindings, setPlatformFindings] = useState<InvestigationFinding[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [simulationStatus, setSimulationStatus] = useState<string | null>(null);

  const fetchPlatformFindings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/platform/findings');
      if (res.ok) {
        const data = await res.json();
        setPlatformFindings(data.findings || []);
      }
    } catch (err) {
      console.error('Error fetching platform findings:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(fetchPlatformFindings, 0);
    return () => window.clearTimeout(initial);
  }, []);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Simulate pushing a finding from Main Investigation Platform
  const handleSimulateIntake = async (scenario: 'EXCHANGE' | 'DRAINER') => {
    setSimulationStatus('Sending test payload from Main Investigation Platform...');

    const payload =
      scenario === 'EXCHANGE'
        ? {
            id: `INV-${Date.now().toString().slice(-4)}`,
            siteUrl: 'https://fake-binance-earn-bonus.site/auth/deposit',
            domain: 'fake-binance-earn-bonus.site',
            wallets: [
              {
                id: `w-sim-${Date.now()}-1`,
                address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
                selectedNetwork: 'BTC',
                detectedNetworks: ['BTC'],
                checksumValid: true,
                isAmbiguous: false,
                validationNotes: ['Bitcoin Legacy P2PKH Base58Check verified'],
                status: 'READY',
                confidence: 0.99,
              },
              {
                id: `w-sim-${Date.now()}-2`,
                address: '0x28C6c06298d514Db089934071355E5743bf21d60',
                selectedNetwork: 'ETH',
                detectedNetworks: ['ETH', 'USDT_ERC20', 'USDT_BEP20'],
                checksumValid: true,
                isAmbiguous: false,
                validationNotes: ['EIP-55 mixed case checksum verified; confirmed with Ethereum tag'],
                status: 'READY',
                confidence: 0.95,
              },
            ],
            notes: 'High-confidence impersonation phishing portal of crypto exchange. Public deposit modal harvested by Site Investigator.',
            provenance: {
              investigationId: `INV-${Date.now().toString().slice(-4)}`,
              siteId: `SITE-${Date.now().toString().slice(-3)}`,
              walletIds: [`w-sim-1`, `w-sim-2`],
              evidenceIds: ['EVID-8902', 'EVID-8903'],
              sourceModule: 'Main Investigation Platform',
              timestamp: new Date().toISOString(),
              confidence: 0.97,
              mainPlatformSyncStatus: 'SYNCED',
            },
          }
        : {
            id: `INV-${Date.now().toString().slice(-4)}`,
            siteUrl: 'https://polygon-rewards-claim.xyz',
            domain: 'polygon-rewards-claim.xyz',
            wallets: [
              {
                id: `w-sim-${Date.now()}-3`,
                address: '0x00000000219ab540356cBB839Cbe05303d7705Fa',
                selectedNetwork: 'UNKNOWN',
                detectedNetworks: ['ETH', 'USDT_ERC20', 'USDT_BEP20'],
                checksumValid: true,
                isAmbiguous: true,
                ambiguityReason: '0x EVM deposit contract without network context',
                validationNotes: ['0x EVM format verified', 'Strict Policy: Needs review'],
                status: 'NEEDS_REVIEW',
                confidence: 0.7,
              },
            ],
            notes: 'Suspicious claim portal drainer flagged by CryptoWalletLogger.',
            provenance: {
              investigationId: `INV-${Date.now().toString().slice(-4)}`,
              siteId: `SITE-${Date.now().toString().slice(-3)}`,
              walletIds: [`w-sim-3`],
              evidenceIds: ['EVID-9011'],
              sourceModule: 'CryptoWalletLogger',
              timestamp: new Date().toISOString(),
              confidence: 0.7,
              mainPlatformSyncStatus: 'SYNCED',
            },
          };

    try {
      const res = await fetch('/api/platform/findings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        setSimulationStatus('Finding accepted into Form Submitter queue!');
        fetchPlatformFindings();
        onImportCandidate(payload as InvestigationFinding);
      } else {
        setSimulationStatus('Failed to send payload to backend');
      }
    } catch (err: unknown) {
      setSimulationStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }

    setTimeout(() => setSimulationStatus(null), 4000);
  };

  const sampleCurl = `curl -X POST http://localhost:3000/api/platform/findings \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "INV-2026-092",
    "siteUrl": "https://fraudulent-defi.top/deposit",
    "wallets": [
      {
        "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        "selectedNetwork": "BTC",
        "confidence": 0.98
      }
    ],
    "notes": "Fake DeFi yield platform",
    "provenance": {
      "investigationId": "INV-2026-092",
      "siteId": "SITE-552",
      "sourceModule": "Main Investigation Platform"
    }
  }'`;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          <Network className="w-6 h-6 text-amber-400" />
          Main Investigation Platform Integration Hub
        </h2>
        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
          The Form Submitter is the final verified egress node in your defensive investigation pipeline. It receives findings, enforces cryptographic validation and ambiguity rules, and prepares authorized Google Form submissions.
        </p>
      </div>

      {/* Investigation Pipeline Flow Architecture Diagram */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
          <Layers className="w-4 h-4 text-sky-400" />
          End-to-End Investigation Pipeline Workflow
        </h3>

        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-center text-xs">
          <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
            <span className="w-6 h-6 mx-auto mb-1.5 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-[11px]">1</span>
            <div className="font-semibold text-slate-200">Site Finder</div>
            <div className="text-[10px] text-slate-400 mt-1">Discovers scam lure domains</div>
          </div>

          <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
            <span className="w-6 h-6 mx-auto mb-1.5 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-[11px]">2</span>
            <div className="font-semibold text-slate-200">Site Investigator</div>
            <div className="text-[10px] text-slate-400 mt-1">Extracts UI deposit modals</div>
          </div>

          <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
            <span className="w-6 h-6 mx-auto mb-1.5 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-[11px]">3</span>
            <div className="font-semibold text-slate-200">CryptoWalletLogger</div>
            <div className="text-[10px] text-slate-400 mt-1">Harvests raw addresses &amp; QR</div>
          </div>

          <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
            <span className="w-6 h-6 mx-auto mb-1.5 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-[11px]">4</span>
            <div className="font-semibold text-slate-200">Wallet Investigator</div>
            <div className="text-[10px] text-slate-400 mt-1">Analyzes on-chain activity</div>
          </div>

          <div className="bg-slate-800/80 p-3 rounded-lg border border-slate-700">
            <span className="w-6 h-6 mx-auto mb-1.5 rounded-full bg-slate-700 text-slate-300 flex items-center justify-center font-bold text-[11px]">5</span>
            <div className="font-semibold text-slate-200">Main Platform</div>
            <div className="text-[10px] text-slate-400 mt-1">Aggregates case provenance</div>
          </div>

          <div className="bg-emerald-950/40 p-3 rounded-lg border border-emerald-500/50 shadow-xs">
            <span className="w-6 h-6 mx-auto mb-1.5 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center font-bold text-[11px]">6</span>
            <div className="font-bold text-emerald-300">Form Submitter</div>
            <div className="text-[10px] text-emerald-400/80 mt-1">Validation &amp; Prefill Egress</div>
          </div>
        </div>
      </div>

      {/* Simulator: Test Intake from Main Platform */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Send className="w-4 h-4 text-emerald-400" />
            Simulate Intake from Main Investigation Platform
          </h3>

          <span className="text-[11px] font-mono text-slate-400">
            REST Endpoint: /api/platform/findings
          </span>
        </div>

        <p className="text-xs text-slate-400">
          Click a simulation scenario to test how incoming findings are ingested into the queue with provenance metadata:
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => handleSimulateIntake('EXCHANGE')}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 flex items-center gap-2 transition-colors"
          >
            <Database className="w-4 h-4 text-emerald-400" />
            <span>Simulate Finding: Fake Crypto Exchange (BTC + ETH)</span>
          </button>

          <button
            onClick={() => handleSimulateIntake('DRAINER')}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 flex items-center gap-2 transition-colors"
          >
            <Shield className="w-4 h-4 text-amber-400" />
            <span>Simulate Finding: Phishing Drainer (Ambiguous 0x EVM)</span>
          </button>

          <button
            onClick={fetchPlatformFindings}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
            title="Refresh backend platform findings"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {simulationStatus && (
          <div className="text-xs text-emerald-400 bg-emerald-950/40 p-2.5 rounded-lg border border-emerald-500/30 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{simulationStatus}</span>
          </div>
        )}
      </div>

      {/* API Documentation for Developers & Automated Ingestion */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
            <Terminal className="w-4 h-4 text-purple-400" />
            HTTP API Specification for Main Platform Sync
          </h3>

          <button
            onClick={() => handleCopy(sampleCurl, 'curl')}
            className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
          >
            {copiedKey === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            <span>Copy curl</span>
          </button>
        </div>

        <pre className="text-xs font-mono text-slate-300 bg-slate-950 p-4 rounded-lg border border-slate-800 overflow-x-auto">
          {sampleCurl}
        </pre>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <strong className="text-slate-200 block mb-1">Status Polling Endpoint:</strong>
            <code className="text-sky-400 font-mono text-[11px] block">
              GET /api/platform/findings/:id/status
            </code>
            <p className="text-slate-400 text-[11px] mt-1">
              Returns whether the finding is READY, NEEDS_REVIEW, or COMPLETED by the investigator.
            </p>
          </div>

          <div className="bg-slate-950 p-3 rounded-lg border border-slate-800">
            <strong className="text-slate-200 block mb-1">Status Webhook Egress:</strong>
            <code className="text-sky-400 font-mono text-[11px] block">
              POST /api/platform/findings/:id/status
            </code>
            <p className="text-slate-400 text-[11px] mt-1">
              Updates investigation lifecycle status when human analyst confirms submission in Google Forms.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
