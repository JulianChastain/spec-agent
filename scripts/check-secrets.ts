// Fail if any credential from .env, or anything shaped like an OpenRouter
// key, appears in a file outside .env: this repo (results, transcripts,
// logs, dist) and replicate-lang's run results. Prints file names only,
// never the secret.
//
//   npx tsx scripts/check-secrets.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { scrub, secretsFrom } from "./collect.ts";
import { loadEnvFile } from "./experiment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".git"]);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* files(p);
    else if (s.isFile() && (name === ".env.example" || !/^\.env(\..*)?$/.test(name))) yield p;
  }
}

const plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
const secrets = secretsFrom(loadEnvFile(path.join(ROOT, ".env")));
const roots = [ROOT, path.resolve(ROOT, plan.replicateLang, "runs")];
let scanned = 0;
const hits: string[] = [];
for (const r of roots) for (const f of files(r)) {
  scanned++;
  const text = readFileSync(f, "latin1");
  const rel = path.relative(ROOT, f);
  // The real values fail anywhere. The key *shape* fails anywhere but test/,
  // whose fake sk-or- keys exist to exercise the redaction.
  if (secrets.some((s) => text.includes(s))) hits.push(`${rel} (a .env value)`);
  else if (!rel.startsWith("test/") && scrub(text, []).redactions) hits.push(`${rel} (an OpenRouter-shaped key)`);
}
console.log(`scanned ${scanned} files for ${secrets.length} secret(s) and the OpenRouter key shape`);
if (hits.length) { console.error(`FOUND in:\n  ${hits.join("\n  ")}`); process.exitCode = 1; } else console.log("no secrets found");
