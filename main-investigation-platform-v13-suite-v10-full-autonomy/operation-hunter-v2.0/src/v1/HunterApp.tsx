import React, { useEffect, useState } from 'react';
import { Hexagon, LayoutList, Sparkles, Activity, Server, Boxes, Coins, History, Share2, Scale, FileSearch, Radar, Bell, Link2, Settings, Archive, ExternalLink } from 'lucide-react';
import { api, OperationSummary } from './api';
import { useRoute, useLoad, useLive, ToastProvider, GlossaryProvider, go } from './ui';
import { OperationsPage } from './pages/OperationsPage';
import { BriefPage } from './pages/BriefPage';
import { SettingsPage } from './pages/SettingsPage';
import { InfrastructureView } from './views/InfrastructureView';
import { KitsView } from './views/KitsView';
import { MoneyView } from './views/MoneyView';
import { TimelineView } from './views/TimelineView';
import { GraphView } from './views/GraphView';
import { HypothesesView } from './views/HypothesesView';
import { EvidenceView } from './views/EvidenceView';
import { PursuitView } from './views/PursuitView';
import { MonitoringView } from './views/MonitoringView';
import { CrossOpsView } from './views/CrossOpsView';
import { EntityDrawer } from './views/EntityDrawer';
import { ModelView } from './views/ModelView';
import './suite.css';

export const VIEWS: Array<{ key: string; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { key: 'brief', label: 'Brief', icon: Sparkles },
  { key: 'model', label: 'Living model', icon: Activity },
  { key: 'infrastructure', label: 'Infrastructure', icon: Server },
  { key: 'kits', label: 'Kits & operator links', icon: Boxes },
  { key: 'money', label: 'Money', icon: Coins },
  { key: 'timeline', label: 'Timeline', icon: History },
  { key: 'graph', label: 'Graph', icon: Share2 },
  { key: 'hypotheses', label: 'Hypotheses & gaps', icon: Scale },
  { key: 'evidence', label: 'Evidence', icon: FileSearch },
  { key: 'pursuit', label: 'Pursuit & leads', icon: Radar },
  { key: 'monitoring', label: 'Monitoring', icon: Bell },
  { key: 'crossops', label: 'Related operations', icon: Link2 },
];

export interface OpContext { operationId: string; openEntity: (id: string) => void; refreshKey: number }

