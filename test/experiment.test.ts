import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { harnessArgs, loadEnvFile, PROVIDER_KEYS, runId, spentSoFar } from "../scripts/experiment.ts";
import { execFileSync } from "node:child_process";
import { pickUsage } from "../scripts/openrouter-usage.ts";

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

  it("passes the OpenRouter key to the harness", () => {
    expect(PROVIDER_KEYS).toContain("OPENROUTER_API_KEY");
  });

  it("keeps only numeric usage from GET /api/v1/key, never the label", () => {
    expect(pickUsage({ label: "sk-or-v1-abc...xyz", usage: 1.5, limit_remaining: 48.5, is_free_tier: false }))
      .toEqual({ usage: 1.5, limit_remaining: 48.5, is_free_tier: false });
  });

  it("passes --agent-args so that argparse accepts a value starting with --", () => {
    const args = harnessArgs("python", { budget: "2h", cap: 6.5 }, { model: "openrouter:google/gemini-4-carbon", tag: "carbon-4-nocompact", run: 1, agentArgs: "--no-compaction" });
    expect(args.slice(-1)).toEqual(["--agent-args=--no-compaction"]);
    // The same argparse declaration as runs/run_agent.py, fed these arguments.
    const parsed = execFileSync("python3", ["-I", "-c", [
      "import argparse, sys, json",
      "ap = argparse.ArgumentParser(); [ap.add_argument(a) for a in ('agent', 'lang', 'budget', 'run')]",
      "ap.add_argument('--cap', type=float, required=True); ap.add_argument('--model'); ap.add_argument('--tag'); ap.add_argument('--agent-args', default='')",
      "print(json.dumps(vars(ap.parse_args(sys.argv[1:]))))",
    ].join("\n"), ...args.slice(1)], { encoding: "utf8" });
    expect(JSON.parse(parsed).agent_args).toBe("--no-compaction");
    expect(harnessArgs("python", { budget: "2h", cap: 6.5 }, { model: "m:x", tag: "t", run: 2 })).not.toContain("--agent-args");
  });
});
