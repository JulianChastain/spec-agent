// Calls that fail mid-stream: describing the error, finding the generation
// id, looking up what OpenRouter billed, and how the loop counts and retries.
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { describeError, generationIdOf, isTransportError, lookupOpenRouterBill } from "../src/llm.ts";
import { config, run, workspace } from "./helpers.ts";

/** The shape the AI SDK throws when OpenRouter's stream is cut after a 200. */
function droppedStream(id = "gen-123-abc") {
  const socket = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
  const terminated = Object.assign(new TypeError("terminated"), { cause: socket });
  return Object.assign(new Error("Failed to process successful response"), {
    name: "AI_APICallError", cause: terminated, statusCode: 200, responseHeaders: { "x-generation-id": id },
  });
}

describe("failed-call helpers", () => {
  it("describes the whole cause chain", () => {
    expect(describeError(droppedStream())).toBe(
      "AI_APICallError: Failed to process successful response <- TypeError: terminated <- UND_ERR_SOCKET: other side closed");
  });

  it("tells dropped connections from other errors", () => {
    expect(isTransportError(droppedStream())).toBe(true);
    expect(isTransportError(new Error("400 invalid tool schema"))).toBe(false);
  });

  it("finds the generation id in the error's response headers, and ignores junk", () => {
    expect(generationIdOf(droppedStream("gen-1795816394-aWqCUPfxcz2VcLKX3Wyn"))).toBe("gen-1795816394-aWqCUPfxcz2VcLKX3Wyn");
    expect(generationIdOf({ cause: { responseHeaders: new Headers({ "x-generation-id": "gen-9" }) } })).toBe("gen-9");
    expect(generationIdOf(Object.assign(new Error("x"), { responseHeaders: { "x-generation-id": "../etc" } }))).toBeNull();
    expect(generationIdOf(new Error("no headers"))).toBeNull();
  });

  it("looks up the billed cost, retrying until the stats appear", async () => {
    const urls: string[] = [];
    let n = 0;
    const fetch = (async (url: string, init: any) => {
      urls.push(url);
      expect(init.headers.Authorization).toBe("Bearer sk-or-test");
      return ++n < 2 ? new Response("{}", { status: 404 })
        : Response.json({ data: { total_cost: 0.073251, native_tokens_prompt: 6622, native_tokens_completion: 1173, native_tokens_cached: 0, provider_name: "Anthropic" } });
    }) as unknown as typeof globalThis.fetch;
    const bill = await lookupOpenRouterBill("gen-1", "sk-or-test", { fetch, delaysMs: [0, 0, 0] });
    expect(bill).toEqual({ generationId: "gen-1", costUsd: 0.073251, inputTokens: 6622, cacheReadTokens: 0, outputTokens: 1173, upstream: "Anthropic" });
    expect(urls).toEqual(Array(2).fill("https://openrouter.ai/api/v1/generation?id=gen-1"));
  });

  it("gives up with null when the stats never appear", async () => {
    const fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await lookupOpenRouterBill("gen-1", "k", { fetch, delaysMs: [0, 0] })).toBeNull();
  });
});

/** A mock model whose calls fail per `plan` (true = drop), then list_dir forever. */
function flaky(plan: (Error | null)[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const err = plan[i++];
      if (err) throw err;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: "tool-call", toolCallId: `c${i}`, toolName: i > plan.length + 1 ? "finish" : "list_dir",
              input: JSON.stringify(i > plan.length + 1 ? { summary: "done" } : { path: "." }) });
            c.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: undefined },
              usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
            c.close();
          },
        }),
      };
    },
  });
}

describe("the loop and failed calls", () => {
  it("bills a failed call at what the provider says it cost", async () => {
    const { result, telemetry } = await run(config({ workspace: workspace(), compaction: false }), flaky([droppedStream("gen-7")]), {
      billFailedCall: async (_ref, e) => ({ generationId: generationIdOf(e)!, costUsd: 0.25, inputTokens: 900, cacheReadTokens: 0, outputTokens: 50, upstream: "OpenAI" }),
    });
    expect(result.stopReason).toBe("finish");
    expect(result.costUsd).toBeCloseTo(0.25, 10); // mock:stub calls cost nothing; the failed one cost $0.25
    const failed = telemetry.calls().filter((e) => e.failed);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ costUsd: 0.25, costUsdReported: 0.25, generationId: "gen-7", finishReason: "error", toolCalls: [] });
    const err = telemetry.events.find((e) => e.type === "model_call_error")!;
    expect(err).toMatchObject({ transient: true, billedUsd: 0.25, generationId: "gen-7" });
    expect(String(err.error)).toContain("UND_ERR_SOCKET");
  });

  it("retries dropped connections more patiently than other errors", async () => {
    const drops = Array.from({ length: 5 }, () => droppedStream());
    const { result } = await run(config({ workspace: workspace(), compaction: false }), flaky(drops));
    expect(result.stopReason).toBe("finish"); // 5 consecutive drops < 6

    const six = Array.from({ length: 6 }, () => droppedStream());
    expect((await run(config({ workspace: workspace(), compaction: false }), flaky(six))).result.stopReason).toBe("model error");

    const other = Array.from({ length: 3 }, () => new Error("400 bad request"));
    expect((await run(config({ workspace: workspace(), compaction: false }), flaky(other))).result.stopReason).toBe("model error");
  });

  it("a successful call resets both error counts", async () => {
    const plan = [droppedStream(), droppedStream(), droppedStream(), droppedStream(), droppedStream(), null,
      droppedStream(), droppedStream(), droppedStream(), droppedStream(), droppedStream()];
    expect((await run(config({ workspace: workspace(), compaction: false }), flaky(plan))).result.stopReason).toBe("finish");
  });
});
