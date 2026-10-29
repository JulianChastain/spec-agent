// Context compaction. The conversation the model sees is always
//
//   [user: PINNED (task + spec) + optional SUMMARY BLOCK]  [history...]
//
// When the estimated context passes `threshold * window`, the older part of
// the history is replaced: a cheaper model writes a structured summary of it,
// and the summary block is rebuilt from that summary, the agent's own
// NOTES.md (re-read from disk, so it is current), and an index of the
// workspace files. The pinned task and spec are copied verbatim, never
// summarized. The most recent turns stay as they were, so the agent doesn't
// lose the thread of what it was doing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelMessage } from "ai";
import { runShell, truncateMiddle } from "./shell.ts";

export interface ConversationState {
  pinned: string; // never changes during a run
  summaryBlock: string | null; // replaced on every compaction
  history: ModelMessage[]; // assistant turns and tool results since the last compaction
}

export function toMessages(s: ConversationState): ModelMessage[] {
  const first = s.summaryBlock ? `${s.pinned}\n\n${s.summaryBlock}` : s.pinned;
  return [{ role: "user", content: first }, ...s.history];
}

/** A rough token count: ~4 characters per token for code and English. */
export function estimateTokens(x: unknown): number {
  return Math.ceil((typeof x === "string" ? x : JSON.stringify(x)).length / 4);
}

/**
 * Where the old part of the history ends. The kept tail must not start with a
 * tool result, because its tool call would be in the part we drop, and every
 * provider rejects a tool result without its call.
 */
export function splitPoint(history: ModelMessage[], keepRecent: number): number {
  let i = Math.max(0, history.length - keepRecent);
  while (i > 0 && history[i]?.role === "tool") i--;
  return i;
}

/** Render messages as plain text for the summarizer, clipping long tool output. */
export function renderForSummary(messages: ModelMessage[], maxChars: number): string {
  const out: string[] = [];
  for (const m of messages) {
    const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as any[]);
    for (const p of parts) {
      if (p.type === "text") out.push(`[${m.role}] ${truncateMiddle(p.text, 4000)}`);
      else if (p.type === "tool-call") out.push(`[tool call] ${p.toolName} ${truncateMiddle(JSON.stringify(p.input), 1500)}`);
      else if (p.type === "tool-result") {
        const v = p.output?.value ?? p.output;
        out.push(`[tool result: ${p.toolName}] ${truncateMiddle(typeof v === "string" ? v : JSON.stringify(v), 1500)}`);
      }
      // reasoning parts are skipped: they're long and the summary should
      // record decisions and facts, not deliberation.
    }
  }
  const text = out.join("\n");
  // If even the clipped rendering is too long, the most recent end matters most.
  return text.length > maxChars ? "[... earlier turns omitted ...]\n" + text.slice(-maxChars) : text;
}

/** `find`-based index of the workspace: path, size and line count. */
export async function workspaceIndex(root: string): Promise<string> {
  const r = await runShell(
    "find . -path ./spec -prune -o -path '*/node_modules' -prune -o -path ./.git -prune -o -type f -print " +
      "| sort | head -200 | while read -r f; do printf '%s  %s bytes  %s lines\\n' \"$f\" $(wc -c < \"$f\") $(wc -l < \"$f\"); done",
    root, 15_000, 20_000,
  );
  return r.output.trim() || "(no files yet)";
}

export async function readNotes(root: string, notesFile: string): Promise<string> {
  try {
    return await readFile(path.join(root, notesFile), "utf8");
  } catch {
    return `(${notesFile} does not exist yet)`;
  }
}

export function buildSummaryBlock(summary: string, notes: string, index: string, notesFile: string, n: number): string {
  return [
    `# Context compacted (${n}x so far)`,
    "Older turns of this conversation were replaced by the summary below to save context. " +
      "The task and spec above are unchanged and complete. Re-read any file before editing it; " +
      "your memory of its exact contents may be stale.",
    "## Summary of earlier work",
    summary.trim(),
    `## Your ${notesFile} (current contents)`,
    truncateMiddle(notes.trim(), 12_000),
    "## Workspace files",
    index,
  ].join("\n\n");
}
