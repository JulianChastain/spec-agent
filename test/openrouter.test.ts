// OpenRouter: model parsing, routing, cache breakpoints, and the cost path.
// The provider tests drive the real @openrouter/ai-sdk-provider against a
// stubbed fetch, so they check the HTTP body OpenRouter would receive and the
// stream it would send back, not our assumptions about them.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { cheapModelFor } from "../src/config.ts";
import { callModel, reportedCost } from "../src/llm.ts";
import { PRICES, costOf } from "../src/pricing.ts";
import { openRouterSettings, parseModel, withCacheBreakpoints } from "../src/providers.ts";
import { config, run, workspace } from "./helpers.ts";

describe("openrouter model strings", () => {
  it("parses openrouter:<vendor>/<model>, keeping the vendor", () => {
    expect(parseModel("openrouter:anthropic/claude-opus-5.5")).toEqual({
      key: "openrouter:anthropic/claude-opus-5.5", provider: "openrouter", vendor: "anthropic", id: "anthropic/claude-opus-5.5",
    });
    expect(parseModel("anthropic:claude-opus-5-5").vendor).toBe("anthropic");
  });

  it("rejects an openrouter model without a vendor prefix", () => {
    expect(() => parseModel("openrouter:claude-opus-5.5")).toThrow(/<vendor>\/<model>/);
    expect(() => parseModel("openrouter:")).toThrow();
  });

  it("routes compaction to the same vendor's cheap model, also via OpenRouter", () => {
    expect(cheapModelFor(parseModel("openrouter:openai/gpt-6.2-astra"))).toBe("openrouter:openai/gpt-6-luna");
    expect(cheapModelFor(parseModel("openrouter:anthropic/claude-opus-5.5"))).toBe("openrouter:anthropic/claude-haiku-5.5");
    expect(cheapModelFor(parseModel("openrouter:google/gemini-4-carbon"))).toBe("openrouter:google/gemini-3.5-flash-lite");
    expect(cheapModelFor(parseModel("google:gemini-4-carbon"))).toBe("google:gemini-3.5-flash-lite");
    expect(() => cheapModelFor(parseModel("openrouter:meta/llama"))).toThrow(/compaction-model/);
  });

  it("pins each vendor to its first-party endpoint with no fallbacks", () => {
    expect(openRouterSettings(parseModel("openrouter:google/gemini-4-carbon")).provider)
      .toEqual({ only: ["google-ai-studio"], allow_fallbacks: false, require_parameters: true });
    expect(() => openRouterSettings(parseModel("openrouter:meta/llama"))).toThrow(/pinned/);
  });

  it("has a sourced price for every model in experiments.json and its compaction model", () => {
    const plan = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "experiments.json"), "utf8"));
    for (const phase of Object.values<any>(plan.phases)) for (const r of phase.runs) {
      for (const key of [r.model, cheapModelFor(parseModel(r.model))]) {
        expect(PRICES[key], key).toBeDefined();
        expect(PRICES[key]!.source).toMatch(/^https:\/\//);
      }
    }
  });
});

describe("cache breakpoints through OpenRouter", () => {
  const msgs = [{ role: "user" as const, content: "pinned" }, { role: "user" as const, content: "a" }, { role: "user" as const, content: "b" }];

  it("marks anthropic/* models in OpenRouter's namespace", () => {
    const out = withCacheBreakpoints(parseModel("openrouter:anthropic/claude-opus-5.5"), msgs, 1);
    expect(out.map((m) => (m.providerOptions?.openrouter as any)?.cacheControl?.type ?? null)).toEqual(["ephemeral", null, "ephemeral"]);
    expect(out.some((m) => m.providerOptions?.anthropic)).toBe(false);
  });

  it("leaves OpenAI and Gemini models via OpenRouter untouched", () => {
    expect(withCacheBreakpoints(parseModel("openrouter:openai/gpt-6.2-astra"), msgs, 1)).toBe(msgs);
    expect(withCacheBreakpoints(parseModel("openrouter:google/gemini-4-carbon"), msgs, 1)).toBe(msgs);
  });
});

