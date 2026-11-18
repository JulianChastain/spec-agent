import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSections, loadRun, passedTotal, percentile } from "../scripts/report.ts";

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
});
