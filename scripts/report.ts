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
  costFromCalls: number; // sum of model_call events, as a cross-check
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
    costFromCalls: calls.reduce((a, e) => a + e.costUsd, 0),
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

export function buildSections(all: Run[]): Record<string, string> {
  const two = all.filter((r) => r.budget === "2h").sort((a, b) => a.id.localeCompare(b.id));
  const mainRuns = two.filter((r) => r.compaction);
  // The ablation's "on" arm is the main-matrix runs of the same model.
  const ablModel = two.find((r) => !r.compaction)?.model;
  const ablation = two.filter((r) => r.model === ablModel);
  return {
    results: mainRuns.length ? resultsTable(mainRuns) : "_No 2h runs._",
    smoke: all.some((r) => r.budget !== "2h") ? resultsTable(all.filter((r) => r.budget !== "2h")) : "_No smoke runs._",
    ablation: ablation.length ? resultsTable(ablation) : "_No ablation runs._",
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
  const sections = buildSections(loadAll(dir));
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
