/**
 * Deterministic policy between the model and anything that happens.
 *
 * Model output is untrusted structured input. Safety here is structural rather
 * than a list of forbidden words: the model can only choose one of the
 * registered capabilities in capabilities.ts, each with a strict typed argument
 * schema (UUIDs of entities in this investigation, enums, bounded integers).
 * No capability logs in, submits forms to a scam site, handles credentials,
 * interacts with a CAPTCHA/MFA/verification step, moves funds or runs code,
 * so no model output can make the platform do those things.
 *
 * Free-text fields (rationale, reasons, summaries, inference claims) are
 * stored for audit and shown to you labelled as AI output. They are never
 * executed, sent to a module, or used as instructions. Checkpoint instructions
 * shown to you come from fixed templates, not from the model.
 *
 * A plan executes only if it:
 *   1. parses as the strict plan schema (unknown fields are rejected, so a
 *      model cannot add "new_evidence" or anything else the schema lacks),
 *   2. names a registered capability allowed by the investigation profile,
 *   3. passes that capability's argument schema and preconditions,
 *   4. cites only evidence and entities that exist in this investigation,
 *   5. keeps free text short and free of links and markup,
 *   6. fits the run's remaining budgets, and
 *   7. does not repeat an action already taken in this run (fingerprint), or
 *      an action family that has already produced nothing twice.
 * Any failure rejects the whole plan with reasons; nothing partial executes.
 */
import { z } from "zod";
import { CAPABILITY_BY_NAME, type Capability, type RunRow } from "./capabilities";
import type { Digest } from "./state";

type Row = Record<string, unknown>;
export const PLAN_SCHEMA = z.object({
  rationale: z.string().min(1).max(600),
  action: z.object({ capability: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()).default({}) }).strict(),
  triggering_evidence: z.array(z.string().min(1).max(240)).max(10).default([]),
  expected_value: z.number().min(0).max(1).default(0.5),
  inferences: z.array(z.object({ claim: z.string().min(3).max(300), entity_id: z.string().uuid().optional(), cited_evidence: z.array(z.string().min(1).max(240)).min(1).max(8) }).strict()).max(5).default([]),
}).strict();
export type Plan = z.infer<typeof PLAN_SCHEMA>;

const PROFILE_ALLOWED: Record<string, string[]> = {
  "quick-triage": ["site:investigate", "wallet:analyze"],
  "standard-investigation": ["site:investigate", "site:relate", "wallet:analyze", "wallet:log", "report-preparation"],
  "deep-investigation": ["site:investigate", "site:relate", "wallet:analyze", "wallet:log", "report-preparation"],
  "continuous-monitoring": ["site:investigate", "wallet:analyze", "report-preparation"],
};

/** Links and markup have no place in any free-text field of a plan. */
const FREE_TEXT_NOT_ALLOWED = /(https?:\/\/|www\.|<\s*\/?\s*[a-z]|javascript:|data:)/i;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

export type StepHistory = Array<{ capability: string | null; validation: string | null; outcome: string | null; realized_value: number | null; fingerprint: string | null }>;
export type Validation = { ok: true; plan: Plan; capability: Capability; args: Row; fingerprint: string } | { ok: false; reasons: string[]; plan?: Plan };

export function validatePlan(raw: unknown, ctx: { run: RunRow; digest: Digest; profile: string; history: StepHistory }): Validation {
  const parsed = PLAN_SCHEMA.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.slice(0, 6).map(i => `schema: ${i.path.join(".") || "(root)"} ${i.message}`) };
  const plan = parsed.data;
  const reasons: string[] = [];
  const capability = CAPABILITY_BY_NAME.get(plan.action.capability);
  if (!capability) return { ok: false, plan, reasons: [`unknown capability "${plan.action.capability}"`] };
  const allowed = PROFILE_ALLOWED[ctx.profile] ?? PROFILE_ALLOWED["standard-investigation"];
  if (capability.profileCapability && !allowed.includes(capability.profileCapability)) reasons.push(`profile ${ctx.profile} does not permit ${capability.profileCapability}`);

  const args = capability.args.safeParse(plan.action.arguments);
  if (!args.success) reasons.push(...args.error.issues.slice(0, 4).map(i => `arguments: ${i.path.join(".") || "(root)"} ${i.message}`));

  const known = new Set(ctx.digest.evidence.all_ids);
  for (const id of plan.triggering_evidence) if (!known.has(id)) reasons.push(`triggering evidence ${id} does not exist in this investigation`);
  const entities = new Set(ctx.digest.entities.map(e => e.id));
  for (const inf of plan.inferences) {
    for (const id of inf.cited_evidence) if (!known.has(id)) reasons.push(`inference cites evidence ${id}, which does not exist in this investigation`);
    if (inf.entity_id && !entities.has(inf.entity_id)) reasons.push(`inference is about entity ${inf.entity_id}, which is not in this investigation`);
  }

  for (const text of strings([plan.rationale, plan.action.arguments, plan.inferences.map(i => i.claim)]))
    if (FREE_TEXT_NOT_ALLOWED.test(text)) { reasons.push("free text may not contain links or markup"); break; }

  if (!args.success || reasons.length) return { ok: false, plan, reasons };
  const a = args.data as Row;
  reasons.push(...capability.check(a, { run: ctx.run, digest: ctx.digest, triggeringEvidence: plan.triggering_evidence }));

  const run = ctx.run as Row;
  const n = (k: string) => Number(run[k] ?? 0);
  if (capability.kind !== "terminal") {
    if (n("used_actions") >= n("max_actions")) reasons.push("action budget exhausted");
    if (capability.kind === "module" && n("used_module_calls") >= n("max_module_calls")) reasons.push("module-call budget exhausted");
    if (capability.name.startsWith("discovery.") && n("used_discovery_expansions") >= n("max_discovery_expansions")) reasons.push("discovery-expansion budget exhausted");
  }

  const fingerprint = capability.fingerprint(a, { run: ctx.run, digest: ctx.digest, triggeringEvidence: plan.triggering_evidence });
  if (ctx.history.some(h => h.validation === "accepted" && h.fingerprint === fingerprint)) reasons.push(`duplicate action: ${fingerprint} was already taken in this run`);
  const family = ctx.history.filter(h => h.validation === "accepted" && h.capability === capability.name && h.outcome !== "queued" && h.outcome !== "duplicate");
  if (capability.kind === "read" && family.filter(h => (h.realized_value ?? 0) <= 0).length >= 2) reasons.push(`${capability.name} has already produced nothing twice in this run`);

  return reasons.length ? { ok: false, plan, reasons } : { ok: true, plan, capability, args: a, fingerprint };
}
