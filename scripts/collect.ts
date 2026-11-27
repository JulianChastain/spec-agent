// Copy finished spec-agent runs from replicate-lang into results/, so the
// writeup can cite transcripts by file and line. Any value from .env (API
// keys) found in a file is redacted, and reported, before it is written, and
// so is anything shaped like an OpenRouter key, whether or not it's in .env.
//
//   npx tsx scripts/collect.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "./experiment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The .env values that are credentials: by name, long enough to be real. */
export function secretsFrom(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|OPENROUTER/i.test(k) && v.length >= 8)
    .map(([, v]) => v);
}

// OpenRouter keys look like sk-or-v1-<64 hex>; match any sk-or- key.
const OPENROUTER_KEY_SHAPE = /sk-or-[A-Za-z0-9-]{16,}/g;

/** Redact every secret, and every OpenRouter-shaped key, from `text`. */
export function scrub(text: string, secrets: string[]): { text: string; redactions: number } {
  let redactions = 0;
  for (const s of secrets) {
    if (!text.includes(s)) continue;
    redactions += text.split(s).length - 1;
    text = text.split(s).join("[REDACTED]");
  }
  text = text.replace(OPENROUTER_KEY_SHAPE, () => { redactions++; return "[REDACTED]"; });
  return { text, redactions };
}

function main() {
  const plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
  const src = path.resolve(ROOT, plan.replicateLang, "runs", "results");
  const dst = path.join(ROOT, "results");
  const secrets = secretsFrom(loadEnvFile(path.join(ROOT, ".env")));

  const copyScrubbed = (from: string, to: string, label: string) => {
    const { text, redactions } = scrub(readFileSync(from, "utf8"), secrets);
    if (redactions) console.warn(`REDACTED ${redactions} secret(s) in ${label}`);
    writeFileSync(to, text);
  };

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
}

if (import.meta.url === `file://${process.argv[1]}`) main();
