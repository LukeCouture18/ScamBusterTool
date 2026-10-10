// Minimal stand-ins for next/link and next/navigation so the suite's real client components can run
// in a plain browser bundle for the acceptance test (the production build uses Next itself).
import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();
export function navigate(url: string, replace = false) {
  if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  listeners.forEach(l => l());
}
if (typeof window !== "undefined") window.addEventListener("popstate", () => listeners.forEach(l => l()));
function useLocation() {
  const [, set] = useState(0);
  useEffect(() => { const l = () => set(x => x + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  // On the server (the SSR pass of tests/ui/build-all.mjs) the path being rendered is given by the harness.
  return typeof window === "undefined" ? ((globalThis as { __SSR_PATH__?: string }).__SSR_PATH__ ?? "/") : window.location.pathname;
}
export function usePathname() { return useLocation(); }
const router = { push: (u: string) => navigate(u), replace: (u: string) => navigate(u, true), refresh: () => listeners.forEach(l => l()), back: () => history.back() };
export function useRouter() { return router; }
export function useSearchParams() { useLocation(); return new URLSearchParams(typeof window === "undefined" ? "" : window.location.search); }

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode; prefetch?: boolean; scroll?: boolean };
export default function Link({ href, onClick, children, prefetch: _p, scroll: _s, ...rest }: LinkProps) {
  return <a href={href} {...rest} onClick={(e: MouseEvent<HTMLAnchorElement>) => { onClick?.(e); if (e.defaultPrevented || rest.target === "_blank" || e.metaKey || e.ctrlKey) return; e.preventDefault(); navigate(href); window.scrollTo(0, 0); }}>{children}</a>;
}
