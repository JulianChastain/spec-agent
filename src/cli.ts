// Entry point: spec-agent --model provider:id --prompt-file TASK.md [flags]
// README.md lists every flag. Prints the JSONL event stream on stdout.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cheapModelFor, parseConfig } from "./config.ts";
import { runAgent } from "./loop.ts";
import { generationIdOf, lookupOpenRouterBill } from "./llm.ts";
import { createModel, parseModel, type ModelRef } from "./providers.ts";
import { Telemetry } from "./telemetry.ts";

// Prompts live in ../prompts relative to this file. That holds both for
// src/cli.ts (run with tsx) and for the bundle in dist/.
const promptPath = (name: string) => fileURLToPath(new URL(`../prompts/${name}`, import.meta.url));

/** The shared system prompt plus the provider's overlay, if it has one. */
export function systemPromptFor(provider: string): string {
  const base = readFileSync(promptPath("system.md"), "utf8");
  const overlay = promptPath(`overlays/${provider}.md`);
  return existsSync(overlay) ? `${base}\n\n${readFileSync(overlay, "utf8")}` : base;
}

/** OpenRouter can say what a failed call cost; the direct APIs can't. */
async function billFailedCall(ref: ModelRef, error: unknown) {
  const id = ref.provider === "openrouter" ? generationIdOf(error) : null;
  return id && process.env.OPENROUTER_API_KEY ? lookupOpenRouterBill(id, process.env.OPENROUTER_API_KEY) : null;
}

async function main() {
  const cfg = parseConfig(process.argv.slice(2));
  const mainRef = parseModel(cfg.model);
  const compRef = parseModel(cfg.compactionModel ?? cheapModelFor(mainRef));
  const telemetry = new Telemetry({ stdout: true, file: cfg.logFile, keepInMemory: false });
  const result = await runAgent(cfg, {
    main: { ref: mainRef, model: createModel(mainRef) },
    compactor: { ref: compRef, model: createModel(compRef) },
    systemPrompt: systemPromptFor(mainRef.provider),
    compactionPrompt: readFileSync(promptPath("compaction.md"), "utf8"),
    telemetry,
    billFailedCall,
  });
  process.stderr.write(`spec-agent: ${result.stopReason} after ${result.steps} steps, $${result.costUsd.toFixed(4)}\n`);
}

main().catch((e) => {
  // A crash is still a result: say so on the event stream, so the harness
  // and the report record it as a crash rather than as silence.
  process.stderr.write(`spec-agent: fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.stdout.write(JSON.stringify({ type: "result", stop_reason: "crash", error: String(e) }) + "\n");
  process.exitCode = 1;
});
