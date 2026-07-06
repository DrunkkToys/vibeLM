import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "fs";
import { mkdir, writeFile, appendFile, unlink, rename, rm } from "fs/promises";
import { resolve, dirname, relative, extname } from "path";
import { homedir } from "os";
import * as math from "mathjs";
import { SessionLog, type MemoryEntry } from "./sessionLog";

const CONFIG_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "config.json");
const SESSION_LOG_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "session-log.jsonl");

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".o", ".obj", ".pyc", ".class",
  ".ttf", ".otf", ".woff", ".woff2",
]);

function isBinary(p: string): boolean { return BINARY_EXTS.has(extname(p).toLowerCase()); }

function readConfig(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); }
  catch { return {}; }
}

function getWorkspace(ctl: any): string {
  const cfg = readConfig();
  if (typeof cfg.workspacePath === "string" && cfg.workspacePath) return cfg.workspacePath;
  try { return ctl.getWorkingDirectory(); } catch { return ""; }
}

function ws(ctl: any): string {
  const w = getWorkspace(ctl);
  if (!w) throw new Error("No workspace. Call set_workspace first.");
  return w;
}

function sandbox(workspace: string, requested: string): string {
  const r = resolve(workspace, requested);
  if (relative(workspace, r).startsWith("..")) throw new Error(`Path "${requested}" outside workspace`);
  return r;
}

function webSearch(query: string, max: number = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const ep = process.env.AGENTIC_SEARCH_ENDPOINT || "http://localhost:8394/search";
  return fetch(`${ep}?q=${encodeURIComponent(query)}&format=json`, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "AgenticTools/1.0" },
  }).then(r => r.ok ? r.json() : { results: [] }).then(d => (d.results || []).slice(0, max)).catch(() => []);
}

function ok(d: unknown) { return { ok: true, data: d }; }
function fail(m: string) { return { ok: false, error: m }; }

function getSessionLog(): SessionLog {
  return new SessionLog(SESSION_LOG_PATH);
}

