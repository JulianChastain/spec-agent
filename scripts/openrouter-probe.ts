// Check, on real calls, that each OpenRouter model reports cached tokens and
// a billed cost, and that our price table agrees with that cost. Sends the
// agent's own call shape: the spec as the pinned first message, then three
// calls that share that prefix, with withCacheBreakpoints() applied exactly
// as the loop applies it.
//
//   npx tsx scripts/openrouter-probe.ts [model ...]
//
// Writes results/openrouter-probe/<ISO time>.json (no key, only numbers).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { callModel } from "../src/llm.ts";
import { createModel, parseModel, withCacheBreakpoints } from "../src/providers.ts";
import { loadEnvFile } from "./experiment.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT = [
  "openrouter:openai/gpt-6.2-astra", "openrouter:openai/gpt-6-luna",
  "openrouter:anthropic/claude-opus-5.5", "openrouter:anthropic/claude-haiku-5.5",
  "openrouter:google/gemini-4-carbon", "openrouter:google/gemini-3.5-flash-lite",
];

async function main() {
  process.env.OPENROUTER_API_KEY = loadEnvFile(path.join(ROOT, ".env")).OPENROUTER_API_KEY;
  const plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
  const spec = readFileSync(path.resolve(ROOT, plan.replicateLang, "spec", "SPEC.md"), "utf8");
  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  const out: any = { takenAt: new Date().toISOString(), specChars: spec.length, models: {} };
  for (const key of models) {
    const ref = parseModel(key);
    const model = createModel(ref);
    let history: ModelMessage[] = [{ role: "user", content: `Read this spec; you will be asked about it.\n\n${spec}` }];
    const calls = [];
    for (let i = 0; i < 3; i++) {
      if (i) history = [...history, { role: "user", content: `Question ${i}: in one word, is the spec about a programming language?` }];
      try {
        const r = await callModel({
          ref, model, instructions: "Answer in at most five words.", messages: withCacheBreakpoints(ref, history, 1),
          maxOutputTokens: 2_000, step: i, purpose: "main",
        });
        history = [...history, ...r.responseMessages];
        const e = r.event;
        calls.push({
          inputTokens: e.inputTokens, cacheReadTokens: e.cacheReadTokens, cacheWriteTokens: e.cacheWriteTokens,
          outputTokens: e.outputTokens, reasoningTokens: e.reasoningTokens, costUsdReported: e.costUsdReported,
          costUsdPriced: e.costUsdPriced, upstream: e.upstream, ttftMs: e.ttftMs, latencyMs: e.latencyMs,
        });
        console.log(`${key} #${i}: in ${e.inputTokens} (read ${e.cacheReadTokens}, write ${e.cacheWriteTokens}) out ${e.outputTokens} `
          + `reported $${e.costUsdReported?.toFixed(5)} priced $${e.costUsdPriced.toFixed(5)} via ${e.upstream}`);
      } catch (err) {
        calls.push({ error: String(err).slice(0, 300) });
        console.log(`${key} #${i}: ERROR ${String(err).slice(0, 300)}`);
      }
      await new Promise((res) => setTimeout(res, 3_000));
    }
    out.models[key] = calls;
  }
  const dir = path.join(ROOT, "results", "openrouter-probe");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${out.takenAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

main().catch((e) => { console.error(String(e)); process.exitCode = 1; });
