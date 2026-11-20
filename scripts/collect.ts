// Copy finished spec-agent runs from replicate-lang into results/, so the
// writeup can cite transcripts by file and line. Any value from .env (API
// keys) found in a file is redacted, and reported, before it is written.
//
//   npx tsx scripts/collect.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "./experiment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
const src = path.resolve(ROOT, plan.replicateLang, "runs", "results");
const dst = path.join(ROOT, "results");
const secrets = Object.entries(loadEnvFile(path.join(ROOT, ".env")))
  .filter(([k, v]) => /KEY|TOKEN|SECRET/.test(k) && v.length >= 8)
  .map(([, v]) => v);

function copyScrubbed(from: string, to: string, label: string) {
  let text = readFileSync(from, "utf8");
  for (const s of secrets) {
    if (text.includes(s)) {
      console.warn(`REDACTED a secret in ${label}`);
      text = text.split(s).join("[REDACTED]");
    }
  }
  writeFileSync(to, text);
}

let copied = 0;
for (const d of readdirSync(src)) {
  if (!d.startsWith("spec-agent-") || d.startsWith("spec-agent-mock-")) continue;
  if (!existsSync(path.join(src, d, "result.json"))) continue; // still running
  mkdirSync(path.join(dst, d), { recursive: true });
  for (const f of readdirSync(path.join(src, d))) copyScrubbed(path.join(src, d, f), path.join(dst, d, f), `${d}/${f}`);
  copied++;
}
// The harness's own log of each run (its stdout and stderr), for crash forensics.
const logs = path.join(ROOT, "runs", "logs");
if (existsSync(logs)) {
  mkdirSync(path.join(dst, "harness-logs"), { recursive: true });
  for (const f of readdirSync(logs)) copyScrubbed(path.join(logs, f), path.join(dst, "harness-logs", f), `harness-logs/${f}`);
}
console.log(`collected ${copied} runs into results/`);
