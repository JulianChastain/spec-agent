import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { costOf } from "../src/pricing.ts";
import { withCacheBreakpoints, parseModel } from "../src/providers.ts";
import { config, prompts, run, scripted, workspace } from "./helpers.ts";

describe("the loop", () => {
  it("runs tool calls, feeds results back, and stops on finish", async () => {
    const root = workspace();
    const model = scripted([
      { tools: [{ name: "write_file", input: { path: "out.txt", content: "hello" } }] },
      { tools: [{ name: "run_shell", input: { command: "cat out.txt" } }] },
      { tools: [{ name: "finish", input: { summary: "done" } }] },
    ]);
    const { result, telemetry } = await run(config({ workspace: root }), model);
    expect(result).toMatchObject({ stopReason: "finish", steps: 3, finishSummary: "done" });
    expect(readFileSync(path.join(root, "out.txt"), "utf8")).toBe("hello");
    // The second call saw the first tool's result; the third saw the shell output.
    expect(prompts(model)[1]).toContain("wrote out.txt");
    expect(prompts(model)[2]).toContain("exit code 0\\nhello");
    expect(telemetry.calls()).toHaveLength(3);
    expect(telemetry.events.at(-1)).toMatchObject({ type: "result", stop_reason: "finish" });
  });

  it("returns a bad tool call to the model as an error result and keeps going", async () => {
    const model = scripted([
      { tools: [{ name: "edit_file", input: { path: "nope.txt" } }] }, // missing old_string/new_string
      { tools: [{ name: "does_not_exist", input: {} }] },
      { tools: [{ name: "finish", input: { summary: "ok" } }] },
    ]);
    const { result } = await run(config({ workspace: workspace() }), model);
    expect(result.stopReason).toBe("finish");
    expect(prompts(model)[1]).toContain("invalid arguments for edit_file");
    expect(prompts(model)[2]).toContain("does_not_exist");
  });

  it("runs several tool calls from one reply, in order", async () => {
    const root = workspace();
    const model = scripted([
      { tools: [
        { name: "write_file", input: { path: "a", content: "1" } },
        { name: "run_shell", input: { command: "cat a" } },
      ] },
      { tools: [{ name: "finish", input: { summary: "" } }] },
    ]);
    await run(config({ workspace: root }), model);
    expect(prompts(model)[1]).toContain("exit code 0\\n1");
  });

  it("nudges a model that stops calling tools, then gives up", async () => {
    const model = scripted([{ text: "I will now think about it." }]);
    const { result } = await run(config({ workspace: workspace() }), model);
    expect(result.stopReason).toBe("no tool calls");
    expect(model.doStreamCalls).toHaveLength(4); // the reply, then 3 nudges
    expect(prompts(model)[1]).toContain("You replied without calling a tool");
  });

  it("stops after repeated model errors", async () => {
    const { result, telemetry } = await run(config({ workspace: workspace() }), scripted([{ error: "500 overloaded" }]));
    expect(result.stopReason).toBe("model error");
    expect(telemetry.events.filter((e) => e.type === "model_call_error")).toHaveLength(3);
  });

  it("adds a budget status line to the newest tool result", async () => {
    const model = scripted([{ tools: [{ name: "list_dir", input: {} }] }, { tools: [{ name: "finish", input: { summary: "" } }] }]);
    await run(config({ workspace: workspace(), maxSteps: 10, budgetUsd: 2 }), model);
    expect(prompts(model)[1]).toMatch(/\[status: [\dhm]+ left, \$2\.00 of \$2\.00 left, 1\/10 steps used\]/);
  });
});

