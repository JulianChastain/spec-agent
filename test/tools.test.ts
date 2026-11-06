import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { truncateMiddle } from "../src/shell.ts";
import { executeTool, type ToolContext } from "../src/tools.ts";
import { workspace } from "./helpers.ts";

const ctx = (root: string): ToolContext => ({ root, shellTimeoutMs: 5000, maxShellTimeoutMs: 10_000, maxOutputChars: 2000 });

describe("tool argument validation", () => {
  it("returns zod errors as a failed result instead of throwing", async () => {
    const r = await executeTool("read_file", { start_line: 0 }, ctx(workspace()));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/invalid arguments for read_file/);
    expect(r.output).toMatch(/path/);
  });

  it("rejects unknown tools", async () => {
    const r = await executeTool("rm_rf", {}, ctx(workspace()));
    expect(r).toMatchObject({ ok: false });
    expect(r.output).toMatch(/unknown tool/);
  });

  it("refuses paths outside the workspace", async () => {
    const r = await executeTool("read_file", { path: "../../etc/passwd" }, ctx(workspace()));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/outside the workspace/);
  });

  it("reports filesystem errors as results", async () => {
    const r = await executeTool("read_file", { path: "missing.txt" }, ctx(workspace()));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/ENOENT/);
  });
});

describe("read_file and write_file", () => {
  it("writes, creating directories, and reads back a line range with numbers", async () => {
    const root = workspace();
    expect((await executeTool("write_file", { path: "a/b.txt", content: "one\ntwo\nthree\nfour" }, ctx(root))).ok).toBe(true);
    const r = await executeTool("read_file", { path: "a/b.txt", start_line: 2, end_line: 3 }, ctx(root));
    expect(r.output).toContain("lines 2-3 of 4");
    expect(r.output).toMatch(/2 {2}two\n\s+3 {2}three$/);
    expect(r.output).not.toContain("four");
  });
});

describe("edit_file", () => {
  it("replaces exactly one occurrence", async () => {
    const root = workspace({ "f.ts": "let a = 1;\nlet b = 2;\n" });
    const r = await executeTool("edit_file", { path: "f.ts", old_string: "b = 2", new_string: "b = $& 3" }, ctx(root));
    expect(r.ok).toBe(true);
    // `$&` stays literal: replacement strings are not patterns.
    expect(readFileSync(path.join(root, "f.ts"), "utf8")).toBe("let a = 1;\nlet b = $& 3;\n");
  });

  it("fails when the match is missing", async () => {
    const root = workspace({ "f.ts": "x" });
    const r = await executeTool("edit_file", { path: "f.ts", old_string: "y", new_string: "z" }, ctx(root));
    expect(r).toMatchObject({ ok: false });
    expect(r.output).toMatch(/not found/);
  });

  it("fails when the match is not unique, and leaves the file alone", async () => {
    const root = workspace({ "f.ts": "x x" });
    const r = await executeTool("edit_file", { path: "f.ts", old_string: "x", new_string: "z" }, ctx(root));
    expect(r.output).toMatch(/occurs 2 times/);
    expect(readFileSync(path.join(root, "f.ts"), "utf8")).toBe("x x");
  });
});

describe("run_shell", () => {
  it("reports the exit code and output", async () => {
    const r = await executeTool("run_shell", { command: "echo hi; exit 3" }, ctx(workspace()));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/^exit code 3\nhi/);
  });

  it("hides API keys from the model's commands", async () => {
    process.env.FAKE_PROVIDER_API_KEY = "sk-should-not-leak";
    try {
      const r = await executeTool("run_shell", { command: "env" }, ctx(workspace()));
      expect(r.output).not.toContain("sk-should-not-leak");
      expect(r.output).toContain("PATH=");
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  });

  it("kills commands that exceed the timeout", async () => {
    const t0 = Date.now();
    const r = await executeTool("run_shell", { command: "sleep 30", timeout_s: 1 }, ctx(workspace()));
    expect(r.output).toMatch(/timed out after 1 s/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("truncates long output, keeping both ends", async () => {
    const r = await executeTool("run_shell", { command: "echo START; seq 1 100000; echo END" }, ctx(workspace()));
    expect(r.output.length).toBeLessThan(2200);
    expect(r.output).toContain("START");
    expect(r.output).toContain("END");
    expect(r.output).toContain("characters truncated");
  });
});

describe("truncateMiddle", () => {
  it("leaves short strings alone", () => expect(truncateMiddle("abc", 10)).toBe("abc"));
});
