// v4 vs v5 benchmark: identical worlds, seeds, simulated days and budgets, run
// through the REAL platform code in both arms.
//
//   v4 arm  How v4 operates: a person starts one campaign from the seed site on
//           day 1; the campaign associates, prioritizes, tests hypotheses with
//           contextual pivots and stops by its own budgets. No scheduler, no
//           automatic revisits or campaign formation.
//   v5 arm  Autonomous operations: the scheduler generates typed work from
//           Site Finder's candidates, gaps and changes; forms campaigns from
//           graph evidence; revisits changed sites; runs discovery; asks a
//           person only for checkpoints and contradictions.
//
// The world is tests/lib/bench-v4-arm.mjs makeWorld plus temporal dynamics
// (tests/lib/bench-v5-arm.mjs advanceWorld): over 5 simulated days sites behind
// logins open their deposit pages, live sites die, dead sites return, operators
// rotate deposit wallets and kits register new sites. Site Finder's baseline
// supply and its continuous watch re-deliveries are identical in both arms.
//
// Usage: node --experimental-sqlite tests/bench-v5.mjs [--seeds 5] [--budget 12] [--discovery 8] [--out path]
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
if (args.arm) { await (await import("./lib/bench-v5-arm.mjs")).runArm(args.arm, Number(args.seed), Number(args.budget), Number(args.discovery ?? 8)); process.exit(0); }

const seeds = Number(args.seeds ?? 5), budget = Number(args.budget ?? 12), discovery = Number(args.discovery ?? 8);
const here = fileURLToPath(new URL(".", import.meta.url));
const results = { v4: [], v5: [] };
for (let seed = 1; seed <= seeds; seed++) for (const arm of ["v4", "v5"]) {
  const r = spawnSync(process.execPath, ["--experimental-sqlite", fileURLToPath(import.meta.url), "--arm", arm, "--seed", String(seed), "--budget", String(budget), "--discovery", String(discovery)], { encoding: "utf8", cwd: here, maxBuffer: 1 << 26 });
  const line = (r.stdout || "").split(/\r?\n/).find(l => l.startsWith("RESULT "));
  if (r.status !== 0 || !line) { console.error(`arm ${arm} seed ${seed} failed:\n${r.stderr}\n${(r.stdout || "").slice(-3000)}`); process.exit(1); }
  results[arm].push(JSON.parse(line.slice(7)));
  console.log(`seed ${seed} ${arm}: ${line.slice(7, 240)}`);
}
const keys = Object.keys(results.v4[0]).filter(k => typeof results.v4[0][k] === "number" && k !== "wall_ms");
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const summary = Object.fromEntries(keys.map(k => [k, { v4: Number(mean(results.v4.map(r => r[k])).toFixed(3)), v5: Number(mean(results.v5.map(r => r[k])).toFixed(3)) }]));
const out = { generated_at: new Date().toISOString(), seeds, investigation_budget: budget, discovery_budget: discovery, module_job_budget: 60, days: 5, ticks_per_day: 8, summary, per_seed: results };
const path = args.out ?? fileURLToPath(new URL("./results/eval_v5.json", import.meta.url));
mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(out, null, 2));
console.log("\nmetric".padEnd(38) + "v4".padStart(10) + "v5".padStart(10));
for (const [k, v] of Object.entries(summary)) console.log(k.padEnd(38) + String(v.v4).padStart(10) + String(v.v5).padStart(10));
console.log(`\nwritten ${path}`);
