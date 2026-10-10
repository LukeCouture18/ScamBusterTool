import React, { useEffect, useState } from 'react';
import { Save, PlugZap, RefreshCw, HardDriveDownload } from 'lucide-react';
import { api } from '../api';
import { useLoad, Pill, Section, useAction, Spinner, Loading, timeAgo, Explain } from '../ui';

const KEY_INFO: Array<{ key: string; label: string; hint: string }> = [
  { key: 'urlscan', label: 'urlscan.io API key', hint: 'Optional. Raises search limits. Hunter only reads existing public scans — it never submits a scan.' },
  { key: 'trongrid', label: 'TronGrid API key', hint: 'Optional. Avoids TRON rate limiting.' },
  { key: 'hackertarget', label: 'HackerTarget API key', hint: 'Optional. Free tier allows a small number of reverse lookups per day.' },
];

export function SettingsPage({ onSaved }: { onSaved: () => void }) {
  const settings = useLoad<any>(() => api.settings(), []);
  const status = useLoad<any>(() => api.integrationStatus(), []);
  const collectors = useLoad<any[]>(() => api.collectors(), []);
  const strategy = useLoad<any[]>(() => api.strategy(), []);
  const { busy, run } = useAction();
  const [main, setMain] = useState<any>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [dns, setDns] = useState('');
  useEffect(() => {
    if (!settings.data) return;
    setMain({ url: settings.data.main.url ?? '', apiKey: settings.data.main.apiKey ?? '', sitesToken: '', hunterUrl: settings.data.main.hunterUrl ?? '', enabled: settings.data.main.enabled !== false, autoIngest: settings.data.main.autoIngest !== false, autoInvestigation: settings.data.main.autoInvestigation !== false, syncDemo: Boolean(settings.data.main.syncDemo) });
    setKeys(settings.data.apiKeys ?? {});
    setDns((settings.data.dnsServers ?? []).join(', '));
  }, [settings.data]);
  const reload = () => { void settings.reload(); void status.reload(); void collectors.reload(); onSaved(); };
  if (!settings.data || !main) return <div className="hx-page"><Loading what="Loading settings" /></div>;
  const s = settings.data;
  const st = status.data;
  const disabled = new Set<string>(s.disabledCollectors ?? []);
  const toggleCollector = (id: string) => { const next = new Set(disabled); next.has(id) ? next.delete(id) : next.add(id); void run('col', () => api.saveSettings({ disabledCollectors: [...next] })).then(reload); };
  return (
    <div className="hx-page">
      <div className="hx-heading"><div><div className="eyebrow">Operation Hunter v{s.version}</div><h1>Settings & sources</h1><p>Where Hunter collects evidence from, and how it connects to the Main Investigation Platform. Data is stored in <span className="mono">{s.dataDir}</span>.</p></div>
        <div className="hx-actions"><button className="hx-btn" disabled={busy === 'bk'} onClick={() => run('bk', () => api.backup(), (r: any) => `Backup written to ${r?.file ?? 'data/backups'}`)}><HardDriveDownload size={15} />Back up now</button></div>
      </div>

      <Section eyebrow="Suite" title="Main Investigation Platform">
        <div className="hx-card">
          <div className="hx-row" style={{ marginBottom: 12 }}>
            <span className={`hx-dot ${st?.connected ? 'on' : st?.configured ? 'warn' : 'off'}`} />
            <b>{st?.connected ? 'Connected' : st?.configured ? 'Configured but not reachable' : 'Not connected — Hunter runs standalone'}</b>
            {st?.lastHeartbeatAt && <span className="hx-small hx-muted">last contact {timeAgo(st.lastHeartbeatAt)}</span>}
            <span className="hx-spacer" />
            {st?.configured && <><button className="hx-btn small" disabled={busy === 'test'} onClick={() => run('test', () => api.testIntegration(), (r: any) => (r?.ok ? 'Connected to the Main Platform and registered as operation_hunter' : `Failed: ${r?.error ?? 'unknown error'}${r?.hint ? ` — ${r.hint}` : ''}`)).then(reload)}>{busy === 'test' ? <Spinner /> : <PlugZap size={13} />}Test</button>
              <button className="hx-btn small" disabled={busy === 'sync'} onClick={() => run('sync', () => api.syncNow(), 'Sync cycle complete').then(reload)}>{busy === 'sync' ? <Spinner /> : <RefreshCw size={13} />}Sync now</button></>}
          </div>
          {st?.lastError && <div className="hx-callout hx-small" style={{ marginBottom: 12 }}><b>Last error</b> ({timeAgo(st.lastErrorAt)}): {st.lastError}</div>}
          {s.main.lockedByEnv && <div className="hx-small hx-muted" style={{ marginBottom: 10 }}>The URL is set by the MAIN_PLATFORM_URL environment variable.</div>}
          <div className="hx-grid cols-2">
            <div className="hx-field"><label>Main Platform URL</label><input className="hx-input" value={main.url} disabled={s.main.lockedByEnv} placeholder="http://localhost:8787" onChange={e => setMain({ ...main, url: e.target.value })} /></div>
            <div className="hx-field"><label>Module API key</label><input className="hx-input" value={main.apiKey} placeholder="the operation_hunter key in Main's MODULE_API_KEYS" onChange={e => setMain({ ...main, apiKey: e.target.value })} /><span className="hint">Main issues one key per module. Shown masked once saved.</span></div>
            <div className="hx-field"><label>Hunter address (as Main should link to it)</label><input className="hx-input" value={main.hunterUrl} placeholder="http://localhost:3000" onChange={e => setMain({ ...main, hunterUrl: e.target.value })} /></div>
            <div className="hx-field"><label>Site-check token (optional)</label><input className="hx-input" value={main.sitesToken} placeholder={s.main.sitesTokenSet ? 'set — leave blank to keep' : 'lets Hunter request site checks'} onChange={e => setMain({ ...main, sitesToken: e.target.value })} /></div>
          </div>
          <div className="hx-row" style={{ gap: 18, flexWrap: 'wrap', marginTop: 4 }}>
            <label className="hx-small hx-row"><input type="checkbox" checked={main.enabled} onChange={e => setMain({ ...main, enabled: e.target.checked })} />Integration enabled</label>
            <label className="hx-small hx-row"><input type="checkbox" checked={main.autoIngest} onChange={e => setMain({ ...main, autoIngest: e.target.checked })} />Share findings as evidence on linked investigations</label>
            <label className="hx-small hx-row"><input type="checkbox" checked={main.autoInvestigation} onChange={e => setMain({ ...main, autoInvestigation: e.target.checked })} />Give each reconstructed operation (2+ member sites) its own Main investigation</label>
            <label className="hx-small hx-row"><input type="checkbox" checked={main.syncDemo} onChange={e => setMain({ ...main, syncDemo: e.target.checked })} />Also sync demo operations</label>
            <span className="hx-spacer" />
            <button className="hx-btn primary" disabled={busy === 'main'} onClick={() => { const patch: any = { ...main }; if (!patch.sitesToken) delete patch.sitesToken; void run('main', () => api.saveSettings({ main: patch }), 'Saved — connecting…').then(reload); }}><Save size={15} />Save connection</button>
          </div>
          {st?.configured && (
            <div className="hx-grid cols-4" style={{ marginTop: 14 }}>
              <div className="hx-stat"><span>Syncs delivered</span><b>{st.syncsDelivered}</b></div>
              <div className="hx-stat"><span>Jobs handled</span><b>{st.jobsHandled}</b></div>
              <div className="hx-stat"><span>Events processed</span><b>{st.eventsProcessed}</b></div>
              <div className="hx-stat"><span>Outbox</span><b>{st.outbox?.pending ?? 0}</b><span style={{ textTransform: 'none', letterSpacing: 0 }}>pending · {st.outbox?.dead ?? 0} failed</span></div>
            </div>
          )}
        </div>
      </Section>

      <Section eyebrow="Collection" title="Network">
        <div className="hx-card">
          <div className="hx-row" style={{ gap: 18, flexWrap: 'wrap' }}>
            <label className="hx-row"><input type="radio" checked={s.networkMode !== 'offline'} disabled={s.networkModeLockedByEnv} onChange={() => run('net', () => api.saveSettings({ networkMode: 'live' }), 'Live public sources enabled').then(reload)} /><b>Live</b><span className="hx-small hx-muted">query public sources</span></label>
            <label className="hx-row"><input type="radio" checked={s.networkMode === 'offline'} disabled={s.networkModeLockedByEnv} onChange={() => run('net', () => api.saveSettings({ networkMode: 'offline' }), 'Offline mode').then(reload)} /><b>Offline</b><span className="hx-small hx-muted">internal data, cache and Main Platform only</span></label>
            {s.networkModeLockedByEnv && <Pill tone="amber">set by HUNTER_NETWORK_MODE</Pill>}
          </div>
          <div className="hx-grid cols-2" style={{ marginTop: 12 }}>
            <div className="hx-field"><label>DNS servers (optional)</label><input className="hx-input" value={dns} placeholder="system default" onChange={e => setDns(e.target.value)} onBlur={() => void run('dns', () => api.saveSettings({ dnsServers: dns.split(/[\s,]+/).filter(Boolean) })).then(reload)} /></div>
          </div>
          {KEY_INFO.map(k => (
            <div className="hx-field" key={k.key}><label>{k.label}</label>
              <div className="hx-row"><input className="hx-input" style={{ maxWidth: 420 }} value={keys[k.key] ?? ''} onChange={e => setKeys({ ...keys, [k.key]: e.target.value })} />
                <button className="hx-btn small" onClick={() => run('key', () => api.saveSettings({ apiKeys: { [k.key]: keys[k.key] ?? '' } }), 'Saved').then(reload)}>Save</button></div>
              <span className="hint">{k.hint}</span></div>
          ))}
        </div>
      </Section>

      <Section eyebrow="Sources" title="Collectors">
        <Explain>All collectors are passive: they read public records or data that already exists. Nothing logs in, submits forms, triggers scans, or interacts with a suspect site. Switch off any source you don't want used.</Explain>
        <div className="hx-card" style={{ padding: 0 }}>
          <table className="hx-table">
            <thead><tr><th>Source</th><th>What it provides</th><th>Status</th><th>Use</th></tr></thead>
            <tbody>{(collectors.data ?? []).map(c => (
              <tr key={c.id}>
                <td><b>{c.name}</b><div className="hx-faint hx-small">{c.kind.replace('_', ' ')}</div></td>
                <td className="hx-small">{c.description}</td>
                <td>{c.available ? <Pill tone="green">available</Pill> : <><Pill tone={disabled.has(c.id) ? '' : 'amber'}>unavailable</Pill><div className="hx-faint hx-small">{c.reason}</div></>}</td>
                <td><input type="checkbox" checked={!disabled.has(c.id)} onChange={() => toggleCollector(c.id)} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Section>

      <Section eyebrow="Learning" title="What has worked">
        <div className="hx-card" style={{ padding: 0 }}>
          <table className="hx-table">
            <thead><tr><th>Lookup</th><th>On</th><th>Attempts</th><th>Success rate</th><th>Expected new indicators</th><th>Your feedback</th></tr></thead>
            <tbody>{(strategy.data ?? []).slice(0, 40).map(r => (
              <tr key={`${r.pivotType}:${r.entityType}`}><td className="hx-small">{r.pivotType}</td><td className="hx-small">{r.entityType}</td><td>{r.attempts}</td><td>{Math.round(r.successProbability * 100)}%</td><td>{r.expectedGain}</td><td className="hx-small">{r.analystPositive ? `+${r.analystPositive}` : ''} {r.analystNegative ? `−${r.analystNegative}` : ''}</td></tr>
            ))}
              {!strategy.data?.length && <tr><td colSpan={6} className="hx-muted">Hunter learns which lookups pay off as it runs pursuits.</td></tr>}</tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
