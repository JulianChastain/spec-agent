import { describe, expect, it } from "vitest";
import { scrub, secretsFrom } from "../scripts/collect.ts";

describe("collect redaction", () => {
  it("treats the OpenRouter key in .env as a secret, and ignores non-secrets", () => {
    expect(secretsFrom({ OPENROUTER_API_KEY: "sk-or-v1-abcdef0123456789", MAX_TOTAL_USD: "60", SHORT_KEY: "abc" }))
      .toEqual(["sk-or-v1-abcdef0123456789"]);
  });

  it("redacts every occurrence of a .env secret", () => {
    const r = scrub('{"k":"tok-123456789"} and tok-123456789', ["tok-123456789"]);
    expect(r).toEqual({ text: '{"k":"[REDACTED]"} and [REDACTED]', redactions: 2 });
  });

  it("redacts OpenRouter-shaped keys even when they aren't in .env", () => {
    const key = "sk-or-v1-" + "0123456789abcdef".repeat(4);
    const r = scrub(`Authorization: Bearer ${key}\n`, []);
    expect(r.text).toBe("Authorization: Bearer [REDACTED]\n");
    expect(r.redactions).toBe(1);
  });

  it("leaves clean text alone", () => {
    expect(scrub("score 4.1%, sk-or- mentioned in prose", ["tok-123456789"])).toEqual({ text: "score 4.1%, sk-or- mentioned in prose", redactions: 0 });
  });
});
