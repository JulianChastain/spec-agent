// Run configuration: CLI flags, validated with zod, with defaults.
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { z } from "zod";

// Model routing: the main loop uses `model`; compaction summaries use
// `compactionModel`, which defaults to the same provider's cheap model.
export const CHEAP_MODEL: Record<string, string> = {
  openai: "openai:gpt-6-luna",
  anthropic: "anthropic:claude-haiku-5-5",
  google: "google:gemini-3.5-flash-lite",
  mock: "mock:stub",
};
// Through OpenRouter, the cheap model is the same vendor's, also via OpenRouter.
export const OPENROUTER_CHEAP_MODEL: Record<string, string> = {
  openai: "openrouter:openai/gpt-6-luna",
  anthropic: "openrouter:anthropic/claude-haiku-5.5",
  google: "openrouter:google/gemini-3.5-flash-lite",
};

/** The default compaction model for a main model: same provider, same vendor. */
export function cheapModelFor(ref: { provider: string; vendor: string; key: string }): string {
  const m = ref.provider === "openrouter" ? OPENROUTER_CHEAP_MODEL[ref.vendor] : CHEAP_MODEL[ref.provider];
  if (!m) throw new Error(`no default compaction model for ${ref.key}; pass --compaction-model`);
  return m;
}

export const ConfigSchema = z.object({
  model: z.string(),
  compactionModel: z.string().optional(),
  workspace: z.string().default(process.cwd()),
  prompt: z.string().min(1),
  pin: z.array(z.string()).default([]), // files (relative to workspace) copied verbatim into the pinned prefix
  maxSteps: z.number().int().positive().default(500),
  timeBudgetS: z.number().positive().default(3600),
  budgetUsd: z.number().positive().default(5),
  maxOutputTokens: z.number().int().positive().default(32_000),
  compaction: z.boolean().default(true),
  // Compact when the estimated prompt passes compactAt * contextWindow. The
  // window here is a working budget, deliberately far below the 1M tokens
  // these models accept: see DECISIONS.md ("Why a 160K working window").
  compactAt: z.number().gt(0).lt(1).default(0.6),
  contextWindow: z.number().int().positive().default(160_000),
  keepRecent: z.number().int().min(2).default(8), // messages kept verbatim after a compaction
  notesFile: z.string().default("NOTES.md"),
  shellTimeoutS: z.number().positive().default(60),
  maxShellTimeoutS: z.number().positive().default(600),
  maxToolOutputChars: z.number().int().positive().default(12_000),
  logFile: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(argv: string[]): Config {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      "compaction-model": { type: "string" },
      workspace: { type: "string" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      pin: { type: "string", multiple: true },
      "max-steps": { type: "string" },
      "time-budget-s": { type: "string" },
      "budget-usd": { type: "string" },
      "max-output-tokens": { type: "string" },
      "no-compaction": { type: "boolean" },
      "compact-at": { type: "string" },
      "context-window": { type: "string" },
      "keep-recent": { type: "string" },
      "log-file": { type: "string" },
    },
    strict: true,
  });
  const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
  const prompt = values.prompt ?? (values["prompt-file"] ? readFileSync(values["prompt-file"], "utf8") : undefined);
  return ConfigSchema.parse({
    model: values.model,
    compactionModel: values["compaction-model"],
    workspace: values.workspace,
    prompt,
    pin: values.pin,
    maxSteps: num(values["max-steps"]),
    timeBudgetS: num(values["time-budget-s"]),
    budgetUsd: num(values["budget-usd"]),
    maxOutputTokens: num(values["max-output-tokens"]),
    compaction: !values["no-compaction"],
    compactAt: num(values["compact-at"]),
    contextWindow: num(values["context-window"]),
    keepRecent: num(values["keep-recent"]),
    logFile: values["log-file"],
  });
}
