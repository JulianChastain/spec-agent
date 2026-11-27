// Snapshot the OpenRouter key's cumulative spend (GET /api/v1/key), so the
// report can check the sum of a phase's per-call costs against what
// OpenRouter says the key spent over the same interval. /api/v1/credits
// would give the account balance, but it needs a management key; this needs
// only the key the runs use. Only numeric usage fields are kept: the key's
// label can contain part of the key, so it is never written.
//
//   npx tsx scripts/openrouter-usage.ts <label>
//
// Writes results/openrouter-usage/<ISO time>-<label>.json.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "./experiment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FIELDS = ["usage", "usage_daily", "usage_weekly", "usage_monthly", "limit", "limit_remaining", "is_free_tier"] as const;

export function pickUsage(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(FIELDS.filter((f) => f in data).map((f) => [f, data[f]]));
}

export async function snapshotUsage(apiKey: string, label: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /api/v1/key: HTTP ${res.status}`);
  const data = ((await res.json()) as any).data ?? {};
  const now = new Date().toISOString();
  const dir = path.join(ROOT, "results", "openrouter-usage");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${now.replace(/[:.]/g, "-")}-${label}.json`);
  writeFileSync(file, JSON.stringify({ label, takenAt: now, ...pickUsage(data) }, null, 1) + "\n");
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = loadEnvFile(path.join(ROOT, ".env")).OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not in .env");
  snapshotUsage(key, process.argv[2] ?? "manual").then((f) => console.log(`wrote ${path.relative(ROOT, f)}`),
    (e) => { console.error(String(e)); process.exitCode = 1; });
}
