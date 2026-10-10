import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
// --import takes a module specifier: a file: URL, not a raw C:\... path.
const envLoader = pathToFileURL(path.join(root, "scripts/sites-env.mjs")).href;
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const config = path.join(root, "dist/server/wrangler.json");
const envFile = path.join(root, ".dev.vars");
const persistence = process.env.MIP_PERSIST_TO
  ? path.resolve(process.env.MIP_PERSIST_TO)
  : path.join(root, ".wrangler/state");

// Verify the persisted schema in a separate CLI session before serving requests.
// A successful migration command alone did not establish readiness in one local run.
const migrations = readdirSync(path.join(root, "drizzle")).filter(name => name.endsWith(".sql")).sort();
const requiredTables = ["autonomy_searches", "autonomy_candidate_claims", "inbox_supply_lock",
  "autonomous_missions", "mission_resources", "mission_reservations", "mission_opportunities", "mission_history"];
const command = "SELECT name FROM d1_migrations; SELECT name FROM sqlite_master WHERE type='table';";
let ready = false;
for (let attempt = 0; attempt < 2; attempt++) {
  const migration = spawnSync(process.execPath, [
    "--import", envLoader, wrangler, "d1", "migrations", "apply", "DB",
    "--local", "--config", config, "--persist-to", persistence,
  ], { cwd: root, env: process.env, stdio: "inherit" });
  if (migration.error) throw migration.error;
  if (migration.status !== 0) process.exit(migration.status ?? 1);
  const verification = spawnSync(process.execPath, [
    "--import", envLoader, wrangler, "d1", "execute", "DB", "--local",
    "--config", config, "--persist-to", persistence, "--command", command, "--json",
  ], { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (verification.error) throw verification.error;
  if (verification.status !== 0) {
    console.error("Unable to verify local migration readiness.");
    process.exit(verification.status ?? 1);
  }
  let results;
  try { results = JSON.parse(verification.stdout); }
  catch { console.error("Invalid local migration readiness response; worker was not started."); process.exit(1); }
  const applied = new Set(results[0]?.results?.map(row => row.name) ?? []);
  const tables = new Set(results[1]?.results?.map(row => row.name) ?? []);
  const missingMigrations = migrations.filter(name => !applied.has(name));
  const missingTables = requiredTables.filter(name => !tables.has(name));
  ready = results.every(result => result.success) && !missingMigrations.length && !missingTables.length;
  if (ready) break;
  console.error(`Local schema is incomplete: migrations [${missingMigrations.join(", ")}], tables [${missingTables.join(", ")}].`);
  // Apply only pending migrations once more. Never delete or reset persisted state.
  if (!missingMigrations.length || attempt === 1) break;
  console.error("Retrying pending local migrations once before worker startup.");
}
if (!ready) { console.error("Local schema readiness failed; preserved database was not reset and worker was not started."); process.exit(1); }

const server = spawn(process.execPath, [
  "--import", envLoader, wrangler, "dev", "--config", config, "--local",
  "--persist-to", persistence, "--ip", "127.0.0.1", "--port", "8787",
  "--inspector-ip", "127.0.0.1", "--inspector-port", "0", "--env-file", envFile,
], { cwd: root, env: process.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("error", error => { throw error; });
server.on("exit", (code, signal) => process.exitCode = signal ? 0 : (code ?? 1));
