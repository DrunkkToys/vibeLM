import { text, tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { writeFile, appendFile, unlink, mkdir, rm } from "fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, relative, extname } from "path";
import { homedir } from "os";
import * as math from "mathjs";
import { SessionLog, type MemoryEntry, type TurnEntry } from "./sessionLog";

const LMSTUDIO_API_PORT = process.env.LMSTUDIO_API_PORT || "1234";
const API_BASE = `http://localhost:${LMSTUDIO_API_PORT}`;

const CONFIG_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "config.json");
const JSONL_CACHE_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "session-log.jsonl");

const DEFAULT_CONTEXT_WINDOW = 8192;
const FILE_CACHE_MAX_BYTES = 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 3000;
const MAX_TURNS = 25;
const LOOP_WINDOW = 5;

const LM_STUDIO_URL = "http://127.0.0.1:1234";

async function getContextWindow(): Promise<number> {
  try {
    const resp = await fetch(`${LM_STUDIO_URL}/v1/models`);
    const data = await resp.json() as any;
    const models = data?.data || [];
    const config = readConfigSync();
    const preferred = (config as any).preferredModel;
    const target = pickBestModel(models, preferred);
    const model = models.find((m: any) => m.id === target) || models[0];
    const ctx = model?.max_context_length;
    if (typeof ctx === "number" && ctx > 0) return ctx;
  } catch {}
  return 8192;
}

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".o", ".obj", ".pyc", ".class",
  ".ttf", ".otf", ".woff", ".woff2",
]);

const fileCache = new Map<string, { content: string; mtime: number; size: number }>();
let fileCacheBytes = 0;

function cacheRead(filePath: string): string {
  const cached = fileCache.get(filePath);
  try {
    const mtime = statSync(filePath).mtimeMs;
    if (cached && cached.mtime === mtime) return cached.content;
  } catch {
    fileCache.delete(filePath);
    throw new Error(`File not found: ${filePath}`);
  }
  const content = readFileSync(filePath, "utf-8");
  const size = Buffer.byteLength(content, "utf-8");
  const mtime = statSync(filePath).mtimeMs;
  while (fileCacheBytes + size > FILE_CACHE_MAX_BYTES && fileCache.size > 0) {
    const firstKey = fileCache.keys().next().value;
    if (firstKey === undefined) break;
    const evicted = fileCache.get(firstKey);
    if (evicted) fileCacheBytes -= evicted.size;
    fileCache.delete(firstKey);
  }
  fileCache.set(filePath, { content, mtime, size });
  fileCacheBytes += size;
  return content;
}

function cacheInvalidate(filePath: string): void {
  const cached = fileCache.get(filePath);
  if (cached) {
    fileCacheBytes -= cached.size;
    fileCache.delete(filePath);
  }
}

function binaryExtCheck(p: string): boolean {
  return BINARY_EXTS.has(extname(p).toLowerCase());
}

const VLM_PATTERNS = /vlm|vision|\d+v\b|video|multimodal|image/i;

function pickBestModel(models: Array<{ id: string }>, preferred?: string): string | null {
  if (!models.length) return null;
  if (preferred) {
    const match = models.find(m => m.id === preferred || m.id.includes(preferred));
    if (match) return match.id;
  }
  const textModels = models.filter(m => !VLM_PATTERNS.test(m.id));
  if (textModels.length) return textModels[0].id;
  return models[0].id;
}

async function getModel(): Promise<string | null> {
  try {
    const resp = await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.error(`[AgenticTools] LM Studio API returned HTTP ${resp.status} at ${API_BASE}/v1/models`);
      return null;
    }
    const data = await resp.json() as { data?: Array<{ id: string }> };
    if (!data?.data?.length) {
      console.warn(`[AgenticTools] No models loaded via API. Load a model in LM Studio first.`);
      return null;
    }
    const config = readConfigSync();
    const model = pickBestModel(data.data, (config as any).preferredModel);
    console.log(`[AgenticTools] Using model: ${model}`);
    return model;
  } catch (e) {
    console.error(`[AgenticTools] Cannot reach LM Studio API at ${API_BASE}. Run 'lms server start'`);
    return null;
  }
}

function defaultConfig() {
  return { workspacePath: homedir() };
}

function readConfigSync(): { workspacePath: string } {
  try {
    const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : {};
    return { ...defaultConfig(), ...raw };
  } catch { return defaultConfig(); }
}

function writeConfigSync(config: Record<string, unknown>): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
  require("fs").writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function getWorkspace(sessionDir?: string): string {
  const config = readConfigSync();
  const ws = config.workspacePath?.trim();
  if (ws) return ws;
  if (sessionDir) return sessionDir.trim();
  return "";
}

