// A step-by-step digest of one run's transcript, for reading why a run lost
// points or stopped. WRITEUP.md's failure taxonomy cites "run id, step N";
// this prints step N.
//
//   npx tsx scripts/digest.ts results/<run-id> [--from N] [--to N] [--full]
//
// Per step: the model call (tokens, cost), each tool call with a short view of
// its input, failed tool results, nudges, compactions, errors, and the end.
import { readFileSync } from "node:fs";
import path from "node:path";
import { readJsonl } from "./report.ts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…(${s.length} chars)` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function digest(events: any[], o: { from?: number; to?: number; full?: boolean } = {}): string[] {
  const n = o.full ? 4000 : 220;
  const out: string[] = [];
  const inRange = (step: unknown) => typeof step !== "number" || ((o.from ?? 0) <= step && step <= (o.to ?? Infinity));
  for (const e of events) {
    // The loop counts a step before it logs the tool results (or nudge) that
    // answer it, so those messages carry the next step's number. Label them
    // with the step of the call they answer, so "step N" means one call.
    const answers = e.type === "message" && (e.message?.role === "tool" || e.message?.role === "user");
    const step = answers && typeof e.step === "number" ? e.step - 1 : e.step;
    if (!inRange(step)) continue;
    const at = `[step ${step ?? "-"}, t=${((e.t ?? 0) / 60000).toFixed(1)}m]`;
    if (e.type === "model_call") {
      out.push(`${at} ${e.failed ? "FAILED " : ""}call (${e.purpose}): in ${e.inputTokens} (cached ${e.cacheReadTokens}) out ${e.outputTokens} $${Number(e.costUsd).toFixed(4)} -> ${(e.toolCalls ?? []).join(", ") || "no tools"}`);
    } else if (e.type === "message" && e.message?.role === "assistant" && Array.isArray(e.message.content)) {
      for (const p of e.message.content) {
        if (p.type === "text" && p.text.trim()) out.push(`${at}   says: ${clip(oneLine(p.text), n)}`);
        if (p.type === "tool-call") out.push(`${at}   ${p.toolName}: ${clip(oneLine(JSON.stringify(p.input)), n)}`);
      }
    } else if (e.type === "message" && e.message?.role === "tool" && Array.isArray(e.message.content)) {
      for (const p of e.message.content) {
        const v = String(p.output?.value ?? "");
        // Show failures, and the tail of shell output (where test summaries are).
        if (p.output?.type === "error-text") out.push(`${at}   ERROR ${p.toolName}: ${clip(oneLine(v), n)}`);
        else if (p.toolName === "run_shell") out.push(`${at}   -> ${clip(oneLine(v.slice(-600)), n)}`);
      }
    } else if (e.type === "message" && e.message?.role === "user") {
      const c = JSON.stringify(e.message.content);
      if (c.includes("You replied without calling a tool")) out.push(`${at} NUDGE`);
    } else if (e.type === "compaction") {
      out.push(`${at} COMPACTION #${e.n}: ${e.beforeTokens} -> ~${e.afterTokensEstimate} tokens, dropped ${e.droppedMessages} messages`);
    } else if (e.type === "model_call_error") {
      out.push(`${at} MODEL ERROR (${e.purpose}): ${clip(String(e.error), n)}`);
    } else if (e.type === "result") {
      out.push(`${at} RESULT: ${e.stop_reason}, ${e.steps} steps, $${Number(e.total_cost_usd ?? 0).toFixed(4)}${e.finish_summary ? `; summary: ${clip(oneLine(e.finish_summary), n)}` : ""}`);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) throw new Error("usage: digest.ts results/<run-id> [--from N] [--to N] [--full]");
  const num = (f: string) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : undefined; };
  const r = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
  console.log(`${r.id}: score ${r.score}, ${r.stop_reason}, $${r.cost_usd}, ${r.wall_s}s`);
  for (const l of digest(readJsonl(path.join(dir, "transcript.jsonl")), { from: num("--from"), to: num("--to"), full: args.includes("--full") })) console.log(l);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