/** A fetch that records request bodies and streams back one SSE completion. */
function stubOpenRouter(usage: Record<string, unknown>) {
  const bodies: any[] = [];
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    const chunks = [
      { id: "gen-1", provider: "Anthropic", model: "anthropic/claude-opus-5.5", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] },
      { id: "gen-1", provider: "Anthropic", model: "anthropic/claude-opus-5.5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ];
    const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, bodies };
}

describe("the OpenRouter cost path (real provider, stubbed HTTP)", () => {
  const ref = parseModel("openrouter:anthropic/claude-opus-5.5");
  const call = (usage: Record<string, unknown>) => {
    const stub = stubOpenRouter(usage);
    const model = createOpenRouter({ apiKey: "sk-or-test", fetch: stub.fetch })(ref.id, openRouterSettings(ref));
    const messages = withCacheBreakpoints(ref, [{ role: "user", content: "pinned spec" }, { role: "user", content: "newest" }], 1);
    return callModel({ ref, model, instructions: "SYSTEM", messages, maxOutputTokens: 100, step: 0, purpose: "main" })
      .then((r) => ({ ...r, bodies: stub.bodies }));
  };

  it("sends cache_control on the marked messages and the provider pin", async () => {
    const r = await call({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.001 });
    const body = r.bodies[0];
    expect(body.provider).toEqual({ only: ["anthropic"], allow_fallbacks: false, require_parameters: true });
    const marked = JSON.stringify(body.messages.filter((m: any) => m.role === "user"));
    expect(marked.match(/"cache_control":\{"type":"ephemeral"\}/g)?.length).toBe(2);
  });

  it("bills the call at OpenRouter's reported cost and keeps our priced cost beside it", async () => {
    const usage = { prompt_tokens: 10_000, completion_tokens: 2_000, total_tokens: 12_000, cost: 0.0512,
      prompt_tokens_details: { cached_tokens: 6_000, cache_write_tokens: 1_000 } };
    const { event } = await call(usage);
    expect(event.cacheReadTokens).toBe(6_000);
    expect(event.cacheWriteTokens).toBe(1_000);
    expect(event.costUsdReported).toBe(0.0512);
    expect(event.costUsd).toBe(0.0512);
    expect(event.costUsdPriced).toBeCloseTo((3_000 * 4 + 6_000 * 0.2 + 1_000 * 5 + 2_000 * 20) / 1e6, 12);
    expect(event.upstream).toBe("Anthropic");
  });

  it("falls back to the price table when no cost is reported", async () => {
    const { event } = await call({ prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 });
    expect(event.costUsdReported).toBeNull();
    expect(event.costUsd).toBe(event.costUsdPriced);
    expect(event.costUsd).toBeCloseTo(costOf(ref.key, { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }), 12);
  });

  it("ignores a cost that isn't a finite number", () => {
    expect(reportedCost({ openrouter: { usage: { cost: "0.1" } } })).toBeNull();
    expect(reportedCost({ openrouter: { usage: { cost: Number.NaN } } })).toBeNull();
    expect(reportedCost(undefined)).toBeNull();
  });
});

it("the loop's dollar budget counts the reported cost, with the mock model", async () => {
  // Each call reports $0.40; priced at mock:stub it would cost $0.
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "tool-call", toolCallId: "c", toolName: "list_dir", input: JSON.stringify({ path: "." }) });
          c.enqueue({
            type: "finish", finishReason: { unified: "tool-calls", raw: undefined },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
            providerMetadata: { openrouter: { usage: { cost: 0.4 } } },
          });
          c.close();
        },
      }),
    }),
  });
  const { result, telemetry } = await run(config({ workspace: workspace(), budgetUsd: 1, compaction: false }), model);
  expect(result.stopReason).toBe("dollar budget");
  expect(telemetry.calls().length).toBe(2); // a third $0.40 call could pass $1
  expect(result.costUsd).toBeCloseTo(0.8, 10);
  expect(telemetry.calls().every((e) => e.costUsdPriced === 0 && e.costUsdReported === 0.4)).toBe(true);
});
