// Test helpers: a scripted MockLanguageModelV4 and a temporary workspace.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { ConfigSchema, type Config } from "../src/config.ts";
import { runAgent, type AgentDeps } from "../src/loop.ts";
import { parseModel } from "../src/providers.ts";
import { Telemetry } from "../src/telemetry.ts";

export type Reply =
  | { tools: { name: string; input: unknown }[]; usage?: Partial<Usage> }
  | { text: string; usage?: Partial<Usage> }
  | { error: string };

interface Usage { input: number; cacheRead: number; output: number }

/** A mock model that plays `replies` in order (repeating the last one). */
export function scripted(replies: Reply[]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const r = replies[Math.min(i++, replies.length - 1)]!;
      if ("error" in r) throw new Error(r.error);
      const u: Usage = { input: 1000, cacheRead: 0, output: 100, ...r.usage };
      const chunks: any[] = "text" in r
        ? [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: r.text }, { type: "text-end", id: "t" }]
        : r.tools.map((t, k) => ({ type: "tool-call", toolCallId: `c${i}-${k}`, toolName: t.name, input: JSON.stringify(t.input) }));
      chunks.push({
        type: "finish",
        finishReason: { unified: "text" in r ? "stop" : "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: u.input, noCache: u.input - u.cacheRead, cacheRead: u.cacheRead, cacheWrite: 0 },
          outputTokens: { total: u.output, text: u.output, reasoning: 0 },
        },
      });
      return { stream: new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }) };
    },
  });
  return model;
}

/** Every prompt the model received, as one string each (for `toContain`). */
export function prompts(model: MockLanguageModelV4): string[] {
  return model.doStreamCalls.map((c) => JSON.stringify(c.prompt));
}

export function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spec-agent-test-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), content);
  }
  return dir;
}

export function config(over: Partial<Config> & { workspace: string }): Config {
  return ConfigSchema.parse({ model: "mock:stub", prompt: "Build the thing.", ...over });
}

/**
 * Run the agent with mock models. `priceAs` decides which price table the
 * main model is billed at, so dollar budgets can be tested with a mock.
 */
export async function run(cfg: Config, main: MockLanguageModelV4, opts: {
  compactor?: MockLanguageModelV4; priceAs?: string; now?: () => number; billFailedCall?: AgentDeps["billFailedCall"];
} = {}) {
  const telemetry = new Telemetry({ stdout: false });
  const deps: AgentDeps = {
    main: { ref: parseModel(opts.priceAs ?? "mock:stub"), model: main },
    compactor: { ref: parseModel("mock:stub"), model: opts.compactor ?? scripted([{ text: "SUMMARY-TEXT" }]) },
    systemPrompt: "SYSTEM",
    compactionPrompt: "SUMMARIZE",
    telemetry,
    now: opts.now,
    retryDelayMs: 0,
    billFailedCall: opts.billFailedCall,
  };
  const result = await runAgent(cfg, deps);
  return { result, telemetry };
}
