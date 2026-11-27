// Build every results table in WRITEUP.md from the logged files.
//
//   npx tsx scripts/report.ts [RESULTS_DIR] [--write]
//
// RESULTS_DIR (default results/) holds one directory per run, as written by
// replicate-lang's harness: result.json, grade.json, transcript.jsonl. With
// --write, the tables replace the <!-- report:NAME --> ... <!-- /report:NAME -->
// blocks in WRITEUP.md; without it they're printed. No number in the tables
// is typed by hand.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

export interface Run {
  id: string;
  tag: string;
  model: string;
  budget: string;
  run: number;
  compaction: boolean;
  harnessStop: string; // the harness's view: agent finished / time budget / dollar cap
  agentStop: string; // the agent's own result event, if it got to write one
  crashed: boolean;
  gradeError: string | null;
  score: number | null;
  tiers: Record<string, { passed: number; total: number }>;
  costUsd: number; // the harness's figure (result.json)
  costFromCalls: number; // sum of model_call events' costUsd, as a cross-check
  costPriced: number; // sum of our price-table figure (costUsdPriced; costUsd for older runs)
  costReported: number; // sum of the provider's own per-call figure, where it sent one
  callsWithoutReportedCost: number;
  upstreams: string[]; // hosts OpenRouter routed to (empty for direct APIs)
  inputTokens: number; // all calls, including cached
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  mainInputTokens: number; // main-loop calls only, for the cache-read share
  mainCacheReadTokens: number;
  peakContextTokens: number; // largest input + output of any main call
  nudges: number;
  mainCalls: number;
  compactionCalls: number;
  latenciesMs: number[]; // main-loop calls only
  ttftsMs: number[];
  wallS: number;
  compactions: number;
  toolCalls: number;
  toolErrors: number;
  modelErrors: number;
}

const sum = (xs: any[], f: (x: any) => unknown) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export function readJsonl(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; } // a line cut off by the freeze
  });
}

export function loadRun(dir: string): Run | null {
  const resultFile = path.join(dir, "result.json");
  if (!existsSync(resultFile)) return null;
  const r = JSON.parse(readFileSync(resultFile, "utf8"));
  const events = readJsonl(path.join(dir, "transcript.jsonl"));
  const calls = events.filter((e) => e.type === "model_call");
  const main = calls.filter((e) => e.purpose === "main");
  const final = events.findLast((e) => e.type === "result");
  const tiers: Run["tiers"] = {};
  for (const [t, v] of Object.entries<any>(r.tiers ?? {})) tiers[t] = { passed: v.passed, total: v.total };
  return {
    id: r.id,
    tag: r.tag ?? r.id,
    model: r.model,
    budget: r.budget,
    run: r.run,
    compaction: !String(r.agent_args ?? "").includes("--no-compaction"),
    harnessStop: r.stop_reason,
    agentStop: final?.stop_reason ?? "(no result event: frozen mid-run)",
    crashed: final?.stop_reason === "crash" || r.grade_error != null || r.score == null,
    gradeError: r.grade_error ?? null,
    score: r.score ?? null,
    tiers,
    costUsd: r.cost_usd,
    costFromCalls: sum(calls, (e) => e.costUsd),
    costPriced: sum(calls, (e) => e.costUsdPriced ?? e.costUsd),
    costReported: sum(calls, (e) => e.costUsdReported ?? 0),
    callsWithoutReportedCost: calls.filter((e) => typeof e.costUsdReported !== "number").length,
    upstreams: [...new Set(calls.map((e) => e.upstream).filter((u: unknown): u is string => typeof u === "string"))].sort(),
    inputTokens: sum(calls, (e) => e.inputTokens),
    cacheReadTokens: sum(calls, (e) => e.cacheReadTokens),
    cacheWriteTokens: sum(calls, (e) => e.cacheWriteTokens),
    outputTokens: sum(calls, (e) => e.outputTokens),
    reasoningTokens: sum(calls, (e) => e.reasoningTokens),
    mainInputTokens: sum(main, (e) => e.inputTokens),
    mainCacheReadTokens: sum(main, (e) => e.cacheReadTokens),
    peakContextTokens: Math.max(0, ...main.map((e) => (e.inputTokens ?? 0) + (e.outputTokens ?? 0))),
    nudges: events.filter((e) => e.type === "message" && e.message?.role === "user"
      && JSON.stringify(e.message.content).includes("You replied without calling a tool")).length,
    mainCalls: main.length,
    compactionCalls: calls.length - main.length,
    latenciesMs: main.map((e) => e.latencyMs),
    ttftsMs: main.map((e) => e.ttftMs).filter((x: number | null) => x !== null),
    wallS: r.wall_s,
    compactions: events.filter((e) => e.type === "compaction").length,
    toolCalls: events.filter((e) => e.type === "tool_call").length,
    toolErrors: events.filter((e) => e.type === "tool_call" && !e.ok).length,
    modelErrors: events.filter((e) => e.type === "model_call_error").length,
  };
}

