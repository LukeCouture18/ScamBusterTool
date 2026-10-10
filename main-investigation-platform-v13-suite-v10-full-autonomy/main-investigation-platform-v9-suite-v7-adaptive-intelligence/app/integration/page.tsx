import { ArrowRight, CheckCircle2, CloudUpload, Code2, FileUp, Fingerprint, GitMerge, KeyRound, ShieldCheck } from "lucide-react";

const payload = `{
  "schema_version": "1.1",
  "batch_id": "sf-run-2026-09-18T14:30:00Z",
  "sent_at": "2026-09-18T14:30:00Z",
  "records": {
    "investigations": [{ "external_id": "case-1042", "title": "Example network", "status": "open", "priority": "high", "provenance": { "run_id": "run-81" } }],
    "sites": [{
      "external_id": "site-93", "investigation_id": "case-1042",
      "canonical_key": "example.com", "display_name": "example.com",
      "url": "https://example.com", "confidence": 0.94,
      "classification": "payment-site", "observed_at": "2026-09-18T14:29:51Z",
      "provenance": { "method": "search-result", "query": "example" }
    }],
    "related_sites": [], "pages": [], "deposit_pages": [],
    "wallets": [], "deposit_options": [], "transactions": [],
    "counterparties": [], "tokens": [], "networks": [],
    "infrastructure_indicators": [], "relationships": [], "evidence": [],
    "discovery_paths": [], "findings": [], "notes": [],
    "module_activity": [{ "external_id": "run-81-status", "status": "success", "message": "Crawl completed", "metrics": { "sites_found": 1 }, "observed_at": "2026-09-18T14:30:00Z" }]
  }
}`;
const modules = [["Site Finder", "site_finder", "Sites, related sites, discovery paths"], ["Site Investigator", "site_investigator", "Pages, deposit pages, evidence, findings"], ["CryptoWalletLogger", "crypto_wallet_logger", "Wallets, deposit options, transactions"], ["Wallet Investigator", "wallet_investigator", "Counterparties, relationships, classifications"]];
const eventPayload=`{
  "source_module": "site_investigator",
  "events": [{
    "event_id": "si-run-81:wallet:bc1q-example:validated",
    "event_type": "wallet.validated",
    "schema_version": "1.0",
    "correlation_id": "case-1042:run-81",
    "investigation_id": "case-1042",
    "occurred_at": "2026-09-18T14:30:00Z",
    "provenance": { "run_id": "run-81", "method": "deposit-page" },
    "payload": { "canonical_key": "bitcoin:bc1q-example", "confidence": 0.96 }
  }]
}`;

export default function IntegrationPage() { return <div className="page-wrap integration-page"><section className="page-heading"><div><p>DEVELOPER / API</p><h1>Connect your investigation tools</h1><span>Register capabilities, publish durable events, and keep existing ingestion clients working unchanged.</span></div><span className="api-version"><CheckCircle2 size={15}/> v4 event API ready</span></section><section className="integration-layout"><div className="docs-main">
  <article className="panel quickstart"><div className="step-number">01</div><div><p>AUTHENTICATION</p><h2>Use the module&apos;s own API key</h2><span>Each tool gets a separate credential. Because this deployment is private, unattended hosted clients also send a Sites bypass token.</span><pre><code>{`X-API-Key: YOUR_MODULE_API_KEY\nOAI-Sites-Authorization: Bearer YOUR_SITES_BYPASS_TOKEN\n# Authorization: Bearer YOUR_MODULE_API_KEY is also accepted`}</code></pre></div><KeyRound size={20}/></article>
  <article className="panel"><div className="panel-head"><div><p>MODULE ENDPOINTS</p><h2>One endpoint per standalone tool</h2></div><CloudUpload size={20}/></div><div className="endpoint-list">{modules.map(([name, slug, description]) => <div className="endpoint-row" key={slug}><span>POST</span><code>/api/v1/ingest/{slug}</code><div><strong>{name}</strong><small>{description}</small></div><ArrowRight size={16}/></div>)}</div></article>
  <article className="panel payload-panel"><div className="panel-head"><div><p>V4 EVENT API</p><h2>Publish directly to the routing backbone</h2></div><GitMerge size={20}/></div><pre className="large-code"><code>{eventPayload}</code></pre></article>
  <article className="panel payload-panel"><div className="panel-head"><div><p>CANONICAL ENVELOPE</p><h2>JSON batch example</h2></div><Code2 size={20}/></div><pre className="large-code"><code>{payload}</code></pre></article>
  <article className="panel"><div className="panel-head"><div><p>COORDINATION LOOP</p><h2>Register, react, and report</h2></div><GitMerge size={20}/></div><pre><code>{`POST /api/v1/modules/{module}/register\nPOST /api/v1/modules/{module}/heartbeat\nPOST /api/v1/events\nPOST /api/v1/modules/{module}/jobs/claim\nPOST /api/v1/ingest/{module}  # compatibility path\nPATCH /api/v1/modules/{module}/jobs/{job_id}\n\n{ "action": "complete", "result": { "records_written": 12 } }`}</code></pre></article>
  <article className="panel upload-panel"><div className="panel-head"><div><p>BINARY EVIDENCE</p><h2>Upload screenshots and files</h2></div><FileUp size={20}/></div><p>Use multipart form data for file bytes. The response returns a stable evidence ID, object key, SHA-256 hash, and size.</p><pre><code>{`curl -X POST "$BASE_URL/api/v1/evidence/upload" -H "X-API-Key: $INGEST_API_KEY" -F "source_module=site_investigator" -F "external_id=screenshot-001" -F "evidence_type=screenshot" -F "title=Deposit page" -F "file=@deposit-page.png"`}</code></pre></article>
  </div><aside className="docs-aside"><article className="panel sticky-card"><p>INGESTION CONTRACT</p><h2>Required on every batch</h2><ul><li><Fingerprint/>Stable <code>external_id</code> per source record</li><li><GitMerge/>Unique <code>batch_id</code> for idempotency</li><li><ShieldCheck/>Evidence IDs on v1.1 relationships</li><li><Code2/><code>schema_version</code> set to 1.1</li><li><CloudUpload/>UTC timestamps with timezone</li></ul></article><article className="panel behavior-card"><p>MERGE BEHAVIOR</p><h2>Safe by source</h2><div><strong>Same module + record type + ID</strong><span>Updates only that module’s observation.</span></div><div><strong>One malformed record</strong><span>Valid records commit; the invalid one is quarantined.</span></div><div><strong>Matching canonical key</strong><span>Links observations to one shared entity.</span></div><div><strong>Other module evidence</strong><span>Never overwritten or deleted.</span></div></article><article className="panel response-card"><p>RESPONSES</p><div><span><b>202</b> Accepted or partial</span><span><b>200</b> Idempotent replay</span><span><b>400</b> Envelope error</span><span><b>401</b> Missing or invalid key</span><span><b>429</b> Retry with backoff</span></div></article></aside></section></div>; }
