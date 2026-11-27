// The gate before the main matrix: every smoke run must pass every check.
//
//   npx tsx scripts/smoke-check.ts [RESULTS_DIR]
//
// RESULTS_DIR defaults to replicate-lang's runs/results. Checks, per smoke
// (non-2h) run of a model in experiments.json's smoke phase:
//   - it stopped for a sensible reason (not a crash, model errors or nudges);
//   - at least one tool call succeeded;
//   - its logged cost is positive;
//   - every call has an OpenRouter-reported cost, and the price table agrees
//     with it within 3%; the harness meter agrees with the calls within 1%;
//   - every call went to the pinned first-party upstream;
//   - it was graded.
// Secrets are checked separately by scripts/check-secrets.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseModel } from "../src/providers.ts";
import { loadAll, type Run, type UsageSnapshot } from "./report.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SENSIBLE = new Set(["finish", "time budget", "dollar budget", "step limit", "context full"]);
const UPSTREAM: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google AI Studio" };

export function checkRun(r: Run): string[] {
  const fails: string[] = [];
  const frozen = r.agentStop.startsWith("(no result event");
  if (frozen ? !["time budget", "dollar cap"].includes(r.harnessStop) : !SENSIBLE.has(r.agentStop)) {
    fails.push(`stop reason ${r.harnessStop} / ${r.agentStop}`);
  }
  if (r.toolCalls - r.toolErrors < 1) fails.push("no successful tool call");
  if (!(r.costUsd > 0)) fails.push(`cost ${r.costUsd}`);
  if (r.callsWithoutReportedCost) fails.push(`${r.callsWithoutReportedCost} call(s) with no reported cost`);
  if (!r.costReported || Math.abs(r.costPriced - r.costReported) / r.costReported > 0.03) {
    fails.push(`priced $${r.costPriced.toFixed(4)} vs reported $${r.costReported.toFixed(4)}`);
  }
  if (Math.abs(r.costUsd - r.costFromCalls) > Math.max(0.0001, 0.01 * r.costFromCalls)) {
    fails.push(`harness $${r.costUsd} vs calls $${r.costFromCalls.toFixed(4)}`);
  }
  const want = UPSTREAM[parseModel(r.model).vendor];
  if (r.upstreams.length !== 1 || r.upstreams[0] !== want) fails.push(`upstreams ${JSON.stringify(r.upstreams)}, want ${want}`);
  if (r.score === null || r.gradeError) fails.push(`not graded: ${r.gradeError ?? "no score"}`);
  return fails;
}

function main() {
  const plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
  const dir = path.resolve(process.argv[2] ?? path.join(ROOT, plan.replicateLang, "runs", "results"));
  const smoke = plan.phases.smoke;
  const runs = loadAll(dir).filter((r) => r.budget === smoke.budget);
  let failed = 0;
  const latest: Run[] = [];
  for (const spec of smoke.runs) {
    const matching = runs.filter((r) => r.model === spec.model).sort((a, b) => a.run - b.run);
    const r = matching.at(-1); // the latest attempt counts; earlier ones are recorded in DECISIONS.md
    if (!r) { console.log(`MISSING ${spec.model}`); failed++; continue; }
    latest.push(r);
    const fails = checkRun(r);
    console.log(`${fails.length ? "FAIL" : "PASS"} ${r.id}: score ${r.score === null ? "–" : (100 * r.score).toFixed(2) + "%"}, `
      + `$${r.costUsd.toFixed(4)}, ${r.mainCalls} calls, ${r.toolCalls - r.toolErrors}/${r.toolCalls} tool calls ok, `
      + `${r.failedBilledCalls} failed call(s) billed $${r.failedBilledUsd.toFixed(4)}, `
      + `stop ${r.harnessStop} / ${r.agentStop}${fails.length ? `\n    ${fails.join("\n    ")}` : ""}`);
    if (fails.length) failed++;
  }
  // The phase as a whole: the key's spend between the latest smoke-before and
  // smoke-after snapshots must match the meters of the latest attempts, which
  // are the runs that window brackets, within 3%. This catches cost that the
  // per-call figures miss, such as a dropped call OpenRouter still billed.
  const usageDir = path.join(ROOT, "results", "openrouter-usage");
  const snaps: UsageSnapshot[] = existsSync(usageDir)
    ? readdirSync(usageDir).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(usageDir, f), "utf8")) as UsageSnapshot)
      .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
    : [];
  const after = snaps.findLast((x) => x.label === "smoke-after");
  const before = after && snaps.filter((x) => x.label === "smoke-before" && x.takenAt < after.takenAt).at(-1);
  if (!before || !after) { console.log("FAIL no smoke-before/smoke-after usage snapshots"); failed++; }
  else {
    const meters = latest.reduce((a, r) => a + r.costUsd, 0);
    const key = after.usage - before.usage;
    const ok = key > 0 && Math.abs(meters - key) / key <= 0.03;
    console.log(`${ok ? "PASS" : "FAIL"} key spend $${key.toFixed(4)} (${before.takenAt} .. ${after.takenAt}) `
      + `vs meters $${meters.toFixed(4)} of ${latest.map((r) => r.id).join(", ")}`);
    if (!ok) failed++;
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