/** Nearest-rank percentile: the smallest value with at least p% of values at or below it. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
}

const pct = (x: number | null) => (x === null ? "–" : `${(100 * x).toFixed(1)}%`);
const usd = (x: number) => `$${x.toFixed(2)}`;
const secs = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const mins = (s: number) => `${(s / 60).toFixed(0)} min`;
const tierCell = (r: Run, t: string) => {
  const v = r.tiers[t];
  return v ? `${v.passed}/${v.total} (${pct(v.passed / v.total)})` : "–";
};
export const passedTotal = (r: Run) => Object.values(r.tiers).reduce((a, v) => a + v.passed, 0);

function resultsTable(runs: Run[]): string {
  const head = "| Run | Model | Score | T1 | T2 | T3 | T4 | Passed | Cost | $/passed | Median call | p95 call | Median TTFT | Wall | Compactions | Stop (harness / agent) |";
  const rows = runs.map((r) => {
    const passed = passedTotal(r);
    const status = r.crashed ? "**CRASH** " : "";
    return `| ${r.id.replace(/^spec-agent-/, "")} | ${r.model} | ${status}${pct(r.score)} | ${tierCell(r, "1")} | ${tierCell(r, "2")} | ${tierCell(r, "3")} | ${tierCell(r, "4")} | ${passed} | ${usd(r.costUsd)} | ${passed ? `$${(r.costUsd / passed).toFixed(4)}` : "–"} | ${secs(percentile(r.latenciesMs, 50))} | ${secs(percentile(r.latenciesMs, 95))} | ${secs(percentile(r.ttftsMs, 50))} | ${mins(r.wallS)} | ${r.compactions} | ${r.harnessStop} / ${r.agentStop} |`;
  });
  return [head, head.replace(/[^|]+/g, " --- "), ...rows].join("\n");
}

function activityTable(runs: Run[]): string {
  const head = "| Run | Model calls (main + compaction) | Tool calls | Tool errors | Model-call errors | Logged call cost vs harness cost |";
  const rows = runs.map((r) =>
    `| ${r.id.replace(/^spec-agent-/, "")} | ${r.mainCalls} + ${r.compactionCalls} | ${r.toolCalls} | ${r.toolErrors} | ${r.modelErrors} | ${usd(r.costFromCalls)} vs ${usd(r.costUsd)} |`);
  return [head, head.replace(/[^|]+/g, " --- "), ...rows].join("\n");
}

function spendTable(all: Run[]): string {
  const by = (pred: (r: Run) => boolean) => all.filter(pred).reduce((a, r) => a + r.costUsd, 0);
  const smoke = by((r) => r.budget !== "2h");
  const main = by((r) => r.budget === "2h");
  return [
    "| Phase | Runs | Spend |", "| --- | ---: | ---: |",
    `| smoke (short budget) | ${all.filter((r) => r.budget !== "2h").length} | ${usd(smoke)} |`,
    `| 2h runs | ${all.filter((r) => r.budget === "2h").length} | ${usd(main)} |`,
    `| **total** | ${all.length} | **${usd(smoke + main)}** |`,
  ].join("\n");
}

const short = (r: Run) => r.id.replace(/^spec-agent-/, "");
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n));
const share = (a: number, b: number) => (b ? pct(a / b) : "–");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const table = (head: string, rows: string[]) => [head, head.replace(/[^|]+/g, " --- "), ...rows].join("\n");

/** Runs grouped by tag (one model + settings), in first-seen order. */
function byTag(runs: Run[]): [string, Run[]][] {
  const m = new Map<string, Run[]>();
  for (const r of runs) m.set(r.tag, [...(m.get(r.tag) ?? []), r]);
  return [...m.entries()].map(([t, rs]) => [t, rs.sort((a, b) => a.run - b.run)]);
}