function createTools(ctl: any): any[] {
  const cfg = readConfig();
  const enabled = new Set((cfg as any).enabledTools as string[] || [
    "set_workspace", "get_config", "save_memory", "search_memory",
    "web_fetch", "web_search", "read_file", "list_files",
    "search_files", "bash_terminal", "calculate", "get_current_datetime",
  ]);

  const tools: any[] = [];

  function add(name: string, desc: string, params: any, impl: any) {
    if (enabled.has(name)) {
      tools.push(tool({ name, description: desc, parameters: params, implementation: impl }));
    }
  }

  add("set_workspace", "Changes workspace root for file/bash operations. Persisted across sessions.",
    { path: z.string().min(1).describe("Absolute path") },
    async ({ path }: any) => {
      const r = resolve(path);
      if (!existsSync(r)) return fail("Path not found");
      const c = readConfig();
      c.workspacePath = r;
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
      return ok({ workspace: r });
    });

  add("get_config", "Returns current workspace path and config.",
    {},
    async () => ok({ workspace: getWorkspace(ctl) }));

  add("web_fetch", "Fetches a URL and returns text content (max 500KB).",
    {
      url: z.string().url().describe("URL"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars"),
    },
    async ({ url, maxChars }: any) => {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "AgenticTools/1.0" } });
        if (!resp.ok) return fail(`HTTP ${resp.status}`);
        const content = await resp.text();
        if (content.length > maxChars) return ok({ content: content.slice(0, maxChars), truncated: true });
        return ok({ content });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("web_search", "Searches the web and returns results with titles, URLs, snippets.",
    { query: z.string().min(1).max(500).describe("Query"), maxResults: z.number().int().min(1).max(10).optional().default(5) },
    async ({ query, maxResults }: any) => {
      try { return ok(await webSearch(query, maxResults)); }
      catch (e: any) { return fail(e.message || String(e)); }
    });

  add("calculate", "Evaluates math expressions.",
    { expression: z.string().min(1).max(500).describe("Expression") },
    async ({ expression }: any) => {
      try { return ok({ result: String(math.evaluate(expression)) }); }
      catch (e: any) { return fail(e.message || String(e)); }
    });

  add("get_current_datetime", "Returns current date, time, timezone.",
    {},
    async () => {
      const n = new Date();
      return ok({ iso: n.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    });

  add("list_files", "Lists files and directories relative to workspace.",
    { path: z.string().optional().default(".").describe("Directory") },
    async ({ path }: any) => {
      try {
        const w = ws(ctl);
        const dir = sandbox(w, path);
        const ents = readdirSync(dir, { withFileTypes: true });
        return ok({ entries: ents.map(e => {
          let s: number | null = null;
          try { if (e.isFile()) s = statSync(resolve(dir, e.name)).size; } catch {}
          return { name: e.name, type: e.isDirectory() ? "dir" : "file", size: s };
        }), count: ents.length });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("read_file", "Reads a text file. Binary rejected. Use offset for pagination.",
    {
      filePath: z.string().min(1).describe("Path relative to workspace"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars"),
      offset: z.number().int().min(0).optional().default(0).describe("Char offset"),
    },
    async ({ filePath, maxChars, offset }: any) => {
      try {
        const w = ws(ctl);
        const r = sandbox(w, filePath);
        if (!existsSync(r)) return fail("Not found");
        const st = statSync(r);
        if (st.isDirectory()) return fail("Is a directory");
        if (isBinary(r)) return fail("Binary file");
        const content = readFileSync(r, "utf-8");
        const sliced = content.slice(offset, offset + maxChars);
        return ok({ content: sliced, truncated: offset + maxChars < content.length, size: st.size });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("write_file", "Writes text to a file. Creates parent dirs. Overwrites.",
    { filePath: z.string().min(1).describe("Path"), content: z.string().describe("Text") },
    async ({ filePath, content }: any) => {
      try {
        const w = ws(ctl);
        const r = sandbox(w, filePath);
        if (!existsSync(dirname(r))) await mkdir(dirname(r), { recursive: true });
        await writeFile(r, content, "utf-8");
        return ok({ path: r, size: Buffer.byteLength(content, "utf-8") });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("append_file", "Appends text to a file. Creates if not exists.",
    { filePath: z.string().min(1).describe("Path"), content: z.string().describe("Text") },
    async ({ filePath, content }: any) => {
      try {
        const w = ws(ctl);
        const r = sandbox(w, filePath);
        if (!existsSync(dirname(r))) await mkdir(dirname(r), { recursive: true });
        await appendFile(r, content, "utf-8");
        return ok({ path: r, size: statSync(r).size });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("rename_file", "Renames or moves. Paths relative to workspace.",
    { sourcePath: z.string().min(1).describe("Current"), destPath: z.string().min(1).describe("New") },
    async ({ sourcePath, destPath }: any) => {
      try {
        const w = ws(ctl);
        const src = sandbox(w, sourcePath);
        const dst = sandbox(w, destPath);
        if (!existsSync(src)) return fail("Not found");
        if (!existsSync(dirname(dst))) await mkdir(dirname(dst), { recursive: true });
        await rename(src, dst);
        return ok({ from: src, to: dst });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("delete_file", "Deletes file or empty directory.",
    { path: z.string().min(1).describe("Path") },
    async ({ path }: any) => {
      try {
        const w = ws(ctl);
        const r = sandbox(w, path);
        if (!existsSync(r)) return fail("Not found");
        const st = statSync(r);
        if (st.isDirectory()) {
          if (readdirSync(r).length > 0) return fail("Not empty. Use bash_terminal.");
          await rm(r, { recursive: true });
        } else { await unlink(r); }
        return ok({ path: r });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("search_files", "Recursive text search. Skips binary, hidden, node_modules.",
    {
      pattern: z.string().min(1).max(200).describe("Text"),
      path: z.string().optional().default(".").describe("Start dir"),
      include: z.string().optional().describe("Glob like '*.ts'"),
      maxResults: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ pattern, path, include, maxResults }: any) => {
      try {
        const w = ws(ctl);
        const dir = sandbox(w, path);
        const q = pattern.toLowerCase();
        const results: any[] = [];
        function walk(cur: string) {
          if (results.length >= maxResults) return;
          try {
            for (const e of readdirSync(cur, { withFileTypes: true })) {
              if (results.length >= maxResults) return;
              const full = resolve(cur, e.name);
              if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(full); }
              else if (e.isFile()) {
                if (include) { const re = new RegExp("^" + include.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); if (!re.test(e.name)) continue; }
                if (isBinary(full)) continue;
                try {
                  const lines = readFileSync(full, "utf-8").split("\n");
                  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                    if (lines[i].toLowerCase().includes(q)) results.push({ file: full, line: i + 1, content: lines[i].trim().slice(0, 200) });
                  }
                } catch {}
              }
            }
          } catch {}
        }
        walk(dir);
        return ok({ results, total: results.length });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("bash_terminal", "Runs a bash command in the workspace.",
    { command: z.string().min(1).max(5000).describe("Command"), timeout: z.number().int().min(1000).max(120000).optional().default(30000) },
    async ({ command, timeout }: any) => {
      try {
        const { exec } = await import("child_process");
        return await new Promise((res) => {
          exec(command, { cwd: getWorkspace(ctl) || undefined, env: { ...process.env }, timeout, maxBuffer: 10 * 1024 * 1024 },
            (err: any, stdout: string, stderr: string) => res(ok({ exitCode: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" })));
        });
      } catch (e: any) { return fail(e.message || String(e)); }
    });

  add("save_memory", "Stores info in persistent knowledge base (survives restarts).",
    { content: z.string().min(1).max(50000).describe("Info"), tags: z.array(z.string().max(50)).min(1).max(20).describe("Tags") },
    async ({ content, tags }: any) => {
      getSessionLog().saveMemory(tags, content);
      return ok({ saved: true });
    });

  add("search_memory", "Searches stored memories by tags or keyword (newest-first).",
    {
      tags: z.array(z.string().max(50)).optional().describe("Filter by tags"),
      query: z.string().max(200).optional().describe("Keyword"),
      maxResults: z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ tags, query, maxResults }: any) => {
      const sl = getSessionLog();
      const results = tags?.length ? sl.searchMemoriesByTags(tags, maxResults) : query ? sl.searchMemoriesByContent(query, maxResults) : [];
      return ok({ results: results.map(e => ({ content: e.content.slice(0, 500), tags: e.tags })), total: results.length });
    });

  add("list_memories", "Shows total memory count.",
    {}, async () => ok({ total: getSessionLog().totalTurnsLogged() }));

  add("clear_memories", "Deletes ALL memories. Irreversible.",
    {}, async () => { getSessionLog().clear(); return ok({ message: "Cleared." }); });

  return tools;
}

export const handler: any = async (ctl: any) => {
  console.log("[AgenticTools] Handler invoked");

  const chat: any = await ctl.pullHistory();
  const model: any = await ctl.tokenSource();

  // Inject session memories into the conversation so the model remembers
  const sl = getSessionLog();
  const memories = sl.searchMemoriesByContent("", 20);
  if (memories.length > 0) {
    const memoryText = memories.map((m: MemoryEntry) => `[Memory: ${m.tags.join(", ")}] ${m.content}`).join("\n");
    chat.append("system", `Previous session memories:\n${memoryText}`);
  }

  chat.append("system", `You are vibeLM, an autonomous AI assistant with tools.

File: list_files, read_file, write_file, append_file, rename_file, search_files, delete_file
Bash: bash_terminal
Web: web_fetch, web_search
Memory: save_memory, search_memory, list_memories, clear_memories
Utility: calculate, get_current_datetime

Plan → Act (one tool at a time) → Check results → Continue or Respond.
When you have enough info, just write your answer naturally.`);

  const tools = createTools(ctl);
  const block = ctl.createContentBlock({ roleOverride: "assistant" });

  try {
    await model.act(chat, tools, {
      onPredictionFragment: (fragment: any) => {
        if (typeof fragment.content === "string") {
          block.appendText(fragment.content);
        }
      },
    });
  } catch (e: any) {
    console.error("[AgenticTools] act error:", e);
    block.appendText(`[Error: ${e.message || e}]`);
  }
};
