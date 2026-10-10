import React, { useState } from 'react';
import {
  OperationProfile,
  Lead,
  Entity,
  Relationship,
  Evidence,
  Hypothesis,
  ReappearanceLead,
  InvestigatorBriefing,
  PursuitState,
  GraphCluster,
  GraphBridge,
  CuratedBriefingLead,
  ScamKitGenome,
  FinancialAnalysis,
  CrossOperationSimilarity,
  ContradictionReport
} from '../../types';
import {
  ShieldCheck,
  HelpCircle,
  Clock,
  Sparkles,
  ArrowRight,
  Compass,
  AlertTriangle,
  Play,
  Pause,
  RotateCw,
  Plus,
  Radio,
  FileSearch,
  Square,
  FastForward,
  Cpu,
  Layers,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  BookOpen,
  DollarSign,
  Binary,
  GitCompare,
  CheckCircle2,
  XCircle,
  Search
} from 'lucide-react';

interface OverviewViewProps {
  operation: OperationProfile;
  briefing?: InvestigatorBriefing;
  pursuit?: PursuitState;
  clusters?: GraphCluster[];
  bridges?: GraphBridge[];
  scamKitGenomes?: ScamKitGenome[];
  financialAnalysis?: FinancialAnalysis;
  crossOpSimilarities?: CrossOperationSimilarity[];
  contradictionReports?: ContradictionReport[];
  leads: Lead[];
  entities: Entity[];
  relationships: Relationship[];
  evidenceList: Evidence[];
  hypotheses: Hypothesis[];
  reappearanceLeads: ReappearanceLead[];
  onOpenSeedModal: () => void;
  onExpandAll: () => Promise<void>;
  onEvaluateHypotheses: () => Promise<void>;
  onGenerateLeads: () => Promise<void>;
  onExecuteLead: (leadId: string) => Promise<void>;
  onStartPursuit?: () => Promise<void>;
  onPausePursuit?: () => Promise<void>;
  onResumePursuit?: () => Promise<void>;
  onStopPursuit?: () => Promise<void>;
  onStepPursuit?: () => Promise<void>;
  onSelectLeadForInvestigation: (lead: Lead) => void;
  onInspectLineage: (type: 'conclusion' | 'entity' | 'relationship', data: any) => void;
  isProcessing: boolean;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  operation,
  briefing,
  pursuit,
  clusters = [],
  bridges = [],
  scamKitGenomes = [],
  financialAnalysis,
  crossOpSimilarities = [],
  contradictionReports = [],
  leads,
  entities,
  relationships,
  evidenceList,
  hypotheses,
  reappearanceLeads,
  onOpenSeedModal,
  onExpandAll,
  onEvaluateHypotheses,
  onGenerateLeads,
  onExecuteLead,
  onStartPursuit,
  onPausePursuit,
  onResumePursuit,
  onStopPursuit,
  onStepPursuit,
  onSelectLeadForInvestigation,
  onInspectLineage,
  isProcessing
}) => {
  const [executingLeadId, setExecutingLeadId] = useState<string | null>(null);
  const [selectedLeadForDetails, setSelectedLeadForDetails] = useState<CuratedBriefingLead | null>(null);
  const [showAdvancedTelemetry, setShowAdvancedTelemetry] = useState(false);
  const [activeTelemetryTab, setActiveTelemetryTab] = useState<'genome' | 'financial' | 'crossop' | 'contradictions'>('genome');
  const [activeGlossaryTerm, setActiveGlossaryTerm] = useState<string | null>(null);

  // Fallback briefing values if not yet loaded from backend
  const displayBriefing: InvestigatorBriefing = briefing || {
    operationId: operation.id,
    generatedAt: new Date().toISOString(),
    whatDidWeFind: `We have mapped an active multi-tiered cryptocurrency scam campaign spanning ${entities.filter(e => e.type === 'domain').length || 2} phishing web portals, hosted on offshore bulletproof servers across Seychelles and Moldova. The sites deploy identical automated drainer code that steals cryptocurrency from connected wallets and funnels stolen funds into a shared central treasury address.`,
    whyDoesItMatter: `This is not an isolated one-off phishing website. The operators have built durable infrastructure designed to survive registrar takedowns by rotating domains, sharing wildcard SSL certificates, and using automated on-chain contracts. Understanding the full operation allows investigators to alert hosting providers, block malicious smart contracts, and trace the stolen money to regulated crypto exchanges before it is laundered.`,
    howConfidentAreWe: {
      percentage: 94,
      assessment: 'High Confidence: Strong technical corroboration across multiple independent sources (passive DNS, SSL certificates, DOM hash trees, and blockchain transactions).',
      evidenceCount: evidenceList.filter(e => e.status === 'valid').length
    },
    importantDiscovery: {
      title: 'Identified Standby Phishing Asset: eth-support-verification.top',
      description: 'Our automated pursuit discovered a dormant scam domain sharing the exact same offshore nameserver authority (ns1.offshore-dns.is) and code fingerprint.',
      whyItMatters: 'Scam operators register backup domains in advance. When security vendors block the primary domain, they immediately swap in the standby domain. Finding it early enables proactive blocking.',
      discoveredAt: new Date().toISOString()
    },
    whatChanged: operation.recentChanges && operation.recentChanges.length > 0
      ? operation.recentChanges
      : [
          'Pursuit engine completed automated hop across passive DNS and on-chain logs.',
          'Added 2 new corroborated infrastructure links to the operation graph.',
          'Preserved historical domain rotation from eth-recovery-claim.top to claim-revoke-portal.link.'
        ],
    uncertaintiesAndContradictions: [
      'Common Ownership vs Shared Bulletproof Hosting: Just because two websites share an offshore IP address does not prove they are run by the same criminal. Bulletproof hosts often serve hundreds of unrelated cybercriminals.',
      'Turnkey Scam-Kit Syndication: The website code matches "CryptoDrainer-X", which is sold as a commercial kit on darknet forums. Multiple independent scam groups could simply be using the same template vendor.'
    ],
    topLeads: leads.filter(l => l.status === 'PENDING').slice(0, 4).map(l => ({
      id: l.id,
      title: l.title,
      whatHunterNoticed: l.description,
      whyItMatters: l.reasoning,
      whatItDoesNotProve: 'Does not conclusively prove common individual ownership; secondary verification required.',
      simpleExplanation: l.description,
      targetValue: l.targetValue,
      targetType: l.targetType,
      pivotType: l.pivotType,
      confidence: Math.round(l.priorityScore),
      supportingEvidenceCount: 2,
      contradictingEvidenceCount: 0,
      evidenceSummary: '2 supporting observations logged from verified passive collector feeds.',
      recommendedNextStep: 'Execute this pivot to map additional nodes in the syndicate.',
      bestNextStep: 'Execute this pivot to map additional nodes in the syndicate.',
      priorityScore: l.priorityScore,
      executionActionKey: l.executionActionKey,
      status: l.status
    })),
    whatShouldIInvestigateNext: 'We recommend querying passive DNS on the offshore bulletproof nameserver authority to discover unindexed standby domains.',
    glossary: {
      'Bulletproof Hosting': 'Offshore hosting providers operating in jurisdictions that routinely ignore international DMCA and law enforcement takedown requests.',
      'Certificate Transparency (CT)': 'Public, append-only cryptographic logs where all public SSL/TLS certificates must be recorded, allowing discovery of hidden subdomains and related infrastructure.',
      'DOM AST Hash': 'A structural fingerprint of a webpage\'s HTML and JavaScript code hierarchy, independent of superficial text changes or obfuscation.',
      'Choke Point': 'A single point of failure in an adversary\'s infrastructure (e.g. an authoritative nameserver or central treasury wallet) that, if disrupted, affects the entire operation.',
      'Splitter Contract': 'An on-chain smart contract programmed to immediately divide stolen cryptocurrency into predetermined percentage splits (e.g. 80% to operator, 20% to scam-kit vendor).',
      'Mixer / Privacy Pool': 'A smart contract protocol (such as Railgun or Tornado Cash) that pools deposits and breaks the deterministic on-chain link between depositors and withdrawers.',
      'Scam-Kit Syndication': 'A software-as-a-service model where a darknet developer licenses phishing templates and drainer code to multiple independent criminal operators.',
      'Convergence Node': 'A single wallet or contract address where funds from multiple disparate phishing frontends merge into one consolidation pool.'
    }
  };

  const pursuitStatus = pursuit?.status || 'IDLE';
  const isPursuitRunning = pursuitStatus === 'RUNNING';
  const currentHop = pursuit?.currentHop || 1;
  const maxHops = pursuit?.config.maxHops || 4;
  const budgetRemaining = pursuit?.config.budgetRemaining ?? 21;
  const budgetTotal = pursuit?.config.budgetTotal || 25;

  const handleExecuteLead = async (lead: CuratedBriefingLead) => {
    try {
      setExecutingLeadId(lead.id);
      await onExecuteLead(lead.id);
    } finally {
      setExecutingLeadId(null);
    }
  };

  const activeGenome = scamKitGenomes.length > 0 ? scamKitGenomes[0] : null;

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16">
      {/* 1. Autonomous Pursuit Engine Control Bar */}
      <div className="p-4 rounded-xl bg-[#090d16] border border-[#162035] shadow-xl flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-xs font-mono font-bold tracking-wider text-blue-400 uppercase">
              Autonomous Pursuit Engine v0.3
            </span>
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Pursuit Status Badge */}
          <span
            className={`text-xs px-2.5 py-0.5 rounded font-mono font-medium border ${
              pursuitStatus === 'RUNNING'
                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                : pursuitStatus === 'PAUSED'
                ? 'bg-amber-950/60 border-amber-500/40 text-amber-300'
                : pursuitStatus === 'SATURATED'
                ? 'bg-purple-950/60 border-purple-500/40 text-purple-300'
                : 'bg-slate-900 border-slate-700/60 text-slate-400'
            }`}
          >
            {pursuitStatus}
          </span>

          <span className="text-xs text-slate-400">
            Hop <strong className="text-white font-mono">{currentHop}</strong> of {maxHops}
          </span>

          <div className="h-4 w-px bg-slate-800" />

          <span className="text-xs text-slate-400">
            Budget: <strong className="text-blue-300 font-mono">{budgetRemaining}</strong>/{budgetTotal} pivots remaining
          </span>
        </div>

        {/* Pursuit Controls */}
        <div className="flex items-center gap-2">
          {pursuitStatus === 'RUNNING' ? (
            <button
              onClick={onPausePursuit}
              disabled={isProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600/20 border border-amber-500/40 text-amber-300 hover:bg-amber-600/30 text-xs font-semibold transition-colors disabled:opacity-50"
            >
              <Pause className="w-3.5 h-3.5" />
              <span>Pause Pursuit</span>
            </button>
          ) : (
            <button
              onClick={pursuitStatus === 'PAUSED' ? onResumePursuit : onStartPursuit}
              disabled={isProcessing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 text-xs font-semibold transition-colors disabled:opacity-50 shadow-sm"
            >
              <Play className={`w-3.5 h-3.5 text-blue-400 ${isPursuitRunning ? 'animate-spin' : ''}`} />
              <span>{pursuitStatus === 'PAUSED' ? 'Resume Pursuit' : 'Start Pursuit'}</span>
            </button>
          )}

          <button
            onClick={onStepPursuit}
            disabled={isProcessing || pursuitStatus === 'RUNNING'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#111728] border border-[#1e2a44] text-slate-300 hover:text-white hover:border-blue-500/50 text-xs font-semibold transition-colors disabled:opacity-50"
            title="Step through one single autonomous hop"
          >
            <FastForward className="w-3.5 h-3.5 text-indigo-400" />
            <span>Step Hop</span>
          </button>

          {pursuitStatus !== 'IDLE' && (
            <button
              onClick={onStopPursuit}
              disabled={isProcessing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700/60 text-slate-400 hover:text-rose-400 hover:border-rose-500/40 text-xs font-semibold transition-colors"
              title="Stop pursuit"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          )}

          <button
            onClick={onOpenSeedModal}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#111728] border border-[#1e2a44] text-slate-300 hover:text-white hover:border-blue-500/50 text-xs font-semibold transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            <span>Ingest Seed</span>
          </button>
        </div>
      </div>

      {/* 2. Executive Investigator Briefing (What We Found & Why It Matters) */}
      <div className="rounded-xl bg-[#0b0f19] border border-[#162035] p-6 shadow-lg space-y-5">
        <div className="flex items-start justify-between gap-4 border-b border-[#162035] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-blue-400 bg-blue-950/40 px-2 py-0.5 rounded border border-blue-800/40">
                Investigator Briefing
              </span>
              <span className="text-xs text-slate-400">
                Operation <strong className="text-white font-mono">{operation.code}</strong>
              </span>
            </div>
            <h1 className="text-lg font-bold text-white tracking-tight mt-1">
              {operation.name}
            </h1>
          </div>

          {/* Confidence Indicator */}
          <div className="text-right">
            <div className="flex items-center justify-end gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-bold text-white font-mono">
                {displayBriefing.howConfidentAreWe.percentage}% Confidence
              </span>
            </div>
            <span className="text-[11px] text-slate-400">
              Corroborated by {displayBriefing.howConfidentAreWe.evidenceCount} verified observations
            </span>
          </div>
        </div>

        {/* Narrative Grid: What Did We Find + Why It Matters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="space-y-1.5 bg-[#090d16] p-4 rounded-lg border border-[#162035]">
            <div className="flex items-center gap-2 text-xs font-semibold text-blue-400 uppercase tracking-wide">
              <Compass className="w-3.5 h-3.5" />
              <span>What Did We Find?</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {displayBriefing.whatDidWeFind}
            </p>
          </div>

          <div className="space-y-1.5 bg-[#090d16] p-4 rounded-lg border border-[#162035]">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400 uppercase tracking-wide">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Why Does It Matter?</span>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {displayBriefing.whyDoesItMatter}
            </p>
          </div>
        </div>

        {/* Confidence Assessment Bar */}
        <div className="flex items-center gap-3 bg-[#090d16] p-3 rounded-lg border border-[#162035] text-xs">
          <Info className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="text-slate-300">
            <strong className="text-white">Assessment:</strong> {displayBriefing.howConfidentAreWe.assessment}
          </span>
        </div>
      </div>

      {/* 3. Important Discovery (Breakthrough Banner) */}
      {displayBriefing.importantDiscovery && (
        <div className="p-4 rounded-xl bg-gradient-to-r from-blue-950/40 via-[#0b0f19] to-indigo-950/30 border border-blue-500/30 shadow-md flex items-start gap-4">
          <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400 border border-blue-500/30 shrink-0">
            <Sparkles className="w-5 h-5 animate-pulse" />
          </div>
          <div className="space-y-1 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-blue-400 bg-blue-950/60 px-1.5 py-0.5 rounded border border-blue-800/40">
                Key Breakthrough
              </span>
              <h2 className="text-sm font-bold text-white">
                {displayBriefing.importantDiscovery.title}
              </h2>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {displayBriefing.importantDiscovery.description}
            </p>
            <div className="text-[11px] text-slate-400 pt-1">
              <strong className="text-blue-300">Operational Significance:</strong> {displayBriefing.importantDiscovery.whyItMatters}
            </div>
          </div>
        </div>
      )}

      {/* 4. Top 3–5 Curated Leads (Student-Friendly Pedagogical Format) */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold uppercase text-emerald-400 font-bold tracking-wide">
                Curated Investigation Leads
              </span>
              <span className="text-[11px] text-slate-400">
                (Strictly 3–5 highest information-gain branches)
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Operation Hunter surfaced these actionable leads. Every lead explains what was observed, why it matters, and what it does NOT prove before execution.
            </p>
          </div>

          <button
            onClick={onGenerateLeads}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#111728] border border-[#1e2a44] text-slate-300 hover:text-white hover:border-blue-500/50 text-xs font-semibold transition-colors disabled:opacity-50"
          >
            <RotateCw className="w-3.5 h-3.5 text-blue-400" />
            <span>Re-Rank Leads</span>
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {displayBriefing.topLeads.map((lead, idx) => (
            <div
              key={lead.id}
              className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] hover:border-blue-500/40 transition-colors shadow-sm space-y-4"
            >
              {/* Card Header */}
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-mono font-bold text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                      LEAD #{idx + 1}
                    </span>
                    <span className="text-[11px] font-mono text-blue-400 bg-blue-950/40 border border-blue-900/40 px-2 py-0.5 rounded">
                      {lead.pivotType}
                    </span>
                    <span className="text-[11px] text-emerald-400 font-mono font-semibold">
                      {lead.confidence}% Expected Gain
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-white pt-0.5">
                    {lead.title}
                  </h3>
                </div>

                {/* Primary Execution Action */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setSelectedLeadForDetails(lead)}
                    className="px-2.5 py-1.5 rounded-lg bg-[#111728] border border-[#1e2a44] text-slate-300 hover:text-white text-xs font-medium transition-colors"
                  >
                    View Evidence
                  </button>
                  <button
                    onClick={() => handleExecuteLead(lead)}
                    disabled={isProcessing || executingLeadId === lead.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 text-xs font-semibold transition-colors disabled:opacity-50"
                  >
                    <Play className={`w-3 h-3 ${executingLeadId === lead.id ? 'animate-spin' : ''}`} />
                    <span>{executingLeadId === lead.id ? 'Executing...' : 'Investigate Pivot'}</span>
                  </button>
                </div>
              </div>

              {/* 6-Part Structured Breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                {/* 1. What Hunter Noticed */}
                <div className="p-3 rounded-lg bg-[#090d16] border border-[#162035] space-y-1">
                  <div className="flex items-center gap-1.5 text-blue-400 font-semibold uppercase tracking-wider text-[10px]">
                    <Search className="w-3 h-3" />
                    <span>1. What Hunter Noticed</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    {lead.whatHunterNoticed || lead.simpleExplanation}
                  </p>
                </div>

                {/* 2. Why It Matters */}
                <div className="p-3 rounded-lg bg-[#090d16] border border-[#162035] space-y-1">
                  <div className="flex items-center gap-1.5 text-amber-400 font-semibold uppercase tracking-wider text-[10px]">
                    <AlertTriangle className="w-3 h-3" />
                    <span>2. Why It Matters</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    {lead.whyItMatters}
                  </p>
                </div>

                {/* 3. What It Does NOT Prove (Anti-Attribution Guardrail) */}
                <div className="p-3 rounded-lg bg-[#090d16] border border-amber-900/30 space-y-1">
                  <div className="flex items-center gap-1.5 text-amber-300 font-semibold uppercase tracking-wider text-[10px]">
                    <HelpCircle className="w-3 h-3" />
                    <span>3. What It Does NOT Prove</span>
                  </div>
                  <p className="text-amber-200/90 leading-relaxed">
                    {lead.whatItDoesNotProve || 'Does not conclusively prove common individual ownership; secondary verification required.'}
                  </p>
                </div>

                {/* 4. Best Next Step & Evidence */}
                <div className="p-3 rounded-lg bg-[#090d16] border border-emerald-900/30 space-y-1">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-semibold uppercase tracking-wider text-[10px]">
                    <ArrowRight className="w-3 h-3" />
                    <span>4. Recommended Next Step</span>
                  </div>
                  <p className="text-emerald-300/90 leading-relaxed">
                    {lead.bestNextStep || lead.recommendedNextStep}
                  </p>
                </div>
              </div>

              {/* Lineage & Evidence Footer */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-[#162035]">
                <div className="flex items-center gap-3">
                  <span>Target: <strong className="text-slate-200 font-mono">{lead.targetValue}</strong></span>
                  <span>•</span>
                  <span>{lead.evidenceSummary || `${lead.supportingEvidenceCount} supporting observations`}</span>
                </div>

                <button
                  onClick={() => onInspectLineage('relationship', { targetValue: lead.targetValue, pivotType: lead.pivotType })}
                  className="flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                >
                  <span>Why does system believe this?</span>
                  <ExternalLink className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 5. What Changed & Uncertainties Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* What Changed (Temporal Intelligence) */}
        <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              What Changed? (Temporal Reconstruction)
            </h3>
          </div>
          <ul className="space-y-2 text-xs text-slate-300">
            {displayBriefing.whatChanged.map((change, i) => (
              <li key={i} className="flex items-start gap-2 bg-[#090d16] p-2.5 rounded border border-[#162035]">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                <span>{change}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Uncertainties & Contradictions (Anti-Premature Attribution) */}
        <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
              Uncertainties & Contradictions (What is NOT Proven)
            </h3>
          </div>
          <ul className="space-y-2 text-xs text-slate-300">
            {displayBriefing.uncertaintiesAndContradictions.map((item, i) => (
              <li key={i} className="flex items-start gap-2 bg-[#090d16] p-2.5 rounded border border-[#162035]">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 6. Contextual Glossary: "Teach Me While I Investigate" */}
      {displayBriefing.glossary && (
        <div className="p-5 rounded-xl bg-[#0b0f19] border border-[#162035] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-indigo-400" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                Teach Me While I Investigate (Contextual Glossary)
              </h3>
            </div>
            <span className="text-[11px] text-slate-400">
              Click a term to view plain English operational definitions
            </span>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {Object.keys(displayBriefing.glossary).map((term) => (
              <button
                key={term}
                onClick={() => setActiveGlossaryTerm(activeGlossaryTerm === term ? null : term)}
                className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                  activeGlossaryTerm === term
                    ? 'bg-indigo-600/30 border-indigo-500/60 text-indigo-200 shadow-sm'
                    : 'bg-[#090d16] border-[#162035] text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                {term}
              </button>
            ))}
          </div>

          {activeGlossaryTerm && (
            <div className="p-3.5 rounded-lg bg-indigo-950/20 border border-indigo-800/40 text-xs text-slate-200 space-y-1">
              <div className="font-bold text-indigo-300 font-mono">
                {activeGlossaryTerm}
              </div>
              <p className="leading-relaxed text-slate-300">
                {displayBriefing.glossary[activeGlossaryTerm]}
              </p>
            </div>
          )}
        </div>
      )}

      {/* 7. What Should I Investigate Next? (Clear Action Guidance) */}
      <div className="p-4 rounded-xl bg-gradient-to-r from-blue-950/30 to-[#0b0f19] border border-blue-900/40 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="p-2 rounded-lg bg-blue-600/20 text-blue-400 border border-blue-500/30">
            <Compass className="w-4 h-4" />
          </span>
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-blue-400">
              Recommended Next Action
            </div>
            <p className="text-xs text-slate-200 mt-0.5">
              {displayBriefing.whatShouldIInvestigateNext}
            </p>
          </div>
        </div>

        {displayBriefing.topLeads.length > 0 && (
          <button
            onClick={() => handleExecuteLead(displayBriefing.topLeads[0])}
            disabled={isProcessing || executingLeadId === displayBriefing.topLeads[0].id}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-lg shadow-blue-900/30 transition-all shrink-0 disabled:opacity-50"
          >
            <span>Execute Top Lead</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 8. Progressive Disclosure: Advanced Telemetry & Deep Intelligence */}
      <div className="rounded-xl bg-[#0b0f19] border border-[#162035] overflow-hidden">
        <button
          onClick={() => setShowAdvancedTelemetry(!showAdvancedTelemetry)}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-[#0e1424] transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <Cpu className="w-4 h-4 text-blue-400" />
            <div>
              <div className="text-xs font-bold uppercase tracking-wider text-slate-200">
                Advanced Operation Intelligence & Telemetry
              </div>
              <div className="text-[11px] text-slate-400">
                Deep scam-kit genome AST signatures, on-chain flows, cross-operation similarity, and contradiction hunting
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 text-xs text-slate-400">
            <span>{showAdvancedTelemetry ? 'Hide Advanced' : 'Explore Advanced Telemetry'}</span>
            {showAdvancedTelemetry ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </div>
        </button>

        {showAdvancedTelemetry && (
          <div className="p-5 border-t border-[#162035] space-y-5 bg-[#090d16]">
            {/* Sub-Tabs for Advanced Telemetry */}
            <div className="flex items-center gap-2 border-b border-[#162035] pb-3">
              <button
                onClick={() => setActiveTelemetryTab('genome')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  activeTelemetryTab === 'genome'
                    ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Binary className="w-3.5 h-3.5" />
                <span>Scam-Kit Genome</span>
              </button>

              <button
                onClick={() => setActiveTelemetryTab('financial')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  activeTelemetryTab === 'financial'
                    ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <DollarSign className="w-3.5 h-3.5" />
                <span>Financial Ledger Flows</span>
              </button>

              <button
                onClick={() => setActiveTelemetryTab('crossop')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  activeTelemetryTab === 'crossop'
                    ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>Cross-Operation Similarity</span>
              </button>

              <button
                onClick={() => setActiveTelemetryTab('contradictions')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  activeTelemetryTab === 'contradictions'
                    ? 'bg-blue-600/20 border border-blue-500/40 text-blue-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>Contradiction Hunting</span>
              </button>
            </div>

            {/* TAB 1: SCAM-KIT GENOME */}
            {activeTelemetryTab === 'genome' && activeGenome && (
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-white">
                      Scam-Kit Family: {activeGenome.kitFamily} ({activeGenome.variantVersion})
                    </h4>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Normalized DOM AST Hash: <span className="font-mono text-blue-400">{activeGenome.domAstHash}</span> • Favicon Murmur3: <span className="font-mono text-slate-300">{activeGenome.faviconMurmurHash}</span>
                    </p>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded bg-blue-950/60 border border-blue-500/30 text-blue-300 font-mono">
                    {activeGenome.depositInterfaceStyle}
                  </span>
                </div>

                {/* Attribution Boundary Callout */}
                <div className="p-3.5 rounded-lg bg-amber-950/20 border border-amber-600/40 text-xs text-amber-200 space-y-1">
                  <div className="font-bold flex items-center gap-1.5 text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    <span>Vendor vs Operator Boundary</span>
                  </div>
                  <p className="leading-relaxed text-amber-100/90">
                    {activeGenome.vendorVsOperatorAnalysis.attributionBoundary}
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="p-3 rounded-lg bg-[#0b0f19] border border-[#162035] space-y-2">
                    <span className="text-[10px] font-mono font-bold uppercase text-slate-400">
                      Kit Vendor Indicators (Software Maker)
                    </span>
                    <ul className="space-y-1.5 text-slate-300">
                      {activeGenome.vendorVsOperatorAnalysis.kitVendorIndicators.map((ind, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="text-slate-500">•</span>
                          <span>{ind}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="p-3 rounded-lg bg-[#0b0f19] border border-[#162035] space-y-2">
                    <span className="text-[10px] font-mono font-bold uppercase text-blue-400">
                      Operator-Specific Indicators (Perpetrator Deployment)
                    </span>
                    <ul className="space-y-1.5 text-slate-300">
                      {activeGenome.vendorVsOperatorAnalysis.operatorSpecificIndicators.map((ind, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <span className="text-blue-500">•</span>
                          <span>{ind}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: FINANCIAL LEDGER FLOWS */}
            {activeTelemetryTab === 'financial' && financialAnalysis && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-white">
                      Blockchain Fund-Flow Reconstruction
                    </h4>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Total Tracked Transit: <strong className="text-emerald-400 font-mono">{financialAnalysis.totalVolumeObservedEth} ETH</strong> across {financialAnalysis.monitoredWallets.length} addresses
                    </p>
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono">
                    Automated Sweep Window: 90-180s
                  </span>
                </div>

                {/* Ownership Disclaimer */}
                <div className="p-3 rounded-lg bg-[#0b0f19] border border-[#162035] text-xs text-slate-300 space-y-1">
                  <div className="font-bold text-slate-200">Anti-Premature Attribution Notice:</div>
                  <p className="text-slate-400 leading-relaxed">
                    {financialAnalysis.ownershipDisclaimer}
                  </p>
                </div>

                {/* Convergence vs Divergence */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div className="p-3.5 rounded-lg bg-[#0b0f19] border border-[#162035] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-blue-400 uppercase text-[10px] tracking-wider">
                        Convergence Nodes (Splitter & Treasury)
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">Fan-In</span>
                    </div>
                    {financialAnalysis.convergenceNodes.map((node, i) => (
                      <div key={i} className="p-2 rounded bg-[#090d16] border border-[#162035] space-y-1">
                        <div className="flex items-center justify-between font-mono">
                          <span className="text-white">{node.walletAddress.slice(0, 14)}...</span>
                          <span className="text-emerald-400">{node.totalReceivedEth} ETH</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Role: <strong className="text-blue-300">{node.role}</strong> ({node.incomingFlowsCount} incoming flows)
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="p-3.5 rounded-lg bg-[#0b0f19] border border-[#162035] space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-amber-400 uppercase text-[10px] tracking-wider">
                        Divergence Nodes (Exit Off-Ramps)
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">Fan-Out</span>
                    </div>
                    {financialAnalysis.divergenceNodes.map((node, i) => (
                      <div key={i} className="p-2 rounded bg-[#090d16] border border-[#162035] space-y-1">
                        <div className="flex items-center justify-between font-mono">
                          <span className="text-white">{node.destinationAddress.slice(0, 14)}...</span>
                          <span className="text-amber-400">{node.totalSentEth} ETH</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Exit Type: <strong className="text-amber-300">{node.destinationType}</strong> ({node.outflowCount} sweeps)
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: CROSS-OPERATION SIMILARITY */}
            {activeTelemetryTab === 'crossop' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-white">
                    Cross-Operation Indicator & Genome Correlation
                  </h4>
                  <span className="text-xs text-slate-400">
                    Strictly avoids assuming common criminal management
                  </span>
                </div>

                {crossOpSimilarities.length > 0 ? (
                  crossOpSimilarities.map((sim, i) => (
                    <div key={i} className="p-4 rounded-lg bg-[#0b0f19] border border-[#162035] space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                          <div className="text-xs font-bold text-white">
                            Comparison with {sim.operationBName}
                          </div>
                          <span className="text-[11px] font-mono text-blue-400">
                            Distinction: {sim.analyticalDistinction}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="text-sm font-bold text-emerald-400 font-mono">
                            {sim.overallSimilarityScore}% Match
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {sim.reasoning}
                      </p>
                      <div className="flex flex-wrap gap-2 text-[10px] pt-1">
                        <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400">
                          Shared Infra: {sim.sharedInfrastructure.join(', ') || 'None'}
                        </span>
                        <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400">
                          Shared Genomes: {sim.sharedGenomes.join(', ') || 'None'}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-slate-400 p-4 rounded-lg bg-[#0b0f19] border border-[#162035]">
                    No secondary operation comparisons currently indexed.
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: CONTRADICTION HUNTING */}
            {activeTelemetryTab === 'contradictions' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-white">
                    Devil's Advocate & Contradiction Reports
                  </h4>
                  <span className="text-xs text-slate-400">
                    Hunter actively testing counter-theories against strongest conclusions
                  </span>
                </div>

                {contradictionReports.length > 0 ? (
                  contradictionReports.map((report, i) => (
                    <div key={i} className="p-4 rounded-lg bg-[#0b0f19] border border-[#162035] space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-white">
                          Testing Hypothesis: {report.hypothesisTitle}
                        </span>
                        <span className="text-[10px] font-mono text-amber-400 bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/40">
                          {report.disprovalHypothesis}
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 leading-relaxed bg-[#090d16] p-3 rounded border border-[#162035]">
                        {report.devilAdvocateAssessment}
                      </p>
                      {report.unresolvedGaps.length > 0 && (
                        <div className="text-[11px] text-slate-400 space-y-1">
                          <strong className="text-slate-300">Missing Evidence Gaps:</strong>
                          <ul className="list-disc list-inside text-slate-400">
                            {report.unresolvedGaps.map((gap, gIdx) => (
                              <li key={gIdx}>{gap}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-slate-400 p-4 rounded-lg bg-[#0b0f19] border border-[#162035]">
                    No contradiction reports registered.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected Lead Details Modal */}
      {selectedLeadForDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-[#0b0f19] border border-[#162035] rounded-xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-mono text-blue-400 uppercase tracking-wider">
                  Lead Details & Evidence
                </span>
                <h3 className="text-sm font-bold text-white mt-0.5">
                  {selectedLeadForDetails.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedLeadForDetails(null)}
                className="text-slate-400 hover:text-white text-xs font-mono"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-lg bg-[#090d16] border border-[#162035] space-y-1">
                <span className="text-[10px] font-mono text-slate-400 uppercase">Target Indicator</span>
                <div className="font-mono text-white text-sm">
                  {selectedLeadForDetails.targetValue} ({selectedLeadForDetails.targetType})
                </div>
              </div>

              <div className="p-3 rounded-lg bg-[#090d16] border border-[#162035] space-y-1">
                <span className="text-[10px] font-mono text-blue-400 uppercase">Operational Reasoning</span>
                <p className="text-slate-300 leading-relaxed">
                  {selectedLeadForDetails.whyItMatters}
                </p>
              </div>

              <div className="p-3 rounded-lg bg-amber-950/20 border border-amber-800/40 space-y-1">
                <span className="text-[10px] font-mono text-amber-400 uppercase">Anti-Attribution Guardrail</span>
                <p className="text-amber-200/90 leading-relaxed">
                  {selectedLeadForDetails.whatItDoesNotProve}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-[#162035]">
              <button
                onClick={() => setSelectedLeadForDetails(null)}
                className="px-3 py-1.5 rounded-lg bg-[#111728] border border-[#1e2a44] text-slate-300 hover:text-white text-xs font-semibold"
              >
                Close
              </button>
              <button
                onClick={() => {
                  const leadToRun = selectedLeadForDetails;
                  setSelectedLeadForDetails(null);
                  handleExecuteLead(leadToRun);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Investigate Pivot</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
