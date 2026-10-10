import { z } from "zod";
import { getD1, json, now, sha256, type SourceModule } from "./platform";
import { normalizeCanonicalKey } from "./domain.mjs";
import { detectClassificationConflict, timeline, notify } from "./orchestrator";
import { publishEvent, type EventType } from "./events";
import { discoverOverlaps,evaluateEvidence } from "./intelligence";
import { snapshotMonitored } from "./monitoring";
import { upsertFromFinder } from "./inbox";

const isoDate = z.string().datetime({ offset: true }).optional();
const baseRecord = z.object({
  external_id: z.string().min(1).max(240),
  investigation_id: z.string().min(1).max(240).optional(),
  canonical_key: z.string().min(1).max(2048).optional(),
  display_name: z.string().min(1).max(500).optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  classification: z.string().max(120).optional(),
  observed_at: isoDate,
  provenance: z.record(z.string(), z.unknown()).default({}),
}).passthrough();
const siteRecord = baseRecord.extend({ triage: z.object({
  outcome: z.enum(["observed", "triaged", "promoted", "dismissed", "inconclusive"]),
  request_downstream: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  indicator_categories: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string().min(1).max(240)).default([]),
  method: z.string().max(240),
}).strict().optional() });

const investigationRecord = baseRecord.extend({ title: z.string().min(1).max(500), status: z.string().max(80).default("open"), priority: z.string().max(80).default("normal") });
const relationshipRecord = baseRecord.extend({
  relationship_type: z.string().min(1).max(160),
  from: z.object({ entity_type: z.string().min(1), canonical_key: z.string().min(1), network: z.string().optional() }),
  to: z.object({ entity_type: z.string().min(1), canonical_key: z.string().min(1), network: z.string().optional() }),
  assertion_kind: z.enum(["observed", "blockchain_fact", "derived"]).default("observed"),
  evidence_ids: z.array(z.string().min(1).max(240)).default([]),
}).superRefine((value,ctx)=>{if(value.assertion_kind==="derived"&&value.evidence_ids.length===0)ctx.addIssue({code:z.ZodIssueCode.custom,message:"Derived relationships require at least one evidence_id",path:["evidence_ids"]});});
const evidenceRecord = baseRecord.extend({ evidence_type: z.string().min(1), evidence_class: z.enum(["observed_website","blockchain_fact","derived_observation","analyst_note"]).default("observed_website"), observation_scope: z.enum(["public","authenticated"]).default("public"), context_text: z.string().max(100000).default(""), title: z.string().min(1), entity: z.object({ entity_type: z.string(), canonical_key: z.string(), network: z.string().optional() }).optional() });
const pathRecord = baseRecord.extend({ steps: z.array(z.record(z.string(), z.unknown())).min(1) });
const findingRecord = baseRecord.extend({ title: z.string().min(1), body: z.string().min(1), finding_type: z.string().default("note"), entity: z.object({ entity_type: z.string(), canonical_key: z.string(), network: z.string().optional() }).optional() });
const activityRecord = baseRecord.extend({ status: z.enum(["idle", "running", "success", "warning", "error", "offline"]), message: z.string().default(""), metrics: z.record(z.string(), z.unknown()).default({}) });
const noteRecord = baseRecord.extend({ title: z.string().min(1), body: z.string().min(1), note_kind: z.enum(["analyst_note","conclusion","review"]).default("analyst_note"), entity: z.object({ entity_type: z.string(), canonical_key: z.string(), network: z.string().optional() }).optional() });

export const ingestSchema = z.object({
  schema_version: z.enum(["1.0","1.1","3.0"]), batch_id: z.string().min(1).max(240), sent_at: z.string().datetime({ offset: true }), origin_job_id: z.string().uuid().nullish(),
  records: z.object({
    investigations: z.array(investigationRecord).default([]), sites: z.array(siteRecord).default([]), related_sites: z.array(baseRecord).default([]),
    pages: z.array(baseRecord).default([]), deposit_pages: z.array(baseRecord).default([]), wallets: z.array(baseRecord).default([]),
    deposit_options: z.array(baseRecord).default([]), transactions: z.array(baseRecord).default([]), counterparties: z.array(baseRecord).default([]),
    tokens: z.array(baseRecord).default([]), networks: z.array(baseRecord).default([]), infrastructure_indicators: z.array(baseRecord).default([]),
    relationships: z.array(relationshipRecord).default([]), evidence: z.array(evidenceRecord).default([]), discovery_paths: z.array(pathRecord).default([]),
    findings: z.array(findingRecord).default([]), notes: z.array(noteRecord).default([]), module_activity: z.array(activityRecord).default([]),
  }).strict(),
}).strict().superRefine((value, ctx) => { const count=Object.values(value.records).reduce((sum,rows)=>sum+rows.length,0); if(count>1000)ctx.addIssue({code:z.ZodIssueCode.custom,message:"A batch may contain at most 1000 records",path:["records"]}); if(value.schema_version!=="1.0")value.records.relationships.forEach((relationship,index)=>{if(relationship.evidence_ids.length===0)ctx.addIssue({code:z.ZodIssueCode.custom,message:"Relationships require supporting evidence_ids",path:["records","relationships",index,"evidence_ids"]});});if(value.schema_version==="3.0")value.records.transactions.forEach((transaction,index)=>{for(const field of ["amount","value","balance","fee"]){if(typeof (transaction as Record<string,unknown>)[field]==="number")ctx.addIssue({code:z.ZodIssueCode.custom,message:`${field} must be a decimal string to preserve precision`,path:["records","transactions",index,field]});}}); });

