/** Small shared helpers for the v5 operations layer. */
import { getD1, json } from "../platform";

export type Row = Record<string, unknown>;
export function parse<T>(v: unknown, f: T): T { try { return typeof v === "string" ? JSON.parse(v) as T : (v as T) ?? f; } catch { return f; } }
export const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
export const r3 = (x: number) => Math.round(x * 1000) / 1000;
export const iso = (d = new Date()) => d.toISOString();
export const day = (d = new Date()) => d.toISOString().slice(0, 10);
export function ts(v: unknown) { const s = String(v ?? ""); if (!s) return 0; return new Date(s.replace(" ", "T") + (/[Z]$|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")).getTime(); }
export const hoursSince = (v: unknown) => { const t = ts(v); return t ? Math.max(0, (Date.now() - t) / 3600000) : 0; };

export async function getState(key: string, fallback: string) {
  try { return (await getD1().prepare("SELECT value FROM ops_state WHERE key=?").bind(key).first<{ value: string }>())?.value ?? fallback; } catch { return fallback; }
}
export async function getNum(key: string, fallback: number) { const v = Number(await getState(key, String(fallback))); return Number.isFinite(v) ? v : fallback; }
export async function getBool(key: string, fallback: boolean) { return (await getState(key, String(fallback))) === "true"; }
export async function setState(key: string, value: string | number | boolean) {
  await getD1().prepare("INSERT INTO ops_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(key, String(value)).run();
}

/** Stable JSON: object keys sorted, arrays of primitives sorted, so equal observations hash equally. */
export function stable(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) { const items = v.map(norm); return items.every(i => typeof i !== "object" || i === null) ? [...items].sort((a, b) => String(a).localeCompare(String(b))) : items; }
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Row).sort().map(k => [k, norm((v as Row)[k])]));
    return typeof v === "string" ? v.trim().toLowerCase() : v;
  };
  return JSON.stringify(norm(value));
}
export async function hash(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export { json };
