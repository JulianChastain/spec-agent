// A scripted, zero-cost model ("mock:<script>") so the whole pipeline (CLI,
// tools, telemetry, the replicate-lang harness, freeze, grade) can be
// exercised without an API key. It replays a fixed list of tool calls, one
// per step, then calls `finish`. Tests use MockLanguageModelV4 directly.
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModel } from "ai";

type Call = { tool: string; input: Record<string, unknown> };

const SCRIPTS: Record<string, Call[]> = {
  // Writes a stub minicore that answers every program with "0", checks it on
  // one example, and finishes: the same stub as replicate-lang's selftest.
  stub: [
    { tool: "list_dir", input: { path: "." } },
    { tool: "write_file", input: { path: "minicore", content: "#!/bin/sh\necho 0\n" } },
    { tool: "run_shell", input: { command: "chmod +x minicore && ./minicore run spec/examples/01_arithmetic.mc" } },
    { tool: "finish", input: { summary: "scripted mock run" } },
  ],
};

export function scriptedMockModel(name: string): LanguageModel {
  const script = SCRIPTS[name];
  if (!script) throw new Error(`unknown mock script ${name}; have ${Object.keys(SCRIPTS).join(", ")}`);
  let step = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: name,
    doStream: async () => {
      const call = script[Math.min(step++, script.length - 1)]!;
      const chunks = [
        { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: call.tool, input: JSON.stringify(call.input) },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: {
            inputTokens: { total: 100 * step, noCache: 100 * step, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 20, text: 20, reasoning: 0 },
          },
        },
      ];
      return {
        stream: new ReadableStream({
          start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
        }),
      };
    },
  });
}