function requireWorkspace(ctl: any): string {
  const ws = getWorkspace(ctl.getWorkingDirectory());
  if (!ws) throw new Error("No workspace set. Call set_workspace first.");
  return ws;
}

function sandboxPath(workspace: string, requestedPath: string): string {
  const resolved = resolve(workspace, requestedPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Path "${requestedPath}" is outside the workspace "${workspace}"`);
  }
  return resolved;
}

let globalSessionLog: SessionLog | null = null;

function getSessionLog(): SessionLog {
  if (!globalSessionLog) {
    globalSessionLog = new SessionLog(JSONL_CACHE_PATH);
  }
  return globalSessionLog;
}

let turnCounter = 0;
let toolCallHistory: Array<{ name: string; ts: number }> = [];
let sessionStarted = false;

function beginSession(): void {
  if (!sessionStarted) {
    sessionStarted = true;
    turnCounter = 0;
    toolCallHistory = [];
  }
}

function currentSessionId(): string {
  return new Date().toISOString().split("T")[0];
}

function detectLoop(name: string): string | null {
  toolCallHistory.push({ name, ts: Date.now() });
  if (toolCallHistory.length > LOOP_WINDOW) {
    toolCallHistory = toolCallHistory.slice(-LOOP_WINDOW);
  }
  if (toolCallHistory.length >= 4) {
    const last4 = toolCallHistory.slice(-4).map(t => t.name);
    if (last4.every(n => n === last4[0])) {
      return last4[0];
    }
  }
  const window = toolCallHistory.slice(-6);
  const counts: Record<string, number> = {};
  for (const t of window) {
    counts[t.name] = (counts[t.name] || 0) + 1;
  }
  for (const [n, c] of Object.entries(counts)) {
    if (c >= 4) return n;
  }
  return null;
}

function wrapTool(toolDef: any, name: string): any {
  const origImpl = toolDef.implementation;
  return {
    ...toolDef,
    implementation: async (args: Record<string, unknown>, ctx: any) => {
      beginSession();
      turnCounter++;

      if (turnCounter > MAX_TURNS) {
        return {
          ok: false,
          error: `Max turns (${MAX_TURNS}) exceeded. Use respond_to_user with what you have so far.`,
        };
      }

      const looped = detectLoop(name);
      if (looped) {
        return {
          ok: false,
          error: `Loop detected: tool "${looped}" called ${LOOP_WINDOW}+ times consecutively. Try a different approach or call respond_to_user to produce your answer.`,
        };
      }

      console.log(`[AgenticTools] [turn ${turnCounter}] Tool: ${name}`);

      let result: any;
      try {
        result = await origImpl(args, ctx);
      } catch (e: any) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      const log = getSessionLog();
      const turnEntry: TurnEntry = {
        type: "turn",
        sessionId: currentSessionId(),
        ts: new Date().toISOString(),
        turn: turnCounter,
        role: "tool",
        content: name,
        toolCalls: [{ name, args: JSON.stringify(args), result: JSON.stringify(result).slice(0, 500) }],
      };
      log.startTurn(turnEntry);

      if (turnCounter % 5 === 0) {
        log.saveCheckpoint(
          `Turn ${turnCounter}: called ${name} — result ok=${result?.ok}`,
          ["checkpoint", `turn:${turnCounter}`],
          turnCounter,
        );
      }

      return result;
    },
  };
}

async function webSearch(query: string, maxResults: number = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const config = readConfigSync();
  const endpoint = (config as any).searchEndpoint || process.env.AGENTIC_SEARCH_ENDPOINT || "http://localhost:8394/search";
  const url = `${endpoint}?q=${encodeURIComponent(query)}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "AgenticTools/1.0" } });
  } catch { clearTimeout(t); return []; }
  clearTimeout(t);
  if (!resp.ok) return [];
  const data = await resp.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
  return (data.results || []).slice(0, maxResults);
}

function ok(data: unknown) {
  return { ok: true, data };
}

function fail(msg: string) {
  return { ok: false, error: msg };
}

export { webSearch, binaryExtCheck, pickBestModel, VLM_PATTERNS };

