// Snapshot what OpenRouter lists as the price of every openrouter:* model in
// experiments.json (and its compaction model), for the pinned endpoint, so
// the price on each run date is on record rather than asserted.
//
//   npx tsx scripts/openrouter-prices.ts <label>
//
// Writes results/openrouter-prices/<UTC date>-<label>.json. The models API is
// public; no key is sent.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cheapModelFor } from "../src/config.ts";
import { OPENROUTER_UPSTREAM, parseModel } from "../src/providers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

export function openRouterModels(plan: any): string[] {
  const keys = new Set<string>();
  for (const phase of Object.values<any>(plan.phases)) for (const r of phase.runs) {
    const ref = parseModel(r.model);
    if (ref.provider !== "openrouter") continue;
    keys.add(ref.key);
    keys.add(cheapModelFor(ref));
  }
  return [...keys].sort();
}

async function main() {
  const label = process.argv[2] ?? "snapshot";
  const plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
  const now = new Date();
  const out: Record<string, unknown> = { retrievedAt: now.toISOString(), models: {} };
  const list = (await (await fetch("https://openrouter.ai/api/v1/models")).json()).data as any[];
  for (const key of openRouterModels(plan)) {
    const ref = parseModel(key);
    const model = list.find((m) => m.id === ref.id);
    const eps = (await (await fetch(`https://openrouter.ai/api/v1/models/${ref.id}/endpoints`)).json()).data?.endpoints ?? [];
    const pinned = eps.find((e: any) => e.tag === OPENROUTER_UPSTREAM[ref.vendor]);
    (out.models as any)[key] = {
      listed: Boolean(model),
      modelPricing: model?.pricing ?? null,
      pinnedEndpoint: OPENROUTER_UPSTREAM[ref.vendor],
      pinnedEndpointPricing: pinned?.pricing ?? null,
      pinnedEndpointStatus: pinned?.status ?? null,
    };
  }
  const dir = path.join(ROOT, "results", "openrouter-prices");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${now.toISOString().slice(0, 10)}-${label}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exitCode = 1; });
