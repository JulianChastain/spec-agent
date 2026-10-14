// The agent's six tools. Each has a zod schema; the schemas are given to the
// model (as JSON Schema, via the AI SDK) and used again here to validate what
// the model actually sent. A tool never throws: every failure, including bad
// arguments, comes back to the model as an error result it can react to.
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { runShell, truncateMiddle } from "./shell.ts";

export interface ToolContext {
  root: string; // the workspace; file tools can't reach outside it
  shellTimeoutMs: number; // default per command
  maxShellTimeoutMs: number;
  maxOutputChars: number; // cap on any single tool result
}

export interface ToolOutcome {
  ok: boolean;
  output: string; // what the model sees
  finished?: { summary: string }; // set only by `finish`
}

const relPath = z.string().min(1).describe("Path relative to the workspace root");

export const schemas = {
  list_dir: z.object({
    path: relPath.default("."),
    depth: z.number().int().min(1).max(4).default(2).describe("How many levels to descend"),
  }),
  read_file: z.object({
    path: relPath,
    start_line: z.number().int().min(1).optional().describe("First line to return, 1-based"),
    end_line: z.number().int().min(1).optional().describe("Last line to return, inclusive"),
  }),
  write_file: z.object({
    path: relPath,
    content: z.string().describe("The complete new file contents"),
  }),
  edit_file: z.object({
    path: relPath,
    old_string: z.string().min(1).describe("Exact text to replace; must occur exactly once"),
    new_string: z.string(),
  }),
  run_shell: z.object({
    command: z.string().min(1),
    timeout_s: z.number().int().min(1).max(600).optional().describe("Default 60"),
  }),
  finish: z.object({
    summary: z.string().describe("What you built, what passes, and what is known to be missing"),
  }),
};

export type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  list_dir: "List files and directories in the workspace, recursively up to `depth`.",
  read_file: "Read a text file, with line numbers. Use start_line/end_line for large files.",
  write_file: "Create or overwrite a file with the given contents. Parent directories are created.",
  edit_file: "Replace one exact occurrence of old_string with new_string. Fails if old_string is missing or occurs more than once; include more context to make it unique.",
  run_shell: "Run a bash command in the workspace root. Output (stdout+stderr) is truncated. Default timeout 60 s.",
  finish: "End the run. Call this only when you are done; the workspace is then graded as it is.",
};

/** The tool set handed to the AI SDK. No `execute`: the loop runs tools itself. */
export const toolSet = {
  list_dir: tool({ description: descriptions.list_dir, inputSchema: schemas.list_dir }),
  read_file: tool({ description: descriptions.read_file, inputSchema: schemas.read_file }),
  write_file: tool({ description: descriptions.write_file, inputSchema: schemas.write_file }),
  edit_file: tool({ description: descriptions.edit_file, inputSchema: schemas.edit_file }),
  run_shell: tool({ description: descriptions.run_shell, inputSchema: schemas.run_shell }),
  finish: tool({ description: descriptions.finish, inputSchema: schemas.finish }),
};

/** Resolve a model-supplied path, refusing anything that escapes the root. */
export function resolveInRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path ${p} is outside the workspace`);
  return abs;
}

async function listDir(root: string, dir: string, depth: number, prefix = ""): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    if (e.isDirectory()) {
      lines.push(`${prefix}${e.name}/`);
      if (depth > 1) lines.push(...(await listDir(root, path.join(dir, e.name), depth - 1, prefix + "  ")));
    } else {
      const { size } = await stat(path.join(dir, e.name));
      lines.push(`${prefix}${e.name} (${size} B)`);
    }
  }
  return lines;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

async function run(name: ToolName, args: any, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "list_dir": {
      const lines = await listDir(ctx.root, resolveInRoot(ctx.root, args.path), args.depth);
      return { ok: true, output: lines.join("\n") || "(empty)" };
    }
    case "read_file": {
      const text = await readFile(resolveInRoot(ctx.root, args.path), "utf8");
      const lines = text.split("\n");
      const start = args.start_line ?? 1;
      const end = Math.min(args.end_line ?? lines.length, lines.length);
      if (start > lines.length) return { ok: false, output: `start_line ${start} is past the end (${lines.length} lines)` };
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
      return { ok: true, output: `${args.path}: lines ${start}-${end} of ${lines.length}\n${body}` };
    }
    case "write_file": {
      const abs = resolveInRoot(ctx.root, args.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, args.content);
      return { ok: true, output: `wrote ${args.path} (${args.content.split("\n").length} lines)` };
    }
    case "edit_file": {
      const abs = resolveInRoot(ctx.root, args.path);
      const text = await readFile(abs, "utf8");
      const n = countOccurrences(text, args.old_string);
      if (n !== 1) {
        return { ok: false, output: n === 0
          ? `old_string not found in ${args.path}; read the file again, it may have changed`
          : `old_string occurs ${n} times in ${args.path}; include more surrounding text so it is unique` };
      }
      // A function replacement, so `$&` and friends in new_string stay literal.
      await writeFile(abs, text.replace(args.old_string, () => args.new_string));
      return { ok: true, output: `edited ${args.path}` };
    }
    case "run_shell": {
      const timeoutMs = Math.min((args.timeout_s ?? ctx.shellTimeoutMs / 1000) * 1000, ctx.maxShellTimeoutMs);
      const r = await runShell(args.command, ctx.root, timeoutMs, ctx.maxOutputChars);
      const status = r.timedOut ? `timed out after ${timeoutMs / 1000} s (killed)` : `exit code ${r.exitCode}`;
      return { ok: !r.timedOut && r.exitCode === 0, output: `${status}\n${r.output}` };
    }
    case "finish":
      return { ok: true, output: "finishing", finished: { summary: args.summary } };
  }
}

/** Validate and run one tool call. Never throws. */
export async function executeTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!(name in schemas)) {
    return { ok: false, output: `unknown tool ${JSON.stringify(name)}; available: ${Object.keys(schemas).join(", ")}` };
  }
  const parsed = schemas[name as ToolName].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
    return { ok: false, output: `invalid arguments for ${name}: ${issues}` };
  }
  try {
    const r = await run(name as ToolName, parsed.data, ctx);
    return { ...r, output: truncateMiddle(r.output, ctx.maxOutputChars) };
  } catch (e) {
    // ENOENT, EISDIR, path escapes and the like.
    return { ok: false, output: `${name} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
