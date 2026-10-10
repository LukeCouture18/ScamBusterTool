/**
 * Deterministic detection of human-only barriers and dead sites from observed
 * evidence. The model can also propose a human checkpoint, but these rules run
 * first and do not depend on it: a CAPTCHA or login wall pauses the
 * investigation even if the model is unavailable or wrong.
 *
 * Nothing here tries to get past a barrier. It only recognises one, so the
 * platform can stop and tell you what a person has to do.
 */
import { isErrorType } from "./knowledge";

export type BarrierKind = "login" | "captcha" | "mfa" | "email_verification";
export type EvidenceLite = { id: string; evidence_type: string; evidence_class: string; observation_scope: string; source_module: string; context_text: string; title: string; created_at: string };
export type Barrier = { kind: BarrierKind; evidence_ids: string[]; reason: string };

const PATTERNS: Array<[BarrierKind, RegExp, string]> = [
  ["captcha", /\b(h?captcha|recaptcha|turnstile|cf-challenge|challenge-platform|verify (that )?you are (a )?human|are you a robot|security check to continue)\b/i, "The site shows a CAPTCHA / human-verification challenge."],
  ["mfa", /\b(two[- ]factor|2fa|authenticator (app|code)|one[- ]time (pass)?code|verification code (was )?sent|enter the (6|six)[- ]digit code)\b/i, "The site asks for a second authentication factor."],
  ["email_verification", /\b(verify your e-?mail|confirm your e-?mail|check your (e-?mail|inbox) (for|to)|email verification (link|required))\b/i, "The site requires email verification before continuing."],
  ["login", /\b(sign in to (continue|view|access)|log ?in to (continue|view|access|see)|please (log|sign) ?in|login required|you must (be )?(log(ged)?|sign(ed)?) ?in|members only)\b/i, "Deposit details are behind a login."],
];

function pageKind(e: EvidenceLite): string {
  if (e.evidence_type !== "page_text") return "";
  try { return String((JSON.parse(e.context_text) as { kind?: unknown }).kind ?? ""); } catch { return ""; }
}

/**
 * Barriers visible in Site Investigator / browser evidence. A login wall is
 * only reported when the public investigation found no wallet: a login page on
 * a site that shows its deposit address publicly is not blocking anything.
 */
export function detectBarriers(evidence: EvidenceLite[], context: { publicWalletFound: boolean; siteInvestigated: boolean }): Barrier[] {
  const out = new Map<BarrierKind, Barrier>();
  const relevant = evidence.filter(e => ["site_investigator", "crypto_wallet_logger"].includes(e.source_module) && e.observation_scope !== "authenticated");
  for (const e of relevant) {
    const text = `${e.title} ${e.context_text}`.slice(0, 20000);
    for (const [kind, pattern, reason] of PATTERNS) {
      if (kind === "login") continue;
      if (pattern.test(text)) { const b = out.get(kind) ?? { kind, evidence_ids: [], reason }; b.evidence_ids.push(e.id); out.set(kind, b); }
    }
  }
  if (context.siteInvestigated && !context.publicWalletFound) {
    const login = relevant.filter(e => ["login", "register"].includes(pageKind(e)) || PATTERNS[3][1].test(`${e.title} ${e.context_text}`.slice(0, 20000)));
    if (login.length) out.set("login", { kind: "login", evidence_ids: login.map(e => e.id).slice(0, 5), reason: PATTERNS[3][2] });
  }
  for (const b of out.values()) b.evidence_ids = [...new Set(b.evidence_ids)].slice(0, 5);
  return [...out.values()];
}

/**
 * A site is dead when Site Investigator looked at it and recorded only
 * failures (DNS, TLS, fetch errors) and never a page.
 */
export function isDeadSite(evidence: EvidenceLite[], failedInvestigation: { error: string } | null): { dead: boolean; reason: string; evidence_ids: string[] } {
  const si = evidence.filter(e => e.source_module === "site_investigator");
  const pages = si.filter(e => e.evidence_type === "page_text" || e.evidence_type === "screenshot" || e.evidence_type === "wallet_display");
  const errors = si.filter(e => isErrorType(e.evidence_type));
  if (si.length && !pages.length && errors.length) return { dead: true, reason: "Site Investigator could not load any page.", evidence_ids: errors.map(e => e.id).slice(0, 5) };
  if (!pages.length && failedInvestigation && /(name or service not known|nxdomain|getaddrinfo|could not resolve|connection refused|timed? ?out|no such host|dns)/i.test(failedInvestigation.error))
    return { dead: true, reason: `Site investigation failed: ${failedInvestigation.error.slice(0, 120)}`, evidence_ids: [] };
  return { dead: false, reason: "", evidence_ids: [] };
}

export const CHECKPOINT_TEXT: Record<BarrierKind | "analyst_review", { title: string; instructions: string }> = {
  login: { title: "Waiting for login", instructions: "The deposit page is behind a login. Open the site, register or sign in normally. Wallet Logger’s private Accounts page can prepare a legitimate new identity, import an account you own, and explicitly fill this exact domain. Submit and verify yourself, then go to the deposit page. CryptoWalletLogger records what it shows and the investigation continues on its own." },
  captcha: { title: "Waiting for CAPTCHA", instructions: "The site shows a CAPTCHA. Open it and complete the challenge yourself; the platform never solves or bypasses CAPTCHAs. Browse to the deposit page and the investigation continues from what CryptoWalletLogger records." },
  mfa: { title: "Waiting for verification code", instructions: "The site asks for a second factor. Complete it yourself if you can; the platform never bypasses MFA. Once you are in, open the deposit page and the investigation continues." },
  email_verification: { title: "Waiting for email verification", instructions: "The site wants its email link confirmed. Confirm it yourself, sign in, and open the deposit page. The investigation continues when new evidence arrives." },
  analyst_review: { title: "Needs your review", instructions: "The investigator needs a decision only a person can make. Review the case and mark this done when you have." },
};