type Payload = z.infer<typeof ingestSchema>;
type GenericRecord = z.infer<typeof baseRecord>;
export type RejectedInput = { recordType: string; row: unknown; message: string };

const recordParsers = {
  investigations: investigationRecord, sites: siteRecord, related_sites: baseRecord,
  pages: baseRecord, deposit_pages: baseRecord, wallets: baseRecord,
  deposit_options: baseRecord, transactions: baseRecord, counterparties: baseRecord,
  tokens: baseRecord, networks: baseRecord, infrastructure_indicators: baseRecord,
  relationships: relationshipRecord, evidence: evidenceRecord, discovery_paths: pathRecord,
  findings: findingRecord, notes: noteRecord, module_activity: activityRecord,
} as const;

const envelopeSchema = z.object({
  schema_version: z.enum(["1.0", "1.1", "3.0"]),
  batch_id: z.string().min(1).max(240),
  sent_at: z.string().datetime({ offset: true }),
  origin_job_id: z.string().uuid().nullish(),
  records: z.record(z.string(), z.array(z.unknown())),
}).strict();

/** Validates the envelope atomically, then validates each record independently. */
export function parseIngestRequest(raw: unknown): { payload: Payload; rejected: RejectedInput[] } {
  const envelope = envelopeSchema.parse(raw);
  const total = Object.values(envelope.records).reduce((sum, rows) => sum + rows.length, 0);
  if (total > 1000) throw new z.ZodError([{ code: "custom", message: "A batch may contain at most 1000 records", path: ["records"] }]);
  const records: Record<string, unknown[]> = {};
  const rejected: RejectedInput[] = [];
  for (const [recordType, parser] of Object.entries(recordParsers)) {
    const accepted: unknown[] = [];
    for (const row of envelope.records[recordType] ?? []) {
      const parsed = (recordType === "sites" && envelope.schema_version !== "3.0" ? baseRecord : parser).safeParse(row);
      if (!parsed.success) rejected.push({ recordType, row, message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`).join("; ") });
      else if (recordType === "relationships" && envelope.schema_version !== "1.0" && (parsed.data as z.infer<typeof relationshipRecord>).evidence_ids.length === 0) rejected.push({ recordType, row, message: "Relationships require supporting evidence_ids" });
      else if(recordType==="transactions"&&envelope.schema_version==="3.0"&&["amount","value","balance","fee"].some(field=>typeof (parsed.data as Record<string,unknown>)[field]==="number"))rejected.push({recordType,row,message:"Financial amounts must be decimal strings in schema 3.0"});
      else accepted.push(parsed.data);
    }
    records[recordType] = accepted;
  }
  for (const [recordType, rows] of Object.entries(envelope.records)) {
    if (recordType in recordParsers) continue;
    for (const row of rows) rejected.push({ recordType, row, message: `Unsupported record collection: ${recordType}` });
  }
  return { payload: { ...envelope, records } as Payload, rejected };
}

function entityKey(type: string, record: GenericRecord) {
  return normalizeCanonicalKey(type, record as Record<string, unknown>);
}
function displayName(type: string, record: GenericRecord) {
  const raw = record as Record<string, unknown>;
  return record.display_name ?? String(raw.name ?? raw.domain ?? raw.url ?? raw.address ?? raw.tx_hash ?? `${type}:${record.external_id}`);
}

async function resolveInvestigation(db: D1Database, externalId?: string) {
  if (!externalId) return null;
  // Platform-created jobs carry the canonical internal investigation id,
  // while module-originated records may still carry the stable external id.
  // Both identify the same canonical context and must resolve before evidence
  // is persisted; otherwise a successful worker result becomes orphaned.
  return (await db.prepare("SELECT id FROM investigations WHERE id = ? OR external_id = ? LIMIT 1").bind(externalId, externalId).first<{ id: string }>())?.id ?? null;
}

async function ensureEntity(db: D1Database, type: string, key: string, name: string, investigationId: string | null, data: unknown, confidence = 0, classification?: string) {
  const existing = await db.prepare("SELECT id, max_confidence FROM entities WHERE entity_type = ? AND canonical_key = ?").bind(type, key).first<{ id: string; max_confidence: number }>();
  if (existing) {
    await db.prepare("UPDATE entities SET display_name = CASE WHEN ? >= max_confidence THEN ? ELSE display_name END, canonical_data = CASE WHEN ? >= max_confidence THEN ? ELSE canonical_data END, classification = CASE WHEN ? >= max_confidence THEN COALESCE(?, classification) ELSE classification END, max_confidence = MAX(max_confidence, ?), investigation_id = COALESCE(investigation_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(confidence, name, confidence, json(data), confidence, classification ?? null, confidence, investigationId, existing.id).run();
    return { id: existing.id, created: false };
  }
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO entities (id, investigation_id, entity_type, canonical_key, display_name, canonical_data, max_confidence, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, investigationId, type, key, name, json(data), confidence, classification ?? null).run();
  return { id, created: true };
}

async function linkInvestigationEntity(db: D1Database, investigationId: string | null, entityId: string, module: SourceModule, record: GenericRecord, schemaVersion: string) {
  if (!investigationId) return;
  await db.prepare("INSERT INTO investigation_entities (id, investigation_id, entity_id, role, source_module, source_record_id, confidence, provenance, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(investigation_id, entity_id, source_module) DO UPDATE SET role=excluded.role, source_record_id=excluded.source_record_id, confidence=MAX(investigation_entities.confidence, excluded.confidence), provenance=excluded.provenance, last_seen_at=CURRENT_TIMESTAMP")
    .bind(crypto.randomUUID(), investigationId, entityId, String((record as Record<string, unknown>).investigation_role ?? "subject"), module, record.external_id, record.confidence, json(record.provenance), schemaVersion).run();
}

async function upsertObservation(db: D1Database, module: SourceModule, schemaVersion: string, type: string, record: GenericRecord) {
  const investigationId = await resolveInvestigation(db, record.investigation_id);
  const entity = await ensureEntity(db, type, entityKey(type, record), displayName(type, record), investigationId, record, record.confidence, record.classification);
  await linkInvestigationEntity(db, investigationId, entity.id, module, record, schemaVersion);
  await db.prepare("INSERT OR IGNORE INTO entity_aliases (id,entity_id,alias_type,alias_value,source_module,confidence) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),entity.id,`${type}_external_id`,record.external_id,module,record.confidence).run();
  if(record.display_name)await db.prepare("INSERT OR IGNORE INTO entity_aliases (id,entity_id,alias_type,alias_value,source_module,confidence) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),entity.id,`${type}_display_name`,record.display_name,module,record.confidence).run();
  const data = json(record); const contentHash = await sha256(data); const observedAt = record.observed_at ?? now();
  const current = await db.prepare("SELECT id, content_hash FROM observations WHERE source_module = ? AND record_type = ? AND source_record_id = ?").bind(module, type, record.external_id).first<{ id: string; content_hash: string }>();
  if (current?.content_hash === contentHash) {
    await db.prepare("UPDATE observations SET last_received_at = CURRENT_TIMESTAMP WHERE id = ?").bind(current.id).run();
    return { status:"duplicate" as const, entityId:entity.id, observationId:current.id, canonicalKey:entityKey(type,record), contentHash };
  }
  const observationId=current?.id??crypto.randomUUID();
  if (current) {
    await db.prepare("UPDATE observations SET entity_id = ?, schema_version = ?, confidence = ?, classification = ?, data = ?, provenance = ?, content_hash = ?, observed_at = ?, last_received_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(entity.id, schemaVersion, record.confidence, record.classification ?? null, data, json(record.provenance), contentHash, observedAt, current.id).run();
    await db.prepare("INSERT OR IGNORE INTO observation_versions (id,observation_id,entity_id,source_module,record_type,source_record_id,schema_version,confidence,classification,data,provenance,content_hash,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),observationId,entity.id,module,type,record.external_id,schemaVersion,record.confidence,record.classification??null,data,json(record.provenance),contentHash,observedAt).run();
    return { status:"updated" as const, entityId:entity.id, observationId, canonicalKey:entityKey(type,record), contentHash };
  }
  await db.prepare("INSERT INTO observations (id, entity_id, source_module, record_type, source_record_id, schema_version, confidence, classification, data, provenance, content_hash, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(observationId, entity.id, module, type, record.external_id, schemaVersion, record.confidence, record.classification ?? null, data, json(record.provenance), contentHash, observedAt).run();
  await db.prepare("INSERT OR IGNORE INTO observation_versions (id,observation_id,entity_id,source_module,record_type,source_record_id,schema_version,confidence,classification,data,provenance,content_hash,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),observationId,entity.id,module,type,record.external_id,schemaVersion,record.confidence,record.classification??null,data,json(record.provenance),contentHash,observedAt).run();
  return { status:"inserted" as const, entityId:entity.id, observationId, canonicalKey:entityKey(type,record), contentHash };
}

async function recordFailure(db:D1Database,module:SourceModule,batchId:string,recordType:string,row:unknown,error:unknown){const message=error instanceof Error?error.message:"Unknown error";const sourceRecordId=typeof row==="object"&&row&&"external_id" in row?String((row as {external_id:unknown}).external_id):null;await db.prepare("INSERT INTO dead_letters (id,source_module,batch_id,record_type,source_record_id,payload,error_code,error_message,next_retry_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),module,batchId,recordType,sourceRecordId,json(row),"RECORD_REJECTED",message,new Date(Date.now()+15000).toISOString()).run();return{record:`${recordType}:${sourceRecordId??"unknown"}`,message};}

export async function ingest(module: SourceModule, payload: Payload, preRejected: RejectedInput[] = []) {
  const db = getD1();
  if(payload.origin_job_id){const origin=await db.prepare("SELECT id,target_module,status FROM jobs WHERE id=?").bind(payload.origin_job_id).first<{id:string;target_module:string;status:string}>();if(!origin||origin.target_module!==module)throw new Error("Origin job is missing or belongs to another module");}
  const replay = await db.prepare("SELECT status, received_count, inserted_count, updated_count, duplicate_count, error_count, errors FROM ingestion_batches WHERE source_module = ? AND batch_id = ?")
    .bind(module, payload.batch_id).first<Record<string, unknown>>();
  if (replay) return { ...replay, errors: typeof replay.errors === "string" ? JSON.parse(replay.errors) : replay.errors, batch_id: payload.batch_id, replayed: true };

  const arrays = Object.values(payload.records); const received = arrays.reduce((sum, rows) => sum + rows.length, 0) + preRejected.length; const batchRowId = crypto.randomUUID();
  await db.prepare("INSERT INTO ingestion_batches (id, source_module, batch_id, schema_version, status, received_count, request_id, origin_job_id) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)")
    .bind(batchRowId, module, payload.batch_id, payload.schema_version, received, crypto.randomUUID(), payload.origin_job_id??null).run();
  let inserted = 0, updated = 0, duplicate = 0; const errors: Array<{ record: string; message: string }> = [];
  for (const rejected of preRejected) errors.push(await recordFailure(db, module, payload.batch_id, rejected.recordType, rejected.row, new Error(rejected.message)));
  const count = (result: { status: "inserted" | "updated" | "duplicate" }) => { if (result.status === "inserted") inserted++; else if (result.status === "updated") updated++; else duplicate++; };

  for (const inv of payload.records.investigations) {
    try {
      const existing = await db.prepare("SELECT id FROM investigations WHERE external_id = ?").bind(inv.external_id).first<{ id: string }>();
      const investigationId=existing?.id??crypto.randomUUID();
      const profileId=String((inv as Record<string,unknown>).profile_id??(inv.priority==="high"?"deep-investigation":inv.priority==="low"?"quick-triage":"standard-investigation"));
      if (existing) { await db.prepare("UPDATE investigations SET title = ?, status = ?, priority = ?, description = ?, automation_profile_id=?, schema_version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(inv.title, inv.status, inv.priority, String((inv as Record<string, unknown>).description ?? ""),profileId, payload.schema_version, existing.id).run(); updated++; }
      else { await db.prepare("INSERT INTO investigations (id, external_id, title, status, priority, description, automation_profile_id, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(investigationId, inv.external_id, inv.title, inv.status, inv.priority, String((inv as Record<string, unknown>).description ?? ""),profileId, payload.schema_version).run(); inserted++; }
      await db.prepare("INSERT INTO investigation_observations (id,investigation_id,source_module,source_record_id,confidence,classification,data,provenance,schema_version,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_module,source_record_id) DO UPDATE SET data=excluded.data,confidence=excluded.confidence,classification=excluded.classification,provenance=excluded.provenance,schema_version=excluded.schema_version,observed_at=excluded.observed_at,last_received_at=CURRENT_TIMESTAMP").bind(crypto.randomUUID(),investigationId,module,inv.external_id,inv.confidence,inv.classification??null,json(inv),json(inv.provenance),payload.schema_version,inv.observed_at??now()).run();
    } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,"investigation",inv,error)); }
  }

  const groups: Array<[string, GenericRecord[]]> = [["site", payload.records.sites], ["related_site", payload.records.related_sites], ["page", payload.records.pages], ["deposit_page", payload.records.deposit_pages], ["wallet", payload.records.wallets], ["deposit_option", payload.records.deposit_options], ["token", payload.records.tokens], ["network", payload.records.networks], ["transaction", payload.records.transactions], ["counterparty", payload.records.counterparties], ["infrastructure_indicator", payload.records.infrastructure_indicators]];
  for (const [type, rows] of groups) for (const row of rows) try {
    const result=await upsertObservation(db, module, payload.schema_version, type, row); count(result);
    await discoverOverlaps(result.entityId);
    const investigationId=await resolveInvestigation(db,row.investigation_id);
    if(investigationId&&result.status!=="duplicate")await snapshotMonitored(investigationId,result.entityId);
    if(result.status!=="duplicate"&&(type==="site"||type==="related_site"||type==="wallet")){
      const eventType:EventType=type==="wallet"?"wallet.observed":module==="site_investigator"?"site.investigated":"site.discovered";
      await publishEvent(module,{event_id:`ingest:${module}:${type}:${row.external_id}:${result.contentHash}`,event_type:eventType,schema_version:payload.schema_version==="3.0"?"3.0":"1.0",correlation_id:payload.origin_job_id??payload.batch_id,investigation_id:investigationId??undefined,entity_id:result.entityId,occurred_at:row.observed_at??now(),provenance:{...row.provenance,adapter:"legacy-ingestion",batch_id:payload.batch_id,observation_id:result.observationId},payload:{canonical_key:result.canonicalKey,confidence:row.confidence,classification:row.classification,priority:(row as Record<string,unknown>).priority,validated:(row as Record<string,unknown>).validated,source_record_id:row.external_id},hop_count:0});
    }
    await detectClassificationConflict({investigationId,entityId:result.entityId,module,classification:row.classification,confidence:row.confidence});
  } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,type,row,error)); }

  for (const row of payload.records.relationships) try {
    const investigationId = await resolveInvestigation(db, row.investigation_id); const from = await ensureEntity(db, row.from.entity_type, normalizeCanonicalKey(row.from.entity_type,{canonical_key:row.from.canonical_key,network:row.from.network}), row.from.canonical_key, investigationId, {}, 0); const to = await ensureEntity(db, row.to.entity_type, normalizeCanonicalKey(row.to.entity_type,{canonical_key:row.to.canonical_key,network:row.to.network}), row.to.canonical_key, investigationId, {}, 0);
    const current = await db.prepare("SELECT id FROM relationships WHERE source_module = ? AND source_record_id = ?").bind(module, row.external_id).first<{ id: string }>();
    const relationshipId=current?.id??crypto.randomUUID();
    if (current) { await db.prepare("UPDATE relationships SET source_entity_id = ?, target_entity_id = ?, relationship_type = ?, assertion_kind = ?, confidence = ?, provenance = ?, observed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(from.id, to.id, row.relationship_type, row.assertion_kind, row.confidence, json(row.provenance), row.observed_at ?? now(), current.id).run(); updated++; }
    else { await db.prepare("INSERT INTO relationships (id, investigation_id, source_entity_id, target_entity_id, relationship_type, assertion_kind, source_module, source_record_id, confidence, provenance, schema_version, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(relationshipId, investigationId, from.id, to.id, row.relationship_type, row.assertion_kind, module, row.external_id, row.confidence, json(row.provenance), payload.schema_version, row.observed_at ?? now()).run(); inserted++; }
    const relationshipData=json(row);const relationshipHash=await sha256(relationshipData);const version=await db.prepare("INSERT OR IGNORE INTO relationship_versions (id,relationship_id,source_module,content_hash,data,observed_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),relationshipId,module,relationshipHash,relationshipData,row.observed_at??now()).run();
    if((version.meta?.changes??0)===1)await publishEvent(module,{event_id:`ingest:${module}:relationship:${row.external_id}:${relationshipHash}`,event_type:"relationship.discovered",schema_version:"1.0",correlation_id:payload.origin_job_id??payload.batch_id,investigation_id:investigationId??undefined,entity_id:from.id,occurred_at:row.observed_at??now(),provenance:{...row.provenance,adapter:"legacy-ingestion",batch_id:payload.batch_id,relationship_id:relationshipId},payload:{relationship_type:row.relationship_type,assertion_kind:row.assertion_kind,confidence:row.confidence,source_entity_id:from.id,target_entity_id:to.id,evidence_ids:row.evidence_ids},hop_count:0});
    for(const evidenceExternalId of row.evidence_ids){const evidenceRow=await db.prepare("SELECT id FROM evidence WHERE source_module=? AND source_record_id=?").bind(module,evidenceExternalId).first<{id:string}>();if(evidenceRow)await db.prepare("INSERT OR IGNORE INTO relationship_evidence (id,relationship_id,evidence_id,source_module) VALUES (?,?,?,?)").bind(crypto.randomUUID(),relationshipId,evidenceRow.id,module).run();}
    if(investigationId){await snapshotMonitored(investigationId,from.id);if(to.id!==from.id)await snapshotMonitored(investigationId,to.id);}
  } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,"relationship",row,error)); }

  for (const row of payload.records.evidence) try {
    const investigationId = await resolveInvestigation(db, row.investigation_id); const entityId = row.entity ? (await ensureEntity(db, row.entity.entity_type, normalizeCanonicalKey(row.entity.entity_type,{canonical_key:row.entity.canonical_key,network:row.entity.network}), row.entity.canonical_key, investigationId, {}, 0)).id : null;
    const current = await db.prepare("SELECT id FROM evidence WHERE source_module = ? AND source_record_id = ?").bind(module, row.external_id).first<{ id: string }>(); const raw = row as Record<string, unknown>;
    const evidenceId=current?.id??crypto.randomUUID();
    if (current) { await db.prepare("UPDATE evidence SET investigation_id = ?, entity_id = ?, evidence_type = ?, evidence_class = ?, observation_scope = ?, context_text = ?, title = ?, uri = ?, media_type = ?, sha256 = ?, metadata = ?, provenance = ?, captured_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(investigationId, entityId, row.evidence_type, row.evidence_class, row.observation_scope, row.context_text, row.title, raw.uri ?? null, raw.media_type ?? null, raw.sha256 ?? null, json(raw.metadata), json(row.provenance), row.observed_at ?? now(), current.id).run(); updated++; }
    else { await db.prepare("INSERT INTO evidence (id, investigation_id, entity_id, source_module, source_record_id, evidence_type, evidence_class, observation_scope, context_text, title, uri, media_type, sha256, metadata, provenance, schema_version, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(evidenceId, investigationId, entityId, module, row.external_id, row.evidence_type, row.evidence_class, row.observation_scope, row.context_text, row.title, raw.uri ?? null, raw.media_type ?? null, raw.sha256 ?? null, json(raw.metadata), json(row.provenance), payload.schema_version, row.observed_at ?? now()).run(); inserted++; }
    const evidenceData=json(row);const evidenceHash=await sha256(evidenceData);const evidenceVersion=await db.prepare("INSERT OR IGNORE INTO evidence_versions (id,evidence_id,source_module,content_hash,data,captured_at) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(),evidenceId,module,evidenceHash,evidenceData,row.observed_at??now()).run();
    await evaluateEvidence(evidenceId);
    if(investigationId&&entityId)await snapshotMonitored(investigationId,entityId);
    if((evidenceVersion.meta?.changes??0)===1)await publishEvent(module,{event_id:`ingest:${module}:evidence:${row.external_id}:${evidenceHash}`,event_type:"evidence.added",schema_version:payload.schema_version==="3.0"?"3.0":"1.0",correlation_id:payload.origin_job_id??payload.batch_id,investigation_id:investigationId??undefined,entity_id:entityId??undefined,occurred_at:row.observed_at??now(),provenance:{...row.provenance,adapter:"legacy-ingestion",batch_id:payload.batch_id,evidence_id:evidenceId},payload:{title:row.title,evidence_type:row.evidence_type,evidence_class:row.evidence_class,confidence:row.confidence,meaningful_change:Boolean((raw.meaningful_change??false)&&entityId)},hop_count:0});
    if(row.confidence>=.9){await notify({investigationId,type:"important_evidence",severity:"high",title:"Important new evidence",message:`${row.title} was added by ${module}.`,resourceType:"evidence",resourceId:evidenceId});await timeline({investigationId,entityId,sourceModule:module,eventType:"evidence.important",title:"Important evidence added",detail:row.title,reason:`Evidence confidence ${row.confidence.toFixed(2)} met the notification threshold.`,severity:"high",data:{evidence_id:evidenceId,evidence_type:row.evidence_type}});}
  } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,"evidence",row,error)); }

  for(const relationship of payload.records.relationships){const rel=await db.prepare("SELECT id,investigation_id,source_entity_id,target_entity_id FROM relationships WHERE source_module=? AND source_record_id=?").bind(module,relationship.external_id).first<{id:string;investigation_id:string|null;source_entity_id:string;target_entity_id:string}>();if(!rel)continue;for(const evidenceExternalId of relationship.evidence_ids){const evidenceRow=await db.prepare("SELECT id FROM evidence WHERE source_module=? AND source_record_id=?").bind(module,evidenceExternalId).first<{id:string}>();if(evidenceRow)await db.prepare("INSERT OR IGNORE INTO relationship_evidence (id,relationship_id,evidence_id,source_module) VALUES (?,?,?,?)").bind(crypto.randomUUID(),rel.id,evidenceRow.id,module).run();}if(rel.investigation_id){await snapshotMonitored(rel.investigation_id,rel.source_entity_id);if(rel.target_entity_id!==rel.source_entity_id)await snapshotMonitored(rel.investigation_id,rel.target_entity_id);}}

  // A supported, evidence-backed address format can request a first blockchain
  // analysis. This establishes only format validity, never ownership, activity,
  // or that the observed chain label is a blockchain fact.
  if(module==="site_investigator"||module==="crypto_wallet_logger")for(const wallet of payload.records.wallets){
    const network=String(wallet.network??"").toLowerCase(),address=String(wallet.address??"");
    if(!["ethereum","bsc","polygon","arbitrum","base","optimism"].includes(network)||!/^0x[0-9a-fA-F]{40}$/.test(address)||wallet.confidence<.75||!wallet.investigation_id)continue;
    const investigationId=await resolveInvestigation(db,wallet.investigation_id);
    const observation=await db.prepare("SELECT entity_id FROM observations WHERE source_module=? AND record_type='wallet' AND source_record_id=?").bind(module,wallet.external_id).first<{entity_id:string}>();
    if(!investigationId||!observation)continue;
    const support=await db.prepare("SELECT e.id FROM evidence e WHERE e.investigation_id=? AND e.source_module=? AND e.evidence_class='observed_website' AND (e.entity_id=? OR EXISTS(SELECT 1 FROM relationship_evidence re JOIN relationships r ON r.id=re.relationship_id WHERE re.evidence_id=e.id AND r.investigation_id=? AND r.target_entity_id=?)) ORDER BY e.captured_at DESC LIMIT 1").bind(investigationId,module,observation.entity_id,investigationId,observation.entity_id).first<{id:string}>();
    if(!support)continue;
    await publishEvent(module,{event_id:`ingest:${module}:wallet-validated:${wallet.external_id}:${support.id}`,event_type:"wallet.validated",schema_version:"3.0",investigation_id:investigationId,entity_id:observation.entity_id,correlation_id:payload.origin_job_id??payload.batch_id,provenance:{method:"address_format_with_observed_website_evidence",evidence_id:support.id,observed_network:network,network_verified:false},payload:{confidence:wallet.confidence,validation_scope:"address_format",network_claim:network,evidence_refs:[support.id]},hop_count:0});
  }
  // Logger evidence may arrive after its wallet observation in a later batch.
  if(module==="crypto_wallet_logger")for(const evidence of payload.records.evidence){
    if(!evidence.entity||evidence.entity.entity_type!=="wallet"||!evidence.investigation_id)continue;
    const network=String(evidence.entity.network??"").toLowerCase(),address=String(evidence.entity.canonical_key);
    if(!["ethereum","bsc","polygon","arbitrum","base","optimism"].includes(network)||!/^0x[0-9a-fA-F]{40}$/.test(address))continue;
    const investigationId=await resolveInvestigation(db,evidence.investigation_id),key=normalizeCanonicalKey("wallet",{address,network});
    if(!investigationId)continue;
    const entity=await db.prepare("SELECT e.id FROM entities e JOIN investigation_entities ie ON ie.entity_id=e.id AND ie.investigation_id=? WHERE e.entity_type='wallet' AND e.canonical_key=? LIMIT 1").bind(investigationId,key).first<{id:string}>();
    const supporting=await db.prepare("SELECT id FROM evidence WHERE source_module=? AND source_record_id=? AND investigation_id=? AND entity_id=? AND evidence_class='observed_website'").bind(module,evidence.external_id,investigationId,entity?.id??"").first<{id:string}>();
    const observation=await db.prepare("SELECT id FROM observation_versions WHERE source_module=? AND entity_id=? AND record_type='wallet' AND confidence>=.75 LIMIT 1").bind(module,entity?.id??"").first<{id:string}>();
    if(!entity||!supporting||!observation)continue;
    await publishEvent(module,{event_id:`ingest:${module}:wallet-validated:evidence:${supporting.id}`,event_type:"wallet.validated",schema_version:"3.0",investigation_id:investigationId,entity_id:entity.id,correlation_id:payload.batch_id,provenance:{method:"address_format_with_observed_website_evidence",evidence_id:supporting.id,observed_network:network,network_verified:false},payload:{confidence:evidence.confidence,validation_scope:"address_format",network_claim:network,evidence_refs:[supporting.id]},hop_count:0});
  }

  // Schema 3.0 publishes the first-class triage outcome after its evidence is
  // durably ingested. The older passed/categories fields are accepted only for
  // the supported 1.x migration path.
  if(module==="site_finder")for(const site of payload.records.sites){
    const raw=site as Record<string,unknown>,triage=raw.triage as Record<string,unknown>|undefined;
    if(!triage||!site.investigation_id)continue;
    const canonical=payload.schema_version==="3.0";
    const promoted=canonical?triage.outcome==="promoted":triage.passed===true;
    if(!promoted)continue;
    const inv=await resolveInvestigation(db,site.investigation_id);
    const observation=await db.prepare("SELECT entity_id FROM observations WHERE source_module='site_finder' AND record_type='site' AND source_record_id=?").bind(site.external_id).first<{entity_id:string}>();
    const evidenceIds=canonical&&Array.isArray(triage.evidence_ids)?triage.evidence_ids:[];
    const item=payload.records.evidence.find(e=>e.evidence_type==="public_triage"&&e.investigation_id===site.investigation_id&&e.entity?.canonical_key===site.canonical_key&&(!canonical||evidenceIds.includes(e.external_id)));
    const stored=item&&inv?await db.prepare("SELECT id FROM evidence WHERE source_module='site_finder' AND investigation_id=? AND source_record_id=?").bind(inv,item.external_id).first<{id:string}>():null;
    if(!inv||!observation||!stored)continue;
    const categoriesRaw=canonical?triage.indicator_categories:raw.evidence_categories;
    const categories=Array.isArray(categoriesRaw)?categoriesRaw.filter((x):x is string=>typeof x==="string"):[];
    if(new Set(categories).size<2)continue;
    // v5: Site Finder re-delivers a site when its continuous watch sees a change (new batch id, same
    // triage evidence). The triage itself was already recorded under this id; the re-delivery's news
    // travels through the inbox update below. Re-publishing it with the new batch's provenance would
    // be a different event under the same id, so a triage from an earlier batch is not re-published.
    // A retry of the SAME batch still goes through publishEvent (idempotent, resumes pending processing).
    const prior=await db.prepare("SELECT json_extract(provenance,'$.batch_id') batch FROM event_store WHERE event_id=?").bind(`ingest:site_finder:triage:${site.external_id}:${stored.id}`).first<{batch:string|null}>();
    if(prior&&prior.batch!==payload.batch_id)continue;
    await publishEvent(module,{event_id:`ingest:site_finder:triage:${site.external_id}:${stored.id}`,event_type:"site.triaged",schema_version:"3.0",correlation_id:payload.origin_job_id??payload.batch_id,investigation_id:inv,entity_id:observation.entity_id,occurred_at:site.observed_at??now(),provenance:{method:canonical?triage.method:"legacy_1x_checked_triage",batch_id:payload.batch_id,evidence_id:stored.id},payload:{outcome:"promoted",confidence:canonical?triage.confidence:site.confidence,request_downstream:canonical?triage.request_downstream===true:true,indicator_categories:categories,evidence_refs:[stored.id],discovery_path:site.provenance,priority:raw.priority},hop_count:0});
  }

  // v2 inbox: Site Finder v2 site records carry an `inbox` passthrough block.
  // Delivery into the inbox never fails the batch; a missing inbox table
  // (migration 0008 not yet applied) only means the candidate is not shown.
  if(module==="site_finder")for(const site of payload.records.sites){
    const raw=site as Record<string,unknown>;if(!raw.inbox)continue;
    try{
      const inv=await resolveInvestigation(db,site.investigation_id);
      const observation=await db.prepare("SELECT entity_id FROM observations WHERE source_module='site_finder' AND record_type='site' AND source_record_id=?").bind(site.external_id).first<{entity_id:string}>();
      const triage=raw.triage as Record<string,unknown>|undefined;const refs=Array.isArray(triage?.evidence_ids)?(triage.evidence_ids as unknown[]).map(String):[];
      const evidence=inv&&refs.length?await db.prepare("SELECT id FROM evidence WHERE source_module='site_finder' AND investigation_id=? AND source_record_id=?").bind(inv,refs[0]).first<{id:string}>():null;
      await upsertFromFinder({site:raw,investigationId:inv,entityId:observation?.entity_id??null,evidenceId:evidence?.id??null,sourceRecordId:site.external_id});
    }catch(error){console.warn("inbox delivery skipped",site.external_id,error instanceof Error?error.message:error);}
  }

  for (const row of payload.records.discovery_paths) try {
    const investigationId = await resolveInvestigation(db, row.investigation_id); const current = await db.prepare("SELECT id FROM discovery_paths WHERE source_module = ? AND source_record_id = ?").bind(module, row.external_id).first<{ id: string }>();
    if (current) { await db.prepare("UPDATE discovery_paths SET investigation_id = ?, steps = ?, provenance = ?, confidence = ?, observed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(investigationId, json(row.steps), json(row.provenance), row.confidence, row.observed_at ?? now(), current.id).run(); updated++; }
    else { await db.prepare("INSERT INTO discovery_paths (id, investigation_id, source_module, source_record_id, steps, provenance, confidence, schema_version, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), investigationId, module, row.external_id, json(row.steps), json(row.provenance), row.confidence, payload.schema_version, row.observed_at ?? now()).run(); inserted++; }
  } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,"discovery_path",row,error)); }

  for (const row of payload.records.findings) try {
    const investigationId = await resolveInvestigation(db, row.investigation_id); const entityId = row.entity ? (await ensureEntity(db, row.entity.entity_type, normalizeCanonicalKey(row.entity.entity_type,{canonical_key:row.entity.canonical_key,network:row.entity.network}), row.entity.canonical_key, investigationId, {}, 0)).id : null; const current = await db.prepare("SELECT id FROM findings WHERE source_module = ? AND source_record_id = ?").bind(module, row.external_id).first<{ id: string }>();
    if (current) { await db.prepare("UPDATE findings SET investigation_id = ?, entity_id = ?, finding_type = ?, title = ?, body = ?, confidence = ?, classification = ?, provenance = ?, observed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(investigationId, entityId, row.finding_type, row.title, row.body, row.confidence, row.classification ?? null, json(row.provenance), row.observed_at ?? now(), current.id).run(); updated++; }
    else { await db.prepare("INSERT INTO findings (id, investigation_id, entity_id, source_module, source_record_id, finding_type, title, body, confidence, classification, provenance, schema_version, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), investigationId, entityId, module, row.external_id, row.finding_type, row.title, row.body, row.confidence, row.classification ?? null, json(row.provenance), payload.schema_version, row.observed_at ?? now()).run(); inserted++; }
  } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,"finding",row,error)); }

  for (const row of payload.records.notes) try {
    const investigationId=await resolveInvestigation(db,row.investigation_id);const entityId=row.entity?(await ensureEntity(db,row.entity.entity_type,normalizeCanonicalKey(row.entity.entity_type,{canonical_key:row.entity.canonical_key,network:row.entity.network}),row.entity.canonical_key,investigationId,{},0)).id:null;const current=await db.prepare("SELECT id FROM notes WHERE source_module=? AND source_record_id=?").bind(module,row.external_id).first<{id:string}>();
    if(current){await db.prepare("UPDATE notes SET investigation_id=?,entity_id=?,title=?,body=?,note_kind=?,provenance=?,observed_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(investigationId,entityId,row.title,row.body,row.note_kind,json(row.provenance),row.observed_at??now(),current.id).run();updated++;}
    else{await db.prepare("INSERT INTO notes (id,investigation_id,entity_id,source_module,source_record_id,title,body,note_kind,provenance,schema_version,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),investigationId,entityId,module,row.external_id,row.title,row.body,row.note_kind,json(row.provenance),payload.schema_version,row.observed_at??now()).run();inserted++;}
  } catch(error){errors.push(await recordFailure(db,module,payload.batch_id,"note",row,error));}

  for (const row of payload.records.module_activity) try {
    const current = await db.prepare("SELECT id FROM module_activity WHERE source_module = ? AND source_record_id = ?").bind(module, row.external_id).first<{ id: string }>();
    if(!current&&row.investigation_id){const investigationId=await resolveInvestigation(db,row.investigation_id);if(investigationId){const {ensureBudget}=await import("./planner");await ensureBudget(investigationId);const calls=Number(row.metrics.api_calls??0),runtime=Number(row.metrics.runtime_seconds??0);if(Number.isSafeInteger(calls)&&calls>=0&&Number.isSafeInteger(runtime)&&runtime>=0)await db.prepare("UPDATE investigation_budgets SET used_api_calls=used_api_calls+?,used_runtime_seconds=used_runtime_seconds+?,updated_at=CURRENT_TIMESTAMP WHERE investigation_id=?").bind(calls,runtime,investigationId).run();}}
    if (current) { await db.prepare("UPDATE module_activity SET status = ?, message = ?, metrics = ?, occurred_at = ?, received_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.status, row.message, json(row.metrics), row.observed_at ?? now(), current.id).run(); updated++; }
    else { await db.prepare("INSERT INTO module_activity (id, source_module, source_record_id, status, message, metrics, schema_version, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), module, row.external_id, row.status, row.message, json(row.metrics), payload.schema_version, row.observed_at ?? now()).run(); inserted++; }
  } catch (error) { errors.push(await recordFailure(db,module,payload.batch_id,"module_activity",row,error)); }

  const status = errors.length === 0 ? "accepted" : errors.length < received ? "partial" : "failed";
  await db.batch([
    db.prepare("UPDATE ingestion_batches SET status = ?, inserted_count = ?, updated_count = ?, duplicate_count = ?, error_count = ?, errors = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, inserted, updated, duplicate, errors.length, json(errors), batchRowId),
    db.prepare("INSERT INTO module_registry (module_name,connection_status,runtime_status,schema_version,last_heartbeat_at,last_successful_sync_at,records_received,last_error,recent_errors) VALUES (?,'connected','idle',?,CURRENT_TIMESTAMP,CASE WHEN ?!='failed' THEN CURRENT_TIMESTAMP ELSE NULL END,?,?,?) ON CONFLICT(module_name) DO UPDATE SET connection_status='connected',runtime_status=CASE WHEN excluded.last_error IS NULL THEN 'idle' ELSE 'error' END,schema_version=excluded.schema_version,last_heartbeat_at=CURRENT_TIMESTAMP,last_successful_sync_at=CASE WHEN ?!='failed' THEN CURRENT_TIMESTAMP ELSE module_registry.last_successful_sync_at END,records_received=module_registry.records_received+excluded.records_received,last_error=excluded.last_error,recent_errors=excluded.recent_errors,updated_at=CURRENT_TIMESTAMP").bind(module,payload.schema_version,status,received-errors.length,errors.length?errors[0].message:null,json(errors.slice(-10)),status),
  ]);
  return { batch_id: payload.batch_id, status, received_count: received, inserted_count: inserted, updated_count: updated, duplicate_count: duplicate, error_count: errors.length, errors, replayed: false };
}