describe("budget stops", () => {
  const loopForever = () => scripted([{ tools: [{ name: "run_shell", input: { command: "true" } }] }]);

  it("stops at the step limit", async () => {
    const model = loopForever();
    const { result } = await run(config({ workspace: workspace(), maxSteps: 4 }), model);
    expect(result).toMatchObject({ stopReason: "step limit", steps: 4 });
    expect(model.doStreamCalls).toHaveLength(4);
  });

  it("stops before a call that would pass the dollar budget", async () => {
    // Billed as Opus 5.5: 1000 input + 100 output tokens = $0.006 per call.
    const perCall = costOf("anthropic:claude-opus-5-5", { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 });
    expect(perCall).toBeCloseTo(0.006, 10);
    const { result } = await run(config({ workspace: workspace(), budgetUsd: 0.5 }), loopForever(), { priceAs: "anthropic:claude-opus-5-5" });
    expect(result.stopReason).toBe("dollar budget");
    // It never overspends. It stops early by at most one call plus the
    // output reserve (2,000 tokens at $20/M = $0.04).
    expect(result.costUsd).toBeLessThanOrEqual(0.5);
    expect(result.costUsd).toBeGreaterThan(0.5 - perCall - 0.04 - 1e-9);
  });

  it("stops when the wall-clock budget runs out", async () => {
    let clock = 0;
    const model = loopForever();
    // Each call to now() advances the fake clock by 10 s.
    const { result } = await run(config({ workspace: workspace(), timeBudgetS: 100 }), model, { now: () => (clock += 10_000) });
    expect(result.stopReason).toBe("time budget");
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    expect(model.doStreamCalls.length).toBeLessThan(10);
  });

  it("doesn't crash when the time left isn't a whole number of milliseconds", async () => {
    // The Carbon smoke run crashed on a delay of 323943.99999999994 ms:
    // AbortSignal.timeout() only takes integers. 32,041 ms into a 600 s
    // budget, (600 - 32.041) * 1000 = 567959.0000000001.
    let first = true;
    const now = () => (first ? ((first = false), 0) : 32_041);
    const { result } = await run(config({ workspace: workspace(), timeBudgetS: 600, maxSteps: 2 }), loopForever(), { now });
    expect(result.stopReason).toBe("step limit");
  });
});

describe("pricing", () => {
  it("prices cache reads, cache writes and fresh input separately", () => {
    // 10k prompt tokens: 6k read from cache, 1k written, 3k fresh; 2k output.
    const c = costOf("anthropic:claude-opus-5-5", { inputTokens: 10_000, cacheReadTokens: 6_000, cacheWriteTokens: 1_000, outputTokens: 2_000 });
    expect(c).toBeCloseTo((3_000 * 4 + 6_000 * 0.2 + 1_000 * 5 + 2_000 * 20) / 1e6, 12);
  });

  it("applies long-context prices to the whole request above the threshold", () => {
    const u = { inputTokens: 300_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    expect(costOf("openai:gpt-6.2-astra", u)).toBeCloseTo(300_000 * 16 / 1e6, 10);
  });

  it("refuses to price an unknown model", () => {
    expect(() => costOf("openai:gpt-unknown", { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 })).toThrow(/no price/);
  });
});

describe("provider overlays", () => {
  const msgs = [{ role: "user" as const, content: "pinned" }, { role: "user" as const, content: "a" }, { role: "user" as const, content: "b" }];

  it("marks the pinned prefix and the newest message for Anthropic prompt caching", () => {
    const out = withCacheBreakpoints(parseModel("anthropic:claude-opus-5-5"), msgs, 1);
    expect(out.map((m) => Boolean(m.providerOptions?.anthropic))).toEqual([true, false, true]);
  });

  it("leaves other providers' messages untouched", () => {
    expect(withCacheBreakpoints(parseModel("openai:gpt-6.2-astra"), msgs, 1)).toBe(msgs);
  });
});

it("the scripted mock model writes a stub minicore end to end", async () => {
  const root = workspace({ "spec/examples/01_arithmetic.mc": "1 + 1" });
  const { scriptedMockModel } = await import("../src/mock.ts");
  const { result } = await run(config({ workspace: root }), scriptedMockModel("stub") as any);
  expect(result.stopReason).toBe("finish");
  expect(existsSync(path.join(root, "minicore"))).toBe(true);
});