export function HunterApp() {
  const route = useRoute();
  const [glossary, setGlossary] = useState<Record<string, string>>({});
  const [entity, setEntity] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const ops = useLoad<OperationSummary[]>(() => api.operations(), []);
  const status = useLoad<any>(() => api.integrationStatus(), []);
  const settings = useLoad<any>(() => api.settings(), []);
  useEffect(() => { api.glossary().then(setGlossary).catch(() => undefined); }, []);
  useLive(null, () => { void ops.reload(); setRefreshKey(k => k + 1); }, 2500);

  const [section, opId, view] = route;
  const inOp = section === 'op' && opId;
  const current = inOp ? ops.data?.find(o => o.id === opId || o.code === opId) : undefined;
  const activeView = inOp ? view ?? 'brief' : null;
  const mainConnected = status.data?.configured && status.data?.connected;
  const mainUrl = status.data?.config?.url as string | undefined;
  const alerts = (ops.data ?? []).reduce((s, o) => s + (o.alerts ?? 0), 0);

  let page: React.ReactNode;
  const ctx: OpContext | null = inOp ? { operationId: current?.id ?? opId, openEntity: setEntity, refreshKey } : null;
  if (!section || section === 'operations') page = <OperationsPage ops={ops} />;
  else if (section === 'settings') page = <SettingsPage onSaved={() => { void settings.reload(); void status.reload(); }} />;
  else if (ctx) {
    switch (activeView) {
      case 'model': page = <ModelView {...ctx} />; break;
      case 'infrastructure': page = <InfrastructureView {...ctx} />; break;
      case 'kits': page = <KitsView {...ctx} />; break;
      case 'money': page = <MoneyView {...ctx} />; break;
      case 'timeline': page = <TimelineView {...ctx} />; break;
      case 'graph': page = <GraphView {...ctx} />; break;
      case 'hypotheses': page = <HypothesesView {...ctx} />; break;
      case 'evidence': page = <EvidenceView {...ctx} />; break;
      case 'pursuit': page = <PursuitView {...ctx} />; break;
      case 'monitoring': page = <MonitoringView {...ctx} />; break;
      case 'crossops': page = <CrossOpsView {...ctx} />; break;
      default: page = <BriefPage {...ctx} onChanged={() => void ops.reload()} />;
    }
  } else page = <OperationsPage ops={ops} />;

  return (
    <GlossaryProvider value={glossary}>
      <ToastProvider>
        <div className="hx">
          <div className="hx-shell">
            <aside className="hx-side">
              <a className="hx-brand" href="#/">
                <span className="hx-brand-mark"><Hexagon size={19} /></span>
                <span><b>MAIN</b><span>Operation Hunter</span></span>
              </a>
              <nav className="hx-nav">
                <div className="hx-nav-label">Workspace</div>
                <a href="#/" className={!inOp && section !== 'settings' ? 'active' : ''}><LayoutList size={17} /><span>Operations</span>{alerts > 0 ? <span className="count alert">{alerts}</span> : <span className="count">{ops.data?.length ?? 0}</span>}</a>
                {inOp && (
                  <>
                    <div className="hx-nav-label" title={current?.name}>{current?.code ?? 'Operation'}</div>
                    {VIEWS.map(v => {
                      const Icon = v.icon;
                      return <a key={v.key} href={`#/op/${current?.id ?? opId}${v.key === 'brief' ? '' : `/${v.key}`}`} className={activeView === v.key ? 'active' : ''}><Icon size={16} /><span>{v.label}</span></a>;
                    })}
                  </>
                )}
                <div className="hx-nav-label">Tools</div>
                <a href="#/settings" className={section === 'settings' ? 'active' : ''}><Settings size={17} /><span>Settings & sources</span></a>
                <a href={`#/classic${inOp ? `/${current?.id ?? opId}` : ''}`}><Archive size={17} /><span>Classic views (v0.x)</span></a>
              </nav>
              <div className="hx-side-bottom">
                <div className="hx-link-card">
                  <span className={`hx-dot ${mainConnected ? 'on' : status.data?.configured ? 'warn' : 'off'}`} />
                  <div>
                    <strong>{mainConnected ? 'Main Platform connected' : status.data?.configured ? 'Main Platform unreachable' : 'Standalone mode'}</strong>
                    {mainUrl ? <a href={mainUrl} target="_blank" rel="noreferrer" className="hx-row" style={{ gap: 4 }}>Open Main Platform <ExternalLink size={11} /></a> : <a href="#/settings">Connect in Settings</a>}
                  </div>
                </div>
              </div>
            </aside>
            <main className="hx-main">
              <header className="hx-top">
                <div className="crumbs">
                  <a href="#/">Operations</a>
                  {inOp && <><span>/</span><b>{current ? `${current.code} · ${current.name}` : opId}</b></>}
                  {section === 'settings' && <><span>/</span><b>Settings & sources</b></>}
                  {current?.isDemo && <span className="hx-chip demo">DEMO · synthetic data</span>}
                </div>
                <div className="right">
                  <span className={`hx-chip ${settings.data?.networkMode === 'offline' ? '' : 'live'}`} title="Where Hunter collects evidence from">{settings.data?.networkMode === 'offline' ? 'Offline — internal sources only' : 'Live public sources'}</span>
                  <span className="hx-chip blue">v2.0</span>
                </div>
              </header>
              {page}
            </main>
          </div>
          {entity && ctx && <EntityDrawer operationId={ctx.operationId} entityId={entity} onClose={() => setEntity(null)} onOpenEntity={setEntity} />}
        </div>
      </ToastProvider>
    </GlossaryProvider>
  );
}

export function openOperation(id: string, view?: string) {
  go(`/op/${id}${view && view !== 'brief' ? `/${view}` : ''}`);
}