/** Score by model at an equal cap: both runs and the mean (n = 2 per cell). */
function headlineTable(runs: Run[]): string {
  const rows = byTag(runs).map(([, rs]) => {
    const scores = rs.map((r) => r.score).filter((x): x is number => x !== null);
    const m = mean(scores);
    const c = mean(rs.map((r) => r.costUsd))!;
    const each = (f: (r: Run) => string) => rs.map(f).join(" / ");
    return `| ${rs[0]!.model} | ${each((r) => (r.crashed ? "**CRASH** " : "") + pct(r.score))} | **${pct(m)}** | ${each((r) => usd(r.costUsd))} | `
      + `${each((r) => String(r.mainCalls))} | ${each((r) => `${r.harnessStop} / ${r.agentStop}`)} | `
      + `${m === null || !c ? "–" : `${(100 * m / c).toFixed(2)} pts/$`} |`;
  });
  return table("| Model | Score (r1 / r2) | Mean | Cost (r1 / r2) | Steps (r1 / r2) | Stop, harness / agent (r1 / r2) | Mean score per mean $ |", rows);
}

function tierTable(runs: Run[]): string {
  const tiers = [...new Set(runs.flatMap((r) => Object.keys(r.tiers)))].sort();
  const rows = byTag(runs).flatMap(([, rs]) => [
    ...rs.map((r) => `| ${short(r)} | ${tiers.map((t) => tierCell(r, t)).join(" | ")} |`),
    `| **${rs[0]!.model} mean** | ${tiers.map((t) => {
      const v = rs.map((r) => r.tiers[t]).filter(Boolean).map((x) => x!.passed / x!.total);
      return `**${pct(mean(v))}**`;
    }).join(" | ")} |`,
  ]);
  return table(`| Run | ${tiers.map((t) => `Tier ${t}`).join(" | ")} |`, rows);
}

function ablationTable(runs: Run[]): string {
  const rows = runs.map((r) => `| ${short(r)} | ${r.compaction ? "on" : "off"} | ${pct(r.score)} | ${usd(r.costUsd)} | ${r.mainCalls} | `
    + `${r.compactions} | ${tok(r.peakContextTokens)} | ${share(r.mainCacheReadTokens, r.mainInputTokens)} | ${r.harnessStop} / ${r.agentStop} |`);
  const arm = (on: boolean) => runs.filter((r) => r.compaction === on);
  const summary = [true, false].map((on) => {
    const rs = arm(on);
    const sc = rs.map((r) => r.score).filter((x): x is number => x !== null);
    return `| **compaction ${on ? "on" : "off"}, mean** | | **${pct(mean(sc))}** (range ${pct(sc.length ? Math.min(...sc) : null)}–${pct(sc.length ? Math.max(...sc) : null)}) | `
      + `${usd(mean(rs.map((r) => r.costUsd)) ?? 0)} | ${mean(rs.map((r) => r.mainCalls))?.toFixed(0) ?? "–"} | ${mean(rs.map((r) => r.compactions))?.toFixed(1) ?? "–"} | | | |`;
  });
  return table("| Run | Compaction | Score | Cost | Steps | Compactions | Peak context | Cache-read share (main) | Stop, harness / agent |", [...rows, ...summary]);
}

function telemetryTable(runs: Run[]): string {
  const rows = byTag(runs).map(([, rs]) => {
    const lat = rs.flatMap((r) => r.latenciesMs);
    const ttft = rs.flatMap((r) => r.ttftsMs);
    const s3 = (xs: number[]) => [50, 90, 95].map((p) => secs(percentile(xs, p))).join(" / ");
    const t = (f: (r: Run) => number) => rs.reduce((a, r) => a + f(r), 0);
    return `| ${rs[0]!.model}${rs[0]!.compaction ? "" : " (no compaction)"} | ${t((r) => r.mainCalls)} | ${tok(t((r) => r.inputTokens))} | `
      + `${tok(t((r) => r.cacheReadTokens))} (${share(t((r) => r.cacheReadTokens), t((r) => r.inputTokens))}) | ${tok(t((r) => r.cacheWriteTokens))} | `
      + `${tok(t((r) => r.outputTokens))} | ${tok(t((r) => r.reasoningTokens))} | ${s3(ttft)} | ${s3(lat)} | ${[...new Set(rs.flatMap((r) => r.upstreams))].join(", ") || "direct"} |`;
  });
  return table("| Model (both runs pooled) | Main calls | Input tokens | Cache reads (share) | Cache writes | Output | of which reasoning | TTFT p50 / p90 / p95 | Call latency p50 / p90 / p95 | Upstream |", rows);
}

export interface UsageSnapshot { label: string; takenAt: string; usage: number }

/** Spend on the key between each `<phase>-before` and the next `<phase>-after` snapshot. */
export function usageDeltas(snaps: UsageSnapshot[]): Record<string, { delta: number; windows: number }> {
  const out: Record<string, { delta: number; windows: number }> = {};
  const sorted = [...snaps].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  for (const [i, b] of sorted.entries()) {
    const m = b.label.match(/^(.+)-before$/);
    if (!m) continue;
    const a = sorted.slice(i + 1).find((x) => x.label === `${m[1]}-after` || x.label === `${m[1]}-before`);
    if (!a || a.label !== `${m[1]}-after`) continue;
    const o = (out[m[1]!] ??= { delta: 0, windows: 0 });
    o.delta += a.usage - b.usage;
    o.windows++;
  }
  return out;
}

