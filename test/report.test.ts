import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSections, loadRun, passedTotal, percentile, usageDeltas } from "../scripts/report.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "spec-agent-fx-python-2h-r1");

describe("report", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([3, 1, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it("reads a run, ignoring a line truncated by the freeze", () => {
    const r = loadRun(fixture)!;
    expect(r.latenciesMs).toEqual([1000, 3000, 2000]); // main calls only
    expect(r.ttftsMs).toEqual([100, 200]); // nulls dropped
    expect(r.compactions).toBe(1);
    expect(r.compactionCalls).toBe(1);
    expect(r.toolErrors).toBe(1);
    expect(r.costFromCalls).toBeCloseTo(0.5, 10);
    expect(r.agentStop).toMatch(/no result event/);
    expect(r.crashed).toBe(false);
    expect(passedTotal(r)).toBe(4);
  });

  it("renders the results table from the files", () => {
    const s = buildSections([loadRun(fixture)!]);
    expect(s.results).toContain("| fx-python-2h-r1 | mock:stub | 50.0% | 3/4 (75.0%) | 1/4 (25.0%) | – | – | 4 | $0.50 | $0.1250 | 2.0 s | 3.0 s | 0.1 s | 10 min | 1 | time budget / (no result event: frozen mid-run) |");
  });

  it("cross-checks priced against reported cost and computes cache share and peak context", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-"));
    writeFileSync(path.join(dir, "result.json"), JSON.stringify({ id: "spec-agent-or-python-10m-r1", tag: "or", model: "openrouter:x/y",
      budget: "10m", run: 1, cost_usd: 0.3, stop_reason: "agent finished", score: 0.1, tiers: {} }));
    const call = (o: object) => JSON.stringify({ type: "model_call", purpose: "main", latencyMs: 1, ttftMs: 1, inputTokens: 1000,
      cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 10, upstream: "Anthropic", ...o });
    writeFileSync(path.join(dir, "transcript.jsonl"), [
      call({ costUsd: 0.1, costUsdPriced: 0.099, costUsdReported: 0.1 }),
      call({ costUsd: 0.2, costUsdPriced: 0.2, costUsdReported: null, inputTokens: 5000, cacheReadTokens: 0 }),
      JSON.stringify({ type: "message", message: { role: "user", content: "You replied without calling a tool. Nobody..." } }),
      JSON.stringify({ type: "result", stop_reason: "finish" }),
    ].join("\n"));
    const r = loadRun(dir)!;
    expect(r.costPriced).toBeCloseTo(0.299, 10);
    expect(r.costReported).toBeCloseTo(0.1, 10);
    expect(r.callsWithoutReportedCost).toBe(1);
    expect(r.upstreams).toEqual(["Anthropic"]);
    expect(r.mainCacheReadTokens / r.mainInputTokens).toBeCloseTo(600 / 6000, 10);
    expect(r.peakContextTokens).toBe(5050);
    expect(r.nudges).toBe(1);
    expect(buildSections([r]).costcheck).toContain("| or-python-10m-r1 | $0.2990 | $0.1000 | +199.00% | 1 | $0.3000 | 0 |");
  });

  it("pairs each <phase>-before usage snapshot with the next <phase>-after", () => {
    const snap = (label: string, takenAt: string, usage: number) => ({ label, takenAt, usage });
    expect(usageDeltas([
      snap("smoke-after", "2026-11-27T02", 1.5), snap("smoke-before", "2026-11-27T01", 1.0),
      snap("smoke-before", "2026-11-27T03", 2.0), snap("smoke-after", "2026-11-27T04", 2.25), // a re-run
      snap("main-before", "2026-11-27T05", 3.0), // never finished: no window
    ])).toEqual({ smoke: { delta: 0.75, windows: 2 } });
  });
});
