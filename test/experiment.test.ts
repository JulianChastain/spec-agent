import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile, runId, spentSoFar } from "../scripts/experiment.ts";

describe("spend guard accounting", () => {
  it("sums actual cost of finished runs, skips mock runs, and lists unfinished ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "results-"));
    const put = (id: string, cost?: number) => {
      mkdirSync(path.join(dir, id));
      if (cost !== undefined) writeFileSync(path.join(dir, id, "result.json"), JSON.stringify({ cost_usd: cost }));
    };
    put("spec-agent-a-python-2h-r1", 1.25);
    put("spec-agent-b-python-2h-r1", 2.5);
    put("spec-agent-mock-python-3m-r1", 99); // mock: never counted
    put("claude-python-2h-r1", 50); // another agent's run: not ours
    put("spec-agent-c-python-2h-r1"); // no result.json: in flight or crashed
    expect(spentSoFar(dir)).toEqual({ total: 3.75, unfinished: ["spec-agent-c-python-2h-r1"] });
  });

  it("builds the same run id as the harness", () => {
    expect(runId("python", "2h", { model: "m", tag: "opus-5-5", run: 2 })).toBe("spec-agent-opus-5-5-python-2h-r2");
  });

  it("parses .env, ignoring comments, blanks and quotes", () => {
    const f = path.join(mkdtempSync(path.join(tmpdir(), "env-")), ".env");
    writeFileSync(f, "# c\nA_API_KEY='sk-1'\nEMPTY=\nMAX_TOTAL_USD = 60\n");
    expect(loadEnvFile(f)).toEqual({ A_API_KEY: "sk-1", MAX_TOTAL_USD: "60" });
  });
});