export async function toolsProvider(ctl: ToolsProviderController) {
  const setWorkspaceTool = wrapTool(tool({
    name: "set_workspace",
    description: text`Changes the workspace root for all file and bash operations. The workspace is persisted across sessions.
USE WHEN: you need to change where file operations run. Always call this first if the user hasn't set a workspace.
EXAMPLE: set_workspace({ path: "/Users/name/project" })`,
    parameters: {
      path: z.string().min(1).describe("Absolute path to the workspace folder"),
    },
    implementation: async ({ path }) => {
      const resolved = resolve(path);
      if (!existsSync(resolved)) return fail(`Path does not exist: ${resolved}`);
      const config = readConfigSync();
      const prev = config.workspacePath;
      config.workspacePath = resolved;
      writeConfigSync(config);
      return ok({ previous: prev, workspace: resolved });
    },
  }), "set_workspace");

  const getConfigTool = wrapTool(tool({
    name: "get_config",
    description: text`Returns current configuration: workspace path, memory stats, config file info.
USE WHEN: you need to check where the workspace is or how many memories are stored.
EXAMPLE: get_config()`,
    parameters: {},
    implementation: async () => {
      const config = readConfigSync();
      return ok({
        workspace: requireWorkspace(ctl),
        configFile: CONFIG_PATH,
        configFileExists: existsSync(CONFIG_PATH),
        config,
        totalMemories: getSessionLog().totalTurnsLogged(),
        sessionWorkingDirectory: ctl.getWorkingDirectory(),
      });
    },
  }), "get_config");

  const webFetchTool = wrapTool(tool({
    name: "web_fetch",
    description: text`Fetches a URL and returns text content (max 500KB).
USE WHEN: you need to read the actual content of a webpage. Call web_search first to find the URL.
EXAMPLE: web_fetch({ url: "https://example.com", maxChars: 50000 })
NOTE: Only returns text content. JavaScript-rendered content may not be captured.`,
    parameters: {
      url: z.string().url().describe("The URL to fetch"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars (default 50000)"),
    },
    implementation: async ({ url, maxChars }) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const resp = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "LMStudio-AgenticTools/1.0" } });
        clearTimeout(t);
        if (!resp.ok) return fail(`HTTP ${resp.status}`);
        const text = await resp.text();
        if (text.length > maxChars) return ok({ content: text.slice(0, maxChars), truncated: true, originalLength: text.length });
        return ok({ content: text });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "web_fetch");

  const calculateTool = wrapTool(tool({
    name: "calculate",
    description: text`Evaluates a math expression: arithmetic, trig, log, stats, units.
USE WHEN: you need to compute something numerical. Supports +, -, *, /, sin, cos, log, sqrt, etc.
EXAMPLE: calculate({ expression: "sin(45 deg) + sqrt(144)" })
NOTE: For complex expressions, keep them under 500 chars.`,
    parameters: {
      expression: z.string().min(1).max(500).describe("Math expression to evaluate"),
    },
    implementation: async ({ expression }) => {
      try {
        const result = math.evaluate(expression);
        if (typeof result === "object" && result?.toString) return ok({ result: result.toString() });
        return ok({ result });
      } catch (e) { return fail(`Evaluation error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  }), "calculate");

  const currentDateTimeTool = wrapTool(tool({
    name: "get_current_datetime",
    description: text`Returns current date, time, timezone, and unix timestamp.
USE WHEN: you need to know the current time, date, or timezone for context.
EXAMPLE: get_current_datetime()
NOTE: This uses the system clock. Timezone reflects local machine settings.`,
    parameters: {},
    implementation: async () => {
      const now = new Date();
      return ok({
        iso: now.toISOString(),
        date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        unixTimestamp: Math.floor(now.getTime() / 1000),
        components: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), dayOfWeek: now.getDay(), hours: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds() },
      });
    },
  }), "get_current_datetime");

  const respondToUserTool = tool({
    name: "respond_to_user",
    description: text`Produces your final answer to the user. Call this when you have completed all necessary steps and are ready to respond.
USE WHEN: you have gathered all information, analyzed it, and are ready to present your findings.
EXAMPLE: respond_to_user({ text: "Here is a summary of what I found..." })
NOTE: Call this ONLY when you're done. After calling it, your work is complete.
IMPORTANT: This is the ONLY way to produce output. Do NOT try to write a response as text — use this tool.`,
    parameters: {
      text: z.string().min(1).max(100000).describe("Your complete final response to the user"),
    },
    implementation: async ({ text }) => {
      return {
        ok: true,
        data: { text },
        _final: true,
      };
    },
  });

  const listFilesTool = wrapTool(tool({
    name: "list_files",
    description: text`Lists files and directories relative to the workspace root.
USE WHEN: you need to see what files exist in a directory before reading or searching.
EXAMPLE: list_files({ path: "src" }) lists files in the 'src' subdirectory.
NOTE: If path is omitted, lists the workspace root directory. Returns entry names, types, and file sizes.`,
    parameters: {
      path: z.string().optional().default(".").describe("Directory relative to workspace"),
    },
    implementation: async ({ path }) => {
      try {
        const ws = requireWorkspace(ctl);
        const dir = sandboxPath(ws, path);
        const entries = readdirSync(dir, { withFileTypes: true });
        return ok({
          workspace: ws,
          path: dir,
          entries: entries.map((e) => {
            const full = resolve(dir, e.name);
            let size: number | null = null;
            try { if (e.isFile()) size = statSync(full).size; } catch {}
            return { name: e.name, type: e.isDirectory() ? "directory" : "file", size };
          }),
          count: entries.length,
        });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "list_files");

  const readFileTool = wrapTool(tool({
    name: "read_file",
    description: text`Reads a text file from the workspace. Binary files (images, PDFs, etc.) are rejected.
USE WHEN: you need to examine source code, configuration files, logs, or any text file.
EXAMPLE: read_file({ filePath: "src/index.ts", maxChars: 50000, offset: 0 })
NOTE: For large files, use offset to paginate. Binary files must be handled via bash_terminal.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars (default 50000)"),
      offset: z.number().int().min(0).optional().default(0).describe("Character offset to start reading from (for truncated files)"),
    },
    implementation: async ({ filePath, maxChars, offset }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        if (!existsSync(resolved)) return fail(`File not found: ${resolved}`);
        const st = statSync(resolved);
        if (st.isDirectory()) return fail(`Is a directory: ${resolved}`);
        if (binaryExtCheck(resolved)) return fail(`Cannot read binary file: ${filePath}. Use bash_terminal for binary files.`);
        const content = readFileSync(resolved, "utf-8");
        const sliced = content.slice(offset, offset + maxChars);
        if (offset + maxChars < content.length) return ok({ content: sliced, truncated: true, originalLength: content.length, offset });
        return ok({ content: sliced });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "read_file");

  const writeFileTool = wrapTool(tool({
    name: "write_file",
    description: text`Writes text content to a file. Creates parent directories if needed. Overwrites existing files.
USE WHEN: you need to create or replace a file with new content.
EXAMPLE: write_file({ filePath: "src/hello.ts", content: "console.log('hello')" })
NOTE: Path is relative to workspace. Use append_file to add to an existing file.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      content: z.string().describe("Text content to write"),
    },
    implementation: async ({ filePath, content }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        const parent = dirname(resolved);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
        await writeFile(resolved, content, "utf-8");
        return ok({ path: resolved, workspace: ws, size: Buffer.byteLength(content, "utf-8"), action: "written" });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "write_file");

  const appendFileTool = wrapTool(tool({
    name: "append_file",
    description: text`Appends text to the end of a file. Creates the file if it doesn't exist.
USE WHEN: you need to add content to an existing file without overwriting it.
EXAMPLE: append_file({ filePath: "logs/output.txt", content: "new log entry" })
NOTE: Does NOT add a newline automatically. Include \\n in content if needed.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      content: z.string().describe("Text content to append"),
    },
    implementation: async ({ filePath, content }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        const parent = dirname(resolved);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
        await appendFile(resolved, content, "utf-8");
        const size = statSync(resolved).size;
        return ok({ path: resolved, workspace: ws, size, action: "appended" });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "append_file");

  const renameFileTool = wrapTool(tool({
    name: "rename_file",
    description: text`Renames or moves a file or directory. Both paths are relative to workspace.
USE WHEN: you need to reorganize files or rename something.
EXAMPLE: rename_file({ sourcePath: "old_name.ts", destPath: "new_name.ts" })
NOTE: Parent directories for the destination are created automatically.`,
    parameters: {
      sourcePath: z.string().min(1).describe("Current path relative to workspace"),
      destPath: z.string().min(1).describe("New path relative to workspace"),
    },
    implementation: async ({ sourcePath, destPath }) => {
      try {
        const ws = requireWorkspace(ctl);
        const src = sandboxPath(ws, sourcePath);
        const dst = sandboxPath(ws, destPath);
        if (!existsSync(src)) return fail(`Source not found: ${sourcePath}`);
        const dstParent = dirname(dst);
        if (!existsSync(dstParent)) await mkdir(dstParent, { recursive: true });
        const { rename } = await import("fs/promises");
        await rename(src, dst);
        return ok({ from: src, to: dst, workspace: ws });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "rename_file");

  const searchFilesTool = wrapTool(tool({
    name: "search_files",
    description: text`Searches file contents recursively for a case-insensitive text pattern. Skips binary files, hidden dirs, and node_modules.
USE WHEN: you need to find files containing specific text or code patterns.
EXAMPLE: search_files({ pattern: "TODO", include: "*.ts", maxResults: 20 })
NOTE: This is a text-based search, not a regex search. The pattern is matched case-insensitively.`,
    parameters: {
      pattern: z.string().min(1).max(200).describe("Text pattern to search for (case-insensitive)"),
      path: z.string().optional().default(".").describe("Starting directory relative to workspace"),
      include: z.string().optional().describe("File glob pattern (e.g. '*.ts', '*.{js,ts,md}')"),
      maxResults: z.number().int().min(1).max(200).optional().default(50).describe("Max matches (default 50)"),
    },
    implementation: async ({ pattern, path, include, maxResults }) => {
      try {
        const ws = requireWorkspace(ctl);
        const dir = sandboxPath(ws, path);
        const q = pattern.toLowerCase();
        const results: Array<{ file: string; line: number; content: string }> = [];
        function walkFn(current: string): void {
          if (results.length >= maxResults) return;
          try {
            const ents = readdirSync(current, { withFileTypes: true });
            for (const e of ents) {
              if (results.length >= maxResults) return;
              const full = resolve(current, e.name);
              if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walkFn(full); }
              else if (e.isFile()) {
                if (include) {
                  const re = new RegExp("^" + include.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
                  if (!re.test(e.name)) continue;
                }
                if (binaryExtCheck(full)) continue;
                try {
                  const lines = readFileSync(full, "utf-8").split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (results.length >= maxResults) break;
                    if (lines[i].toLowerCase().includes(q)) { results.push({ file: full, line: i + 1, content: lines[i].trim().slice(0, 200) }); }
                  }
                } catch {}
              }
            }
          } catch {}
        }
        walkFn(dir);
        return ok({ pattern, workspace: ws, path: dir, results, total: results.length });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "search_files");

  const deleteFileTool = wrapTool(tool({
    name: "delete_file",
    description: text`Deletes a file or empty directory. Path is relative to workspace.
USE WHEN: you need to remove a file or empty directory.
EXAMPLE: delete_file({ path: "temp/output.txt" })
NOTE: Will NOT delete non-empty directories. Use bash_terminal 'rm -rf' for that.`,
    parameters: {
      path: z.string().min(1).describe("Path relative to workspace"),
    },
    implementation: async ({ path }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, path);
        if (!existsSync(resolved)) return fail(`Not found: ${resolved}`);
        const st = statSync(resolved);
        if (st.isDirectory()) {
          const contents = readdirSync(resolved);
          if (contents.length > 0) return fail(`Directory is not empty (${contents.length} items). Use bash_terminal 'rm -rf' for non-empty directories.`);
          await rm(resolved, { recursive: true });
        } else { await unlink(resolved); }
        return ok({ path: resolved, workspace: ws, action: "deleted" });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "delete_file");

  const bashTerminalTool = wrapTool(tool({
    name: "bash_terminal",
    description: text`Runs a bash command in the workspace directory. Each call creates a fresh process.
USE WHEN: you need to run shell commands, scripts, or access binary files.
EXAMPLE: bash_terminal({ command: "ls -la", timeout: 10000 })
NOTE: The working directory is the workspace root. Timeout defaults to 30s, max 120s. Output is capped at 10MB.`,
    parameters: {
      command: z.string().min(1).max(5000).describe("Bash command to execute"),
      timeout: z.number().int().min(1000).max(120000).optional().default(30000).describe("Timeout ms (default 30000, max 120000)"),
    },
    implementation: async ({ command, timeout }) => {
      try {
        const { exec } = await import("child_process");
        return await new Promise((res) => {
          exec(command, { cwd: requireWorkspace(ctl), env: { ...process.env }, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            res(ok({ exitCode: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "", killed: !!err?.killed, signal: err?.signal ?? null }));
          });
        });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "bash_terminal");

  const webSearchTool = wrapTool(tool({
    name: "web_search",
    description: text`Searches the web and returns results with titles, snippets, and URLs.
USE WHEN: you need to find information on the internet, look up documentation, or research a topic.
EXAMPLE: web_search({ query: "typescript decorators example", maxResults: 5 })
NOTE: Call this first, then use web_fetch on the most relevant URLs to get full content.`,
    parameters: {
      query: z.string().min(1).max(500).describe("Search query"),
      maxResults: z.number().int().min(1).max(10).optional().default(5).describe("Max results (default 5)"),
    },
    implementation: async ({ query, maxResults }) => {
      try { return ok(await webSearch(query, maxResults)); }
      catch (e: any) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "web_search");

  const saveMemoryTool = wrapTool(tool({
    name: "save_memory",
    description: text`Stores information in a persistent JSONL knowledge base that survives restarts.
USE WHEN: you learn something important about the user's project that should be remembered across sessions.
EXAMPLE: save_memory({ content: "Project uses React 18 with TypeScript", tags: ["project:myapp", "tech:react"] })
NOTE: Tags are searchable via search_memory. Use descriptive tags for easy retrieval.`,
    parameters: {
      content: z.string().min(1).max(50000).describe("Information to store"),
      tags: z.array(z.string().max(50)).min(1).max(20).describe("Tags like ['project:myapp', 'language:python']"),
    },
    implementation: async ({ content, tags }) => {
      getSessionLog().saveMemory(tags, content);
      return ok({ saved: true });
    },
  }), "save_memory");

  const searchMemoryTool = wrapTool(tool({
    name: "search_memory",
    description: text`Searches stored memories by tags and/or keyword. Results are newest-first.
USE WHEN: you need to recall information saved in previous sessions.
EXAMPLE: search_memory({ tags: ["project:myapp"], maxResults: 10 })
EXAMPLE: search_memory({ query: "deployment", maxResults: 5 })
NOTE: Provide either tags or query, not both. Returns up to 50 results.`,
    parameters: {
      tags: z.array(z.string().max(50)).optional().describe("Filter by tags"),
      query: z.string().max(200).optional().describe("Keyword search"),
      maxResults: z.number().int().min(1).max(50).optional().default(10),
    },
    implementation: async ({ tags, query, maxResults }) => {
      const session = getSessionLog();
      let results: MemoryEntry[] = [];
      if (tags && tags.length > 0) {
        results = session.searchMemoriesByTags(tags, maxResults);
      } else if (query) {
        results = session.searchMemoriesByContent(query, maxResults);
      }
      return ok({ results: results.map((e) => ({ content: e.content.slice(0, 500), tags: e.tags })), totalMatches: results.length });
    },
  }), "search_memory");

  const listMemoriesTool = wrapTool(tool({
    name: "list_memories",
    description: text`Shows total count of memory entries stored in the knowledge base.
USE WHEN: you want a quick count of how many memories exist.
EXAMPLE: list_memories()
NOTE: Use search_memory to find specific entries. This only returns the total count.`,
    parameters: {},
    implementation: async () => {
      const total = getSessionLog().totalTurnsLogged();
      return ok({ totalEntries: total, message: "Use search_memory to find specific entries." });
    },
  }), "list_memories");

  const clearMemoriesTool = wrapTool(tool({
    name: "clear_memories",
    description: text`Deletes ALL memory entries. This is irreversible.
USE WHEN: you need to reset the memory knowledge base completely.
EXAMPLE: clear_memories()
NOTE: This deletes everything. There is no undo. Use save_memory to re-add important entries after.`,
    parameters: {
      tags: z.array(z.string().max(50)).optional().describe("If provided, only delete entries matching ANY of these tags"),
    },
    implementation: async ({ tags }) => {
      if (tags && tags.length > 0) {
        return fail("Tag-specific clear not supported with append-only JSONL. Omit tags to clear all.");
      }
      getSessionLog().clear();
      return ok({ deletedCount: -1, message: "Session log cleared." });
    },
  }), "clear_memories");

  const generateUuidTool = wrapTool(tool({
    name: "generate_uuid",
    description: text`Generates a random UUID v4 string.
USE WHEN: you need a unique identifier for something.
EXAMPLE: generate_uuid()
NOTE: No parameters needed. Uses crypto.randomUUID().`,
    parameters: {},
    implementation: async () => { const { randomUUID } = await import("crypto"); return ok({ uuid: randomUUID() }); },
  }), "generate_uuid");

  const generatePasswordTool = wrapTool(tool({
    name: "generate_password",
    description: text`Generates a cryptographically random password with configurable length and special character options.
USE WHEN: the user needs a secure random password.
EXAMPLE: generate_password({ length: 32, includeSpecialChars: true })
NOTE: Length range is 8-128. Default is 24 chars with special chars.`,
    parameters: {
      length: z.number().int().min(8).max(128).optional().default(24).describe("Password length (default 24)"),
      includeSpecialChars: z.boolean().optional().default(true).describe("Include special characters (default true)"),
    },
    implementation: async ({ length, includeSpecialChars }) => {
      const { randomInt } = await import("crypto");
      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const digits = "0123456789";
      const special = "!@#$%^&*()_+-=[]{}|;:,.<>?";
      const chars = upper + lower + digits + (includeSpecialChars ? special : "");
      let password = "";
      for (let i = 0; i < length; i++) password += chars[randomInt(0, chars.length)];
      return ok({ password, length, strength: length >= 32 ? "strong" : length >= 16 ? "good" : "adequate" });
    },
  }), "generate_password");

  const encodeBase64Tool = wrapTool(tool({
    name: "encode_base64",
    description: text`Encodes text to Base64 format.
USE WHEN: you need to encode data for transmission or storage in Base64.
EXAMPLE: encode_base64({ text: "hello world" })
NOTE: Returns both the encoded and original text.`,
    parameters: { text: z.string().min(1).describe("Text to encode") },
    implementation: async ({ text }) => ok({ encoded: Buffer.from(text).toString("base64"), original: text }),
  }), "encode_base64");

  const decodeBase64Tool = wrapTool(tool({
    name: "decode_base64",
    description: text`Decodes Base64 format back to text.
USE WHEN: you need to decode Base64 encoded data.
EXAMPLE: decode_base64({ base64: "aGVsbG8gd29ybGQ=" })
NOTE: Returns the decoded text. Throws if the input is not valid Base64.`,
    parameters: { base64: z.string().min(1).describe("Base64 string to decode") },
    implementation: async ({ base64 }) => {
      try { return ok({ decoded: Buffer.from(base64, "base64").toString("utf-8") }); }
      catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "decode_base64");

  const sshExecTool = wrapTool(tool({
    name: "ssh_exec",
    description: text`Executes a command on a remote machine via SSH with password authentication.
USE WHEN: you need to run commands on a remote server.
EXAMPLE: ssh_exec({ host: "192.168.1.100", user: "root", password: "...", command: "ls -la", port: 22, timeout: 30000 })
NOTE: Requires sshpass to be installed on the host machine. Password is sent via command line.`,
    parameters: {
      host: z.string().min(1).describe("Remote host"),
      user: z.string().min(1).describe("SSH username"),
      password: z.string().min(1).describe("SSH password"),
      command: z.string().min(1).max(5000).describe("Command to execute"),
      port: z.number().int().min(1).max(65535).optional().default(22).describe("SSH port (default 22)"),
      timeout: z.number().int().min(5000).max(120000).optional().default(30000).describe("Timeout ms (default 30000)"),
    },
    implementation: async ({ host, user, password, command, port, timeout }) => {
      try {
        const { execSync } = await import("child_process");
        const sshCmd = `sshpass -p '${password.replace(/'/g, "'\\''")}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${user}@${host} ${command.split(" ").map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(" ")}`;
        const result = execSync(sshCmd, { encoding: "utf-8", timeout, maxBuffer: 10 * 1024 * 1024 });
        return ok({ exitCode: 0, stdout: result.trim(), stderr: "" });
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return ok({ exitCode: err.status ?? 1, stdout: (err.stdout || "").toString().trim(), stderr: (err.stderr || "").toString().trim(), error: String(e), killed: !!(err as any).killed });
      }
    },
  }), "ssh_exec");

  const checkServiceTool = wrapTool(tool({
    name: "check_service",
    description: text`Checks if a network service is reachable via TCP port check.
USE WHEN: you need to verify a service is running on a host/port.
EXAMPLE: check_service({ host: "localhost", port: 3000, timeout: 5000 })
EXAMPLE: check_service({ host: "example.com", port: 80, httpPath: "/status", timeout: 5000 })
NOTE: If httpPath is provided, also performs an HTTP GET and returns status code and body.`,
    parameters: {
      host: z.string().default("localhost").describe("Host or IP to check"),
      port: z.number().int().min(1).max(65535).describe("TCP port"),
      httpPath: z.string().optional().describe("HTTP path for status check"),
      timeout: z.number().int().min(1000).max(30000).optional().default(5000).describe("Timeout ms (default 5000)"),
    },
    implementation: async ({ host, port, httpPath, timeout }) => {
      const start = Date.now();
      const reachable = await new Promise<boolean>((res) => {
        const { Socket } = require("net");
        const s = new Socket();
        s.setTimeout(timeout);
        s.on("connect", () => { s.destroy(); res(true); });
        s.on("error", () => { s.destroy(); res(false); });
        s.on("timeout", () => { s.destroy(); res(false); });
        s.connect(port, host);
      });
      const latencyMs = Date.now() - start;
      let httpStatus: number | null = null;
      let httpBody: string | null = null;
      if (reachable && httpPath) {
        try {
          const resp = await fetch(`http://${host}:${port}${httpPath}`, { signal: AbortSignal.timeout(timeout) });
          httpStatus = resp.status;
          httpBody = (await resp.text()).slice(0, 2000);
        } catch {}
      }
      return ok({ host, port, reachable, latencyMs, httpStatus, httpBody });
    },
  }), "check_service");

  const deleteMemoryTool = wrapTool(tool({
    name: "delete_memory",
    description: text`Delete is not supported with append-only JSONL storage. Use clear_memories to reset, or save_memory with fresh content to overwrite.
USE WHEN: the user asks to delete a specific memory YOU CANNOT. Tell them to use clear_memories instead.`,
    parameters: { id: z.string().min(1).describe("Memory entry ID") },
    implementation: async () => {
      return fail("Delete not supported with append-only JSONL. Use clear_memories to reset, or save_memory with fresh content.");
    },
  }), "delete_memory");

  const updateMemoryTool = wrapTool(tool({
    name: "update_memory",
    description: text`Update is not supported with append-only JSONL storage. Use save_memory with new content and tags instead.
USE WHEN: the user asks to update a memory YOU CANNOT. Tell them to use save_memory instead.`,
    parameters: {
      id: z.string().min(1).describe("Memory entry ID to update"),
      content: z.string().max(50000).optional().describe("New content"),
      tags: z.array(z.string().max(50)).min(1).max(20).optional().describe("New tags"),
    },
    implementation: async () => {
      return fail("Update not supported with append-only JSONL. Use save_memory with new content and tags.");
    },
  }), "update_memory");

  const ALL_TOOL_MAP: Record<string, any> = {
    set_workspace: setWorkspaceTool,
    get_config: getConfigTool,
    save_memory: saveMemoryTool,
    search_memory: searchMemoryTool,
    list_memories: listMemoriesTool,
    update_memory: updateMemoryTool,
    delete_memory: deleteMemoryTool,
    clear_memories: clearMemoriesTool,
    ssh_exec: sshExecTool,
    check_service: checkServiceTool,
    web_fetch: webFetchTool,
    calculate: calculateTool,
    get_current_datetime: currentDateTimeTool,
    list_files: listFilesTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    append_file: appendFileTool,
    rename_file: renameFileTool,
    search_files: searchFilesTool,
    delete_file: deleteFileTool,
    bash_terminal: bashTerminalTool,
    web_search: webSearchTool,
    generate_uuid: generateUuidTool,
    generate_password: generatePasswordTool,
    encode_base64: encodeBase64Tool,
    decode_base64: decodeBase64Tool,
    respond_to_user: respondToUserTool,
  };

  const DEFAULT_ENABLED = [
    "set_workspace", "get_config", "save_memory", "search_memory",
    "web_fetch", "web_search",
    "read_file", "list_files", "search_files", "bash_terminal",
    "calculate", "get_current_datetime", "write_file",
    "respond_to_user",
  ];

  const configTools = readConfigSync();
  const enabledNames = (configTools as any).enabledTools || DEFAULT_ENABLED;
  const allTools = enabledNames
    .filter((name: string) => ALL_TOOL_MAP[name])
    .map((name: string) => ALL_TOOL_MAP[name]);

  const respondToUserIdx = allTools.indexOf(respondToUserTool);
  if (respondToUserIdx >= 0) {
    const lastIdx = allTools.length - 1;
    if (respondToUserIdx !== lastIdx) {
      allTools.splice(respondToUserIdx, 1);
      allTools.push(respondToUserTool);
    }
  }

  return allTools;
}

export async function preprocessMessage(text: string): Promise<string | null> {
  const t = text.trim();

  const wsMatch = t.match(/^(?:set|pick|change|switch|go\s+to)\s+workspace\s+(.+)/i) || t.match(/^workspace\s+(.+)/i);
  if (wsMatch) {
    const path = wsMatch[1].trim().replace(/^["'`]|["'`]$/g, "");
    const resolved = resolve(path);
    if (existsSync(resolved)) {
      const cfg = readConfigSync();
      cfg.workspacePath = resolved;
      writeConfigSync(cfg);
      return `[Tool executed: set_workspace → workspace is now ${resolved}]`;
    }
    return `[Tool error: set_workspace → path not found: ${resolved}]`;
  }

  const calcMatch = t.match(/^(?:calculate|evaluate|solve|what\s+is|compute)\s+(.+)/i);
  if (calcMatch) {
    try {
      const calcResp = await import("mathjs").then(m => m.evaluate(calcMatch[1]));
      if (typeof calcResp === "number" || typeof calcResp === "string") {
        return `[Tool executed: calculate → ${calcResp}]`;
      }
    } catch (e) {
      console.warn(`[AgenticTools] calculate preprocessor failed:`, e);
    }
  }

  const searchMatch = t.match(/^(?:search|find|google|look\s+up|lookup|bing)\s+(?:the\s+web\s+)?(?:for\s+)?(.+)/i);
  if (searchMatch) {
    try {
      const results = await webSearch(searchMatch[1], 5);
      if (results.length > 0) {
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`);
        return `[Tool executed: web_search →\n${lines.join("\n")}]\n\n${t}`;
      }
      return `[Tool executed: web_search → no results found]`;
    } catch (e: any) {
      return `[Tool error: web_search → ${e.message}]`;
    }
  }

  return null;
}
