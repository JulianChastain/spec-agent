import { describe, expect, it } from "vitest";
import { digest } from "../scripts/digest.ts";

describe("transcript digest", () => {
  const events = [
    { type: "model_call", step: 0, purpose: "main", inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, costUsd: 0.01, toolCalls: ["run_shell"], t: 0 },
    { type: "message", step: 0, message: { role: "assistant", content: [{ type: "tool-call", toolName: "run_shell", input: { command: "pytest" } }] } },
    { type: "message", step: 0, message: { role: "tool", content: [{ type: "tool-result", toolName: "run_shell", output: { type: "text", value: "1 failed, 9 passed" } }] } },
    { type: "message", step: 1, message: { role: "user", content: "You replied without calling a tool. Nobody is reading" } },
    { type: "compaction", step: 2, n: 1, beforeTokens: 97000, afterTokensEstimate: 30000, droppedMessages: 40 },
    { type: "result", stop_reason: "finish", steps: 3, total_cost_usd: 0.5 },
  ];

  it("shows calls, tool inputs, shell tails, nudges, compactions and the end, labelled by step", () => {
    const d = digest(events).join("\n");
    expect(d).toContain("[step 0, t=0.0m] call (main): in 10 (cached 0) out 5 $0.0100 -> run_shell");
    expect(d).toContain('run_shell: {"command":"pytest"}');
    expect(d).toContain("-> 1 failed, 9 passed");
    expect(d).toContain("[step 1, t=0.0m] NUDGE");
    expect(d).toContain("COMPACTION #1: 97000 -> ~30000 tokens, dropped 40 messages");
    expect(d).toContain("RESULT: finish, 3 steps, $0.5000");
  });

  it("limits to a step range", () => {
    expect(digest(events, { from: 1, to: 1 }).filter((l) => l.startsWith("[step 0"))).toEqual([]);
  });
});
