// v3 vs v4 benchmark: the same simulated operator world, the same investigation
// budget, run through the REAL platform code in both arms.
//
//   v3 arm  The inbox as v3 shipped it: a person works the inbox top-down and
//           marks candidates Useful; each Useful auto-starts the v3 AI
//           investigator, which investigates the site, analyses wallets and
//           asks Site Finder once for related sites (classic seeded round).
//   v4 arm  One campaign started from the same seed site: association,
//           deterministic priority engine, hypotheses tested by contextual
//           pivots, Reviewer, saturation, budgets. No manual Next Site.
//
// The world (ground truth) is synthetic and generated here from a seed:
// operators run kits of cloned sites that share templates, hosting and
// name servers; many clones reuse the same deposit wallet; some sites are dead
// or behind a login; some are not yet in the inbox and can only be found by
// discovery; unrelated scams and non-scams share a CDN IP. Module workers
// answer from that truth. Site Finder is simulated by a small truth-driven
// service (its real pivot engine is benchmarked separately in Python,
// integrations/site-finder-v07/tests/test_v4_context.py).
//
// Usage: node --experimental-sqlite tests/bench-v4.mjs [--seeds 5] [--budget 10] [--discovery 8] [--out path]
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (args.arm) { await (await import("./lib/bench-v4-arm.mjs")).runArm(args.arm, Number(args.seed), Number(args.budget), Number(args.discovery ?? 8)); process.exit(0); }

const seeds = Number(args.seeds ?? 5), budget = Number(args.budget ?? 10), discovery = Number(args.discovery ?? 8);
const here = fileURLToPath(new URL(".", import.meta.url));
const results = { v3: [], v4: [] };
for (let seed = 1; seed <= seeds; seed++) for (const arm of ["v3", "v4"]) {
  const r = spawnSync(process.execPath, ["--experimental-sqlite", fileURLToPath(import.meta.url), "--arm", arm, "--seed", String(seed), "--budget", String(budget), "--discovery", String(discovery)], { encoding: "utf8", cwd: here, maxBuffer: 1 << 26 });
  const line = (r.stdout || "").split(/\r?\n/).find(l => l.startsWith("RESULT "));
  if (r.status !== 0 || !line) { console.error(`arm ${arm} seed ${seed} failed:\n${r.stderr}\n${r.stdout.slice(-3000)}`); process.exit(1); }
  results[arm].push(JSON.parse(line.slice(7)));
  console.log(`seed ${seed} ${arm}: ${line.slice(7, 260)}`);
}
const keys = Object.keys(results.v3[0]).filter(k => typeof results.v3[0][k] === "number");
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const summary = Object.fromEntries(keys.map(k => [k, { v3: Number(mean(results.v3.map(r => r[k])).toFixed(3)), v4: Number(mean(results.v4.map(r => r[k])).toFixed(3)) }]));
const out = { generated_at: new Date().toISOString(), seeds, investigation_budget: budget, v4_discovery_budget: discovery, summary, per_seed: results };
const path = args.out ?? fileURLToPath(new URL("./results/eval_v4.json", import.meta.url));
mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(out, null, 2));
console.log("\nmetric".padEnd(38) + "v3".padStart(10) + "v4".padStart(10));
for (const [k, v] of Object.entries(summary)) console.log(k.padEnd(38) + String(v.v3).padStart(10) + String(v.v4).padStart(10));
console.log(`\nwritten ${path}`);
