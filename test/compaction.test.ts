import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { splitPoint, renderForSummary } from "../src/compaction.ts";
import { config, prompts, run, scripted, workspace } from "./helpers.ts";

const SPEC = "SPEC-SENTINEL: floor division rounds toward negative infinity.";

// Each reply reports a 50K-token prompt, so with a 60K window and compactAt
// 0.6 (36K) the agent must compact before every call after the first.
const bigTurns = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({
    tools: [{ name: "run_shell", input: { command: `echo OLD-TURN-${i}` } }],
    usage: { input: 50_000, output: 100 },
  })),
  { tools: [{ name: "finish", input: { summary: "done" } }] },
];

describe("compaction", () => {
  it("replaces old turns with a summary, keeping the spec, NOTES.md and a file index", async () => {
    const root = workspace({ "spec/SPEC.md": SPEC, "NOTES.md": "NOTES-SENTINEL: remember the occurs check", "src/main.py": "print(1)\n" });
    const main = scripted(bigTurns(6));
    const compactor = scripted([{ text: "SUMMARY-SENTINEL" }]);
    const cfg = config({ workspace: root, pin: ["spec/SPEC.md"], contextWindow: 60_000, compactAt: 0.6, keepRecent: 2 });
    const { result, telemetry } = await run(cfg, main, { compactor });

    expect(result.stopReason).toBe("finish");
    expect(result.compactions).toBeGreaterThan(0);
    expect(compactor.doStreamCalls.length).toBe(result.compactions);
    // The summarizer was shown the old turns.
    expect(prompts(compactor)[0]).toContain("OLD-TURN-0");

    const last = prompts(main).at(-1)!;
    expect(last).toContain(SPEC); // pinned, verbatim
    expect(last).toContain("Build the thing."); // the task prompt
    expect(last).toContain("NOTES-SENTINEL"); // the agent's notes
    expect(last).toContain("SUMMARY-SENTINEL"); // the summary
    expect(last).toContain("./src/main.py"); // the file index
    expect(last).not.toContain("OLD-TURN-0"); // old turns are gone

    const ev = telemetry.events.find((e) => e.type === "compaction")!;
    expect(ev).toMatchObject({ n: 1 });
    // The last call's exact 50,100 tokens plus the tool result appended since.
    expect(ev.beforeTokens as number).toBeGreaterThan(50_100);
    expect(ev.afterTokensEstimate as number).toBeLessThan(50_000);
  });

  it("the summary reflects NOTES.md as it is at compaction time, not at the start", async () => {
    const root = workspace({ "spec/SPEC.md": SPEC });
    const main = scripted([
      { tools: [{ name: "write_file", input: { path: "NOTES.md", content: "WRITTEN-LATER" } }], usage: { input: 50_000 } },
      ...bigTurns(3),
    ]);
    const cfg = config({ workspace: root, pin: ["spec/SPEC.md"], contextWindow: 60_000, keepRecent: 2 });
    await run(cfg, main);
    expect(prompts(main).at(-1)).toContain("WRITTEN-LATER");
  });

  it("never compacts when switched off", async () => {
    const main = scripted(bigTurns(4));
    const compactor = scripted([{ text: "x" }]);
    const cfg = config({ workspace: workspace(), contextWindow: 60_000, compaction: false });
    const { result } = await run(cfg, main, { compactor });
    expect(result.compactions).toBe(0);
    expect(compactor.doStreamCalls).toHaveLength(0);
    expect(prompts(main).at(-1)).toContain("OLD-TURN-0");
  });

  it("stops with 'context full' when, uncompacted, the context nears the real window", async () => {
    // mock:stub's real window is 200K tokens.
    const main = scripted([{ tools: [{ name: "run_shell", input: { command: "true" } }], usage: { input: 195_000 } }]);
    const { result } = await run(config({ workspace: workspace(), compaction: false }), main);
    expect(result.stopReason).toBe("context full");
  });

  it("survives a failing summarizer", async () => {
    const main = scripted(bigTurns(4));
    const cfg = config({ workspace: workspace(), contextWindow: 60_000, keepRecent: 2 });
    const { result } = await run(cfg, main, { compactor: scripted([{ error: "summarizer down" }]) });
    expect(result.stopReason).toBe("finish");
    expect(prompts(main).at(-1)).toContain("The summarizer failed");
  });
});

describe("splitPoint", () => {
  const a = (): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "x", input: {} }] });
  const t = (): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "x", output: { type: "text", value: "" } }] });

  it("never starts the kept tail with an orphaned tool result", () => {
    const h = [a(), t(), a(), t(), a(), t()];
    const i = splitPoint(h, 3); // naive cut would start at index 3, a tool result
    expect(h[i]!.role).toBe("assistant");
    expect(i).toBe(2);
  });

  it("returns 0 when there is nothing old enough to drop", () => {
    expect(splitPoint([a(), t()], 8)).toBe(0);
  });
});

describe("renderForSummary", () => {
  it("keeps the most recent end when the rendering is too long", () => {
    const msgs: ModelMessage[] = Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `turn-${i} ${"x".repeat(100)}` }));
    const s = renderForSummary(msgs, 1000);
    expect(s).toContain("turn-49");
    expect(s).not.toContain("turn-0 ");
  });
});