const PHASE_OF = (r: Run) => (r.budget === "2h" ? "main" : "smoke");
const diff = (a: number, b: number) => (b ? `${(100 * (a - b) / b >= 0 ? "+" : "")}${(100 * (a - b) / b).toFixed(2)}%` : "–");

function costCheckTable(all: Run[], snaps: UsageSnapshot[]): string {
  const rows = all.map((r) => `| ${short(r)} | ${usd4(r.costPriced)} | ${usd4(r.costReported)} | ${diff(r.costPriced, r.costReported)} | `
    + `${r.callsWithoutReportedCost} | ${usd4(r.costUsd)} | ${r.modelErrors} |`);
  const runs = table("| Run | Priced (src/pricing.ts) | Reported by OpenRouter | Priced vs reported | Calls with no reported cost | Harness meter | Failed calls (unpriced) |", rows);
  const deltas = usageDeltas(snaps);
  const phases = ["smoke", "main"].filter((p) => all.some((r) => PHASE_OF(r) === p)).map((p) => {
    const rs = all.filter((r) => PHASE_OF(r) === p);
    const harness = rs.reduce((a, r) => a + r.costUsd, 0);
    const d = deltas[p];
    return `| ${p} | ${rs.length} | ${usd4(harness)} | ${d ? usd4(d.delta) : "–"} | ${d ? diff(harness, d.delta) : "–"} | ${d?.windows ?? 0} |`;
  });
  return `${runs}\n\n${table("| Phase | Runs | Sum of harness meters | Key spend over the phase (GET /api/v1/key) | Meters vs key | Snapshot windows |", phases)}`;
}
const usd4 = (x: number) => `$${x.toFixed(4)}`;

export function buildSections(all: Run[], snaps: UsageSnapshot[] = []): Record<string, string> {
  const two = all.filter((r) => r.budget === "2h").sort((a, b) => a.id.localeCompare(b.id));
  const mainRuns = two.filter((r) => r.compaction);
  // The ablation's "on" arm is the main-matrix runs of the same model.
  const ablModel = two.find((r) => !r.compaction)?.model;
  const ablation = two.filter((r) => r.model === ablModel);
  return {
    results: mainRuns.length ? resultsTable(mainRuns) : "_No 2h runs._",
    smoke: all.some((r) => r.budget !== "2h") ? resultsTable(all.filter((r) => r.budget !== "2h")) : "_No smoke runs._",
    headline: mainRuns.length ? headlineTable(mainRuns) : "_No 2h runs._",
    tiers: mainRuns.length ? tierTable(mainRuns) : "_No 2h runs._",
    ablation: ablation.length ? ablationTable(ablation) : "_No ablation runs._",
    telemetry: two.length ? telemetryTable(two) : "_No 2h runs._",
    costcheck: all.length ? costCheckTable(all, snaps) : "_No runs._",
    activity: two.length ? activityTable(two) : "_No 2h runs._",
    spend: spendTable(all),
  };
}

export function loadAll(dir: string): Run[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => d.startsWith("spec-agent-") && !d.startsWith("spec-agent-mock-"))
    .map((d) => loadRun(path.join(dir, d)))
    .filter((r): r is Run => r !== null);
}

function main() {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(ROOT, "results"));
  const usageDir = path.join(dir, "openrouter-usage");
  const snaps: UsageSnapshot[] = existsSync(usageDir)
    ? readdirSync(usageDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(usageDir, f), "utf8")))
    : [];
  const sections = buildSections(loadAll(dir), snaps);
  if (!args.includes("--write")) {
    for (const [k, v] of Object.entries(sections)) console.log(`## ${k}\n\n${v}\n`);
    return;
  }
  const file = path.join(ROOT, "WRITEUP.md");
  let s = readFileSync(file, "utf8");
  for (const [k, v] of Object.entries(sections)) {
    const re = new RegExp(`<!-- report:${k} -->[\\s\\S]*?<!-- /report:${k} -->`);
    if (!re.test(s)) throw new Error(`WRITEUP.md has no report:${k} block`);
    s = s.replace(re, () => `<!-- report:${k} -->\n${v}\n<!-- /report:${k} -->`);
  }
  writeFileSync(file, s);
  console.log(`updated ${Object.keys(sections).length} tables in WRITEUP.md from ${dir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
