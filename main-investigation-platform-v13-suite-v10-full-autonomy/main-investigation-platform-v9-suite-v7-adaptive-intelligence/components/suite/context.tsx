"use client";
/**
 * Investigation context that follows you between tools: the site, wallet and operation you are
 * working on. It lives in the page URL (?site=…&wallet=…&op=…) so links and reloads keep it, and
 * is remembered for the tab so switching tools does not lose it. Nothing is sent anywhere; the
 * tools read it to focus their own views.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

export type Ctx = { site?: string; wallet?: string; op?: string; investigation?: string };
type Api = { ctx: Ctx; set: (p: Ctx) => void; clear: (k?: keyof Ctx) => void; href: (path: string, p?: Ctx) => string };
const KEYS: Array<keyof Ctx> = ["site", "wallet", "op", "investigation"];
const STORE = "mip.context";
const C = createContext<Api>({ ctx: {}, set: () => {}, clear: () => {}, href: p => p });

function store(c:Ctx){try{const value=JSON.stringify(Object.fromEntries(KEYS.filter(k=>c[k]).map(k=>[k,c[k]])));if(sessionStorage.getItem(STORE)!==value){sessionStorage.setItem(STORE,value);window.dispatchEvent(new Event('mip-context'));}}catch{/* URL retains context in private mode. */}}
function subscribe(listener:()=>void){window.addEventListener('mip-context',listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener('mip-context',listener);window.removeEventListener('storage',listener);};}
function storedSnapshot(){try{return sessionStorage.getItem(STORE)??'{}';}catch{return '{}';}}
function serverSnapshot(){return '{}';}

export function SuiteContextProvider({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const query=useSearchParams(),storedText=useSyncExternalStore(subscribe,storedSnapshot,serverSnapshot);
  const ctx=useMemo(()=>{let stored:Ctx={};try{const candidate=JSON.parse(storedText);if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate))stored=candidate as Ctx;}catch{}const out:Ctx={};for(const k of KEYS){const v=query.get(k)??stored[k];if(typeof v==='string'&&v)out[k]=v.slice(0,200);}return out;},[query,storedText]);
  useEffect(()=>store(ctx),[ctx]);
  const href = useCallback((p: string, extra?: Ctx) => {
    const merged: Ctx = { ...ctx, ...(extra ?? {}) };
    const q = new URLSearchParams();
    for (const k of KEYS) if (merged[k]) q.set(k, String(merged[k]));
    const s = q.toString();
    return s ? `${p}${p.includes('?')?'&':'?'}${s}` : p;
  }, [ctx]);
  const set = useCallback((p: Ctx) => {
    const next = { ...ctx, ...p };
    for (const k of KEYS) if (!next[k]) delete next[k];
    store(next);
    const q = new URLSearchParams();
    for (const k of KEYS) if (next[k]) q.set(k, String(next[k]));
    router.replace(`${path}${q.toString() ? `?${q}` : ""}`, { scroll: false });
  }, [ctx, path, router]);
  const clear = useCallback((k?: keyof Ctx) => {
    const next: Ctx = k ? { ...ctx, [k]: undefined } : {};
    for (const key of KEYS) if (!next[key]) delete next[key];
    store(next);
    const q = new URLSearchParams();
    for (const key of KEYS) if (next[key]) q.set(key, String(next[key]));
    router.replace(`${path}${q.toString() ? `?${q}` : ""}`, { scroll: false });
  }, [ctx, path, router]);
  const api = useMemo(() => ({ ctx, set, clear, href }), [ctx, set, clear, href]);
  return <C.Provider value={api}>{children}</C.Provider>;
}

export function useSuiteContext() { return useContext(C); }

/** The chips in the top bar: what you are working on, with a way to open it in the tool that owns it. */
export function ContextBar() {
  const { ctx, clear, href } = useSuiteContext();
  const items: Array<{ k: keyof Ctx; label: string; to: string }> = [];
  if (ctx.site) items.push({ k: "site", label: ctx.site, to: href("/finder", { site: ctx.site }) });
  if (ctx.wallet) items.push({ k: "wallet", label: ctx.wallet.length > 22 ? `${ctx.wallet.slice(0, 10)}…${ctx.wallet.slice(-6)}` : ctx.wallet, to: href("/wallets", { wallet: ctx.wallet }) });
  if (ctx.op) items.push({ k: "op", label: ctx.op, to: href("/hunter", { op: ctx.op }) });
  if (!items.length) return <span className="mip-meta">No site, wallet or operation selected</span>;
  return <div className="mip-context" aria-label="Current investigation context">
    {items.map(i => <span key={i.k} className="mip-chip"><small>{i.k === "op" ? "operation" : i.k}</small><Link href={i.to}><span>{i.label}</span></Link>
      <button aria-label={`Clear ${i.k}`} onClick={() => clear(i.k)}>×</button></span>)}
  </div>;
}
