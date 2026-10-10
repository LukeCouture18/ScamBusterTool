/**
 * Global, module and provider budgets (campaign budgets stay on the campaign).
 * Usage is an append-only ledger keyed by (scope, kind, ref), so recording the
 * same spend twice after a restart counts once.
 */
import { getD1 } from "../platform";
import { day, type Row } from "./common";

export type BudgetKind = "module_jobs" | "discovery_requests" | "investigations" | "model_calls" | "model_tokens" | "model_cost_usd";

export async function limitOf(scope: string, kind: BudgetKind): Promise<number | null> {
  const r = await getD1().prepare("SELECT max_units FROM budget_limits WHERE scope=? AND kind=? AND window='day'").bind(scope, kind).first<Row>();
  return r ? Number(r.max_units) : null;
}
export async function usedToday(scope: string, kind: BudgetKind) {
  return Number((await getD1().prepare("SELECT COALESCE(SUM(units),0) u FROM budget_ledger WHERE scope=? AND kind=? AND day=?").bind(scope, kind, day()).first<Row>())?.u ?? 0);
}
/** True when `units` more fit under every applicable limit (global and each named scope). */
export async function canSpend(kind: BudgetKind, units: number, scopes: string[] = []) {
  for (const s of ["global", ...scopes]) {
    const max = await limitOf(s, kind);
    if (max != null && (await usedToday(s, kind)) + units > max) return { ok: false as const, scope: s, max };
  }
  return { ok: true as const };
}
export async function spend(kind: BudgetKind, units: number, ref: string, scopes: string[] = []) {
  const db = getD1();
  for (const s of ["global", ...scopes]) await db.prepare("INSERT OR IGNORE INTO budget_ledger (id,scope,kind,units,ref,day) VALUES (?,?,?,?,?,?)").bind(crypto.randomUUID(), s, kind, units, ref, day()).run();
}
export async function setLimit(scope: string, kind: BudgetKind, max: number) {
  if (!Number.isFinite(max) || max < 0 || max > 1e9) throw new Error("BUDGET_LIMIT_INVALID");
  await getD1().prepare("INSERT INTO budget_limits (scope,kind,window,max_units) VALUES (?,?,'day',?) ON CONFLICT(scope,kind,window) DO UPDATE SET max_units=excluded.max_units,updated_at=CURRENT_TIMESTAMP").bind(scope, kind, max).run();
}
export async function budgetSummary() {
  const db = getD1();
  const limits = (await db.prepare("SELECT scope,kind,max_units FROM budget_limits WHERE window='day' ORDER BY scope,kind").all<Row>()).results;
  const out = [];
  for (const l of limits) { const used = await usedToday(String(l.scope), l.kind as BudgetKind); out.push({ scope: String(l.scope), kind: String(l.kind), used: Math.round(used * 1000) / 1000, max: Number(l.max_units), share: Number(l.max_units) ? used / Number(l.max_units) : 0 }); }
  return out;
}
