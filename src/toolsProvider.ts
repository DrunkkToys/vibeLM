import { text, tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { writeFile, appendFile, unlink, mkdir, rm } from "fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, relative, extname } from "path";
import { homedir } from "os";
import * as math from "mathjs";
import { SessionLog, type TurnEntry, type MemoryEntry } from "./sessionLog";

const LMSTUDIO_API_PORT = process.env.LMSTUDIO_API_PORT || "1234";
const API_BASE = `http://localhost:${LMSTUDIO_API_PORT}`;

const CONFIG_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "config.json");
const JSONL_CACHE_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "session-log.jsonl");

const DEFAULT_CONTEXT_WINDOW = 8192;
const CONTEXT_WARNING_THRESHOLD = 0.85;
const WORKING_WINDOW_SIZE = 12;
const FILE_CACHE_MAX_BYTES = 1024 * 1024;
const TOOL_RESULT_MAX_CHARS = 2000;
const MAX_CONTEXT_TURNS = 1;

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

interface StoredTurn {
  assistant: Record<string, unknown>;
  toolResults: Record<string, unknown>[];
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

// ─── File Read Cache ────────────────────────────────────────────────
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
  // Evict if cache full
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

function cacheClear(): void {
  fileCache.clear();
  fileCacheBytes = 0;
}

function binaryExtCheck(p: string): boolean {
  return BINARY_EXTS.has(extname(p).toLowerCase());
}

const VLM_PATTERNS = /vlm|vision|\d+v\b|video|multimodal|image/i;

function isGarbageOutput(text: string): boolean {
  if (!text || text.length < 20) return false;
  const trimmed = text.trim();
  const uniqueChars = new Set(trimmed).size;
  return uniqueChars <= 3 && trimmed.length > 20;
}

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

// ─── Context Window Management ──────────────────────────────────────────────

function buildContextMessages(
  systemPrompt: string,
  userPrompt: string,
  storedTurns: StoredTurn[],
  maxTurns: number,
  maxTokens: number,
  sessionId: string,
): Record<string, unknown>[] {
  const MAX_TOOL_RESULT_CHARS = 2000;
  let recent = storedTurns.slice(-maxTurns);
  let contextNote = "";
  if (storedTurns.length > recent.length) {
    const checkpoints = getSessionLog().searchCheckpoints(sessionId, 3);
    const summaries = checkpoints
      .map((c: any) => c.summary || c.content || "")
      .filter(Boolean)
      .join(" | ");
    if (summaries) contextNote = `[Earlier context: ${summaries}]`;
  }
  const budget = Math.floor(maxTokens * 0.75);
  while (recent.length > 0) {
    const msgs: Record<string, unknown>[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    if (contextNote) msgs.push({ role: "system", content: contextNote });
    for (const turn of recent) {
      const assistantMsg = { ...turn.assistant };
      if (typeof assistantMsg.content === "string" && assistantMsg.content.length > 2000) {
        assistantMsg.content = assistantMsg.content.slice(0, 2000) + "\n[...truncated]";
      }
      msgs.push(assistantMsg);
      for (const tr of turn.toolResults) {
        const truncated = { ...tr };
        if (typeof truncated.content === "string" && truncated.content.length > MAX_TOOL_RESULT_CHARS) {
          truncated.content = truncated.content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[TRUNCATED: ${truncated.content.length - MAX_TOOL_RESULT_CHARS} chars omitted. Call read_file with offset to see more.]`;
        }
        msgs.push(truncated);
      }
    }
    const estimated = msgs.reduce(
      (s, m: any) => s + Math.ceil((typeof m.content === "string" ? m.content : JSON.stringify(m)).length / 4),
      0,
    );
    if (estimated <= budget) return msgs;
    recent = recent.slice(1);
  }
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
    ...(contextNote ? [{ role: "system", content: contextNote }] : []),
  ];
}

// ─── Orchestrator: call LLM directly via local API ───────────────────────────

const ORCHESTRATOR_TOOL_DEFS: Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> = [
  { type: "function", function: { name: "read_file", description: "Read a file from the workspace", parameters: { type: "object", properties: { filePath: { type: "string", description: "File path relative to workspace" }, maxChars: { type: "number", description: "Max chars to read" }, offset: { type: "number", description: "Character offset to start from" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "list_files", description: "List directory contents", parameters: { type: "object", properties: { path: { type: "string", description: "Directory path relative to workspace" } }, required: [] } } },
  { type: "function", function: { name: "search_files", description: "Search file contents by pattern", parameters: { type: "object", properties: { pattern: { type: "string", description: "Search pattern" }, path: { type: "string" }, maxResults: { type: "number" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "bash_terminal", description: "Run a shell command (git, grep, etc.)", parameters: { type: "object", properties: { command: { type: "string", description: "Command to run" }, timeout: { type: "number" } }, required: ["command"] } } },
  { type: "function", function: { name: "web_search", description: "Search the web for information", parameters: { type: "object", properties: { query: { type: "string", description: "Search query" }, maxResults: { type: "number" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_fetch", description: "Fetch a URL content", parameters: { type: "object", properties: { url: { type: "string", description: "URL to fetch" } }, required: ["url"] } } },
  { type: "function", function: { name: "save_memory", description: "Save findings to persistent JSONL log", parameters: { type: "object", properties: { content: { type: "string", description: "Finding" }, tags: { type: "array", items: { type: "string" }, description: "Tags" } }, required: ["content", "tags"] } } },
];

async function callLLM(
  messages: Array<Record<string, unknown>>,
  tools: boolean = false,
  temperature: number = 0.3,
  maxTokens: number = 0,
): Promise<{ content: string; tool_calls?: Array<{ type: string; function: { name: string; arguments: string } }> } | null> {
  const model = await getModel();
  if (!model) {
    console.error(`[AgenticTools] callLLM: no model available.`);
    return null;
  }
  const config = readConfigSync();
  const tokenBudget = maxTokens || (config as any).maxTokensPerCall || 2048;
  const estimatedTokens = messages.reduce(
    (s, m: any) => s + Math.ceil((typeof m.content === "string" ? m.content : JSON.stringify(m)).length / 4), 0
  );
  const contextWindow = await getContextWindow();
  if (estimatedTokens > contextWindow * 0.85) {
    console.warn(`[AgenticTools] callLLM: prompt too large (${estimatedTokens}/${contextWindow}). Skipping.`);
    return null;
  }
  const body: Record<string, unknown> = { model, messages, max_tokens: tokenBudget, temperature };
  if (tools) {
    body.tools = ORCHESTRATOR_TOOL_DEFS;
    body.tool_choice = "required";
  }
  const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    console.error(`[AgenticTools] LLM API call failed: HTTP ${resp.status}`);
    return null;
  }
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<any> } }> };
  const msg = data.choices?.[0]?.message;
  if (!msg) return null;
  return { content: msg.content || "", tool_calls: msg.tool_calls as any };
}

async function execToolByName(name: string, args: Record<string, unknown>): Promise<unknown> {
  const ws = getWorkspace();
  switch (name) {
    case "web_fetch": {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch(String(args.url || ""), { signal: c.signal, headers: { "User-Agent": "LMStudio-AgenticTools/1.0" } });
        clearTimeout(t);
        const txt = await r.text();
        const mc = Number(args.maxChars) || 50000;
        return txt.length > mc ? txt.slice(0, mc) : txt;
      } catch (e) { return String(e); }
    }
    case "bash_terminal": {
      const { exec } = await import("child_process");
      return new Promise((res) => {
        exec(String(args.command || ""), { cwd: ws, timeout: Number(args.timeout) || 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          res({ exitCode: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" });
        });
      });
    }
    case "read_file": {
      try {
        const p = sandboxPath(ws, String(args.filePath || args.path || ""));
        const content = readFileSync(p, "utf-8");
        const maxChars = Number(args.maxChars) || 5000;
        return content.length > maxChars ? content.slice(0, maxChars) + "\n... [truncated]" : content;
      } catch (e) { return String(e); }
    }
    case "write_file": {
      try {
        const pw = sandboxPath(ws, String(args.filePath || ""));
        const dir = dirname(pw);
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(pw, String(args.content || ""), "utf-8");
        return { success: true, path: pw };
      } catch (e) { return String(e); }
    }
    case "append_file": {
      try {
        const pw = sandboxPath(ws, String(args.filePath || ""));
        const dir = dirname(pw);
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await appendFile(pw, String(args.content || ""), "utf-8");
        return { success: true, path: pw };
      } catch (e) { return String(e); }
    }
    case "rename_file": {
      try {
        const { rename } = await import("fs/promises");
        const src = sandboxPath(ws, String(args.sourcePath || ""));
        const dst = sandboxPath(ws, String(args.destPath || ""));
        const d = dirname(dst);
        if (!existsSync(d)) await mkdir(d, { recursive: true });
        await rename(src, dst);
        return { success: true, from: src, to: dst };
      } catch (e) { return String(e); }
    }
    case "delete_file": {
      try {
        const p = sandboxPath(ws, String(args.path || ""));
        const st = statSync(p);
        if (st.isDirectory()) {
          if (readdirSync(p).length > 0) return "Directory not empty. Use bash_terminal rm -rf.";
          await rm(p, { recursive: true });
        } else { await unlink(p); }
        return { success: true, path: p };
      } catch (e) { return String(e); }
    }
    case "list_files": {
      try {
        const pl = sandboxPath(ws, String(args.path || "."));
        return readdirSync(pl, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      } catch (e) { return String(e); }
    }
    case "search_files": {
      try {
        const pattern = String(args.pattern || "").toLowerCase();
        const start = sandboxPath(ws, String(args.path || "."));
        const maxR = Number(args.maxResults) || 50;
        const res: Array<{ file: string; line: number }> = [];
        function walk(dir: string): void {
          if (res.length >= maxR) return;
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (res.length >= maxR) return;
            const f = resolve(dir, e.name);
            if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(f); }
            else if (e.isFile()) {
              try {
                const lines = readFileSync(f, "utf-8").split("\n");
                for (let i = 0; i < lines.length; i++) { if (lines[i].toLowerCase().includes(pattern)) { res.push({ file: f, line: i + 1 }); if (res.length >= maxR) break; } }
              } catch {}
            }
          }
        }
        walk(start);
        return { results: res, total: res.length };
      } catch (e) { return String(e); }
    }
    case "web_search": {
      try { return await webSearch(String(args.query || ""), Number(args.maxResults) || 5); }
      catch (e) { return String(e); }
    }
    case "get_current_datetime": return new Date().toISOString();
    case "calculate": {
      try { return math.evaluate(String(args.expression || "")).toString(); }
      catch (e) { return String(e); }
    }
    case "generate_uuid": { const { randomUUID } = await import("crypto"); return randomUUID(); }
    case "generate_password": {
      const len = Number(args.length) || 24;
      const { randomInt } = await import("crypto");
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?";
      let pw = "";
      for (let i = 0; i < len; i++) pw += chars[randomInt(0, chars.length)];
      return { password: pw, length: len };
    }
    case "encode_base64": return Buffer.from(String(args.text || "")).toString("base64");
    case "decode_base64": try { return Buffer.from(String(args.base64 || ""), "base64").toString("utf-8"); } catch (e) { return String(e); }
    case "save_memory": {
      console.log("[DEBUG] save_memory called with:", JSON.stringify(args));
      getSessionLog().saveMemory((args.tags as string[]) || [], String(args.content || ""));
      return { success: true };
    }
    case "search_memory": {
      const tagFilter = (args.tags as string[]) || [];
      const q = String(args.query || "");
      let results: MemoryEntry[] = [];
      if (tagFilter.length > 0) {
        results = getSessionLog().searchMemoriesByTags(tagFilter, Number(args.maxResults) || 10);
      } else if (q) {
        results = getSessionLog().searchMemoriesByContent(q, Number(args.maxResults) || 10);
      } else {
        results = getSessionLog().searchMemoriesByTags([], Number(args.maxResults) || 10);
      }
      return results.map((e) => ({ content: e.content.slice(0, 500), tags: e.tags }));
    }
    case "list_memories": {
      return { message: "Memory tagging not tracked in JSONL mode. Use search_memory to find entries." };
    }
    case "delete_memory": {
      return { message: "Delete not supported with append-only JSONL. Use clear_memories to reset." };
    }
    case "update_memory": {
      return { message: "Update not supported with append-only JSONL. Use save_memory with new content." };
    }
    case "clear_memories": {
      getSessionLog().clear();
      return { deletedCount: 0, message: "Session log cleared." };
    }
    case "check_service": {
      try {
        const host = String(args.host || "localhost");
        const port = Number(args.port) || 0;
        const to = Number(args.timeout) || 5000;
        const reachable = await new Promise<boolean>((res) => {
          const { Socket } = require("net");
          const s = new Socket();
          s.setTimeout(to);
          s.on("connect", () => { s.destroy(); res(true); });
          s.on("error", () => { s.destroy(); res(false); });
          s.on("timeout", () => { s.destroy(); res(false); });
          s.connect(port, host);
        });
        let httpStatus: number | null = null;
        let httpBody: string | null = null;
        const httpPath = String(args.httpPath || "");
        if (reachable && httpPath) {
          try {
            const resp = await fetch(`http://${host}:${port}${httpPath}`, { signal: AbortSignal.timeout(to) });
            httpStatus = resp.status;
            httpBody = (await resp.text()).slice(0, 2000);
          } catch {}
        }
        return { host, port, reachable, httpStatus, httpBody };
      } catch (e) { return String(e); }
    }
    case "ssh_exec": {
      try {
        const { execSync } = require("child_process");
        const host = String(args.host || "");
        const user = String(args.user || "");
        const pass = String(args.password || "").replace(/'/g, "'\\''");
        const cmd = String(args.command || "");
        const port = Number(args.port) || 22;
        const to = Number(args.timeout) || 30000;
        const sshCmd = `sshpass -p '${pass}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${user}@${host} '${cmd.replace(/'/g, "'\\''")}'`;
        const result = execSync(sshCmd, { encoding: "utf-8", timeout: to, maxBuffer: 10 * 1024 * 1024 });
        return { exitCode: 0, stdout: (result || "").toString().trim() };
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: err.status ?? 1, stdout: (err.stdout || "").toString().trim(), stderr: (err.stderr || "").toString().trim() };
      }
    }
    case "set_workspace": {
      const resolved = resolve(String(args.path || ""));
      if (!existsSync(resolved)) return `Path does not exist: ${resolved}`;
      const config = readConfigSync();
      config.workspacePath = resolved;
      writeConfigSync(config);
      return { workspace: resolved };
    }
    case "get_config": {
      const config = readConfigSync();
      return { workspace: getWorkspace(), config };
    }
    default: return `Unknown tool: ${name}`;
  }
}

export { execToolByName, webSearch, binaryExtCheck, callLLM, pickBestModel, VLM_PATTERNS };

export async function orchestratorLoop(
  systemPrompt: string,
  userPrompt: string,
  maxTurns: number,
  autoWebSearch: boolean,
  qualityThreshold: number,
  contextWindow: number = 0,
  skipQuality: boolean = false,
): Promise<{
  result: string;
  turns: number;
  qualityScore: number;
  qualityReason: string;
  researchDone: boolean;
  completed: boolean;
  sessionsUsed: number;
  sessionLog: string[];
}> {
  const session = getSessionLog();
  const logEntries: string[] = [];
  const storedTurns: StoredTurn[] = [];
  if (contextWindow <= 0) contextWindow = await getContextWindow();
  const sessionId = crypto.randomUUID();

  let turns = 0;
  let completed = false;
  let researchDone = false;
  let stuckCount = 0;

  while (turns < maxTurns) {
    turns++;
    const contextMsgs = buildContextMessages(systemPrompt, userPrompt, storedTurns, MAX_CONTEXT_TURNS, contextWindow, sessionId);
    const estimatedTokens = contextMsgs.reduce(
      (s, m: any) => s + Math.ceil((typeof m.content === "string" ? m.content : JSON.stringify(m)).length / 4), 0
    );
    if (estimatedTokens > contextWindow * 0.80) {
      console.warn(`[AgenticTools] orchestratorLoop: context full (${estimatedTokens}/${contextWindow}) at turn ${turns}. Stopping.`);
      logEntries.push(`Turn ${turns}: stopped — context ceiling reached`);
      break;
    }
    const resp = await callLLM(contextMsgs, true, 0.3);
    if (!resp) {
      console.error(`[AgenticTools] orchestratorLoop: callLLM returned null at turn ${turns}. Aborting.`);
      break;
    }

    const text = resp.content;
    let calls = resp.tool_calls;

    if (isGarbageOutput(text) && (!calls || calls.length === 0)) {
      console.warn(`[AgenticTools] orchestratorLoop: garbage output detected at turn ${turns}, retrying with simpler prompt`);
      logEntries.push(`Turn ${turns}: garbage output, retrying`);
      const retryMessages = [
        { role: "system", content: "Use the provided tools. Call one tool at a time. Do not write long text." },
        { role: "user", content: userPrompt },
      ];
      const retryResp = await callLLM(retryMessages, true, 0.1);
      if (retryResp?.tool_calls && retryResp.tool_calls.length > 0) {
        calls = retryResp.tool_calls;
      }
    }

    const completeMatch = text?.match(/^\s*COMPLETE\s*:\s*(.*)/is);
    const toolCallEntries: Array<{ name: string; args: string; result?: string }> = [];

    if (!calls || calls.length === 0) {
      if (completeMatch) {
        storedTurns.push({
          assistant: { role: "assistant", content: text },
          toolResults: [],
        });
        completed = true;
        session.startTurn({
          type: "turn",
          sessionId,
          ts: new Date().toISOString(),
          turn: turns,
          role: "assistant",
          content: text,
        });
        logEntries.push(`Turn ${turns}: ${(text || "(no text)").slice(0, 120)} [0 tool calls]`);
        const summary = `Completed in ${turns} turns. Final: ${(text || "").slice(0, 200)}`;
        session.saveCheckpoint(summary, ["orchestrator", "complete"], turns, sessionId);
        logEntries.push(`Checkpoint: ${summary}`);
        break;
      }
      // Model sent text without calling a tool and without COMPLETE — stuck
      stuckCount++;
      if (stuckCount >= 3) {
        logEntries.push(`Turn ${turns}: stuck — no tool calls for ${stuckCount} consecutive turns, aborting`);
        break;
      }
      storedTurns.push({
        assistant: { role: "assistant", content: text },
        toolResults: [],
      });
      session.startTurn({
        type: "turn",
        sessionId,
        ts: new Date().toISOString(),
        turn: turns,
        role: "assistant",
        content: text,
      });
      logEntries.push(`Turn ${turns}: ${(text || "(no text)").slice(0, 120)} [0 tool calls]`);
      continue;
    }
    stuckCount = 0;

    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({
        id: c.function?.name || `call_${turns}`,
        type: c.type || "function",
        function: { name: c.function?.name, arguments: c.function?.arguments },
      })),
    };

    const toolResults: Record<string, unknown>[] = [];
    for (const call of calls) {
      const fn = call.function;
      if (!fn) continue;
      const argsStr = fn.arguments || "{}";
      const result = await execToolByName(fn.name, JSON.parse(argsStr));
      const raw = typeof result === "string" ? result : JSON.stringify(result);
      const capped = raw.length > TOOL_RESULT_MAX_CHARS
        ? raw.slice(0, TOOL_RESULT_MAX_CHARS) + `\n... [truncated at ${TOOL_RESULT_MAX_CHARS} chars]`
        : raw;
      toolCallEntries.push({ name: fn.name, args: argsStr, result: capped.slice(0, 300) });
      toolResults.push({
        role: "tool",
        tool_call_id: fn.name,
        content: capped,
      });
    }

    storedTurns.push({ assistant: assistantMsg, toolResults });

    session.startTurn({
      type: "turn",
      sessionId,
      ts: new Date().toISOString(),
      turn: turns,
      role: "assistant",
      content: text,
      toolCalls: toolCallEntries.length > 0 ? toolCallEntries : undefined,
    });
    logEntries.push(`Turn ${turns}: ${(text || "(no text)").slice(0, 120)} [${toolCallEntries.length} tool calls]`);

    // Prune old turns from memory — they live on disk in the session log
    if (storedTurns.length > MAX_CONTEXT_TURNS * 2) {
      const pruned = storedTurns.splice(0, storedTurns.length - MAX_CONTEXT_TURNS);
      const summary = pruned.map(t => {
        const content = (t.assistant.content as string) || "";
        const tools = t.toolResults.map(r => (r as any).tool_call_id || "tool").join(", ");
        return `${content.slice(0, 200)}${tools ? ` [used: ${tools}]` : ""}`;
      }).join("; ");
      session.saveCheckpoint(summary.slice(0, 500), ["orchestrator", "prune"], turns, sessionId);
      logEntries.push(`Checkpoint: pruned ${pruned.length} turns — ${summary.slice(0, 120)}`);
    }

    if (turns % 5 === 0) {
      session.saveCheckpoint(`Progress after ${turns} turns`, ["orchestrator", "progress"], turns, sessionId);
      logEntries.push(`Checkpoint: ${turns} turns completed`);
    }
  }

  const noToolsUsed = storedTurns.every(t => t.toolResults.length === 0);
  let finalText = storedTurns
    .map(t => {
      const parts: string[] = [];
      if (t.assistant.content) parts.push(t.assistant.content as string);
      for (const tr of t.toolResults) {
        if (tr.content) parts.push(`[${(tr as any).tool_call_id || "tool"}]: ${(tr.content as string).slice(0, 500)}`);
      }
      return parts.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
  if (noToolsUsed && finalText.length > 0) {
    finalText = `[WARNING: The model did not call any tools — result is raw model text without execution]\n\n${finalText}`;
  }

  // Quality check
  let qualityScore = 0.5;
  let qualityReason = "Quality evaluation skipped";
  if (!skipQuality) {
    const qMessages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content: "You are a quality evaluator. Rate the following result against the original task. Return a JSON object with: score (0.0-1.0), reason (2-3 sentence explanation). Only return valid JSON, no other text.",
      },
      {
        role: "user",
        content: `Task: ${userPrompt}\n\nResult:\n${finalText.slice(0, 8000)}`,
      },
    ];
    const qResp = await callLLM(qMessages, false, 0.1);
    if (qResp) {
      try {
        const parsed = JSON.parse(qResp.content);
        if (typeof parsed.score === "number") qualityScore = parsed.score;
        if (typeof parsed.reason === "string") qualityReason = parsed.reason;
      } catch (e) {
        console.warn(`[AgenticTools] quality evaluation JSON parse failed:`, e);
      }
    }
  }

  // Auto web search if quality is below threshold
  if (autoWebSearch && qualityScore < qualityThreshold) {
    const researchMessages: Array<Record<string, unknown>> = [
      {
        role: "system",
        content: "The previous result was of insufficient quality. Your task is to identify knowledge gaps and search the web for additional information. Use web_search and web_fetch. Then synthesize what you found. Max 5 turns.",
      },
      {
        role: "user",
        content: `Original task: ${userPrompt}\n\nPrevious result:\n${finalText.slice(0, 4000)}\n\nQuality score: ${qualityScore}\nReason: ${qualityReason}\n\nSearch for missing info now.`,
      },
    ];
    let rTurns = 0;
    const config2 = readConfigSync();
    const maxResearchTurns = (config2 as any).maxResearchTurns || 2;
    while (rTurns < maxResearchTurns) {
      rTurns++;
      const rResp = await callLLM(researchMessages, true, 0.4);
      if (!rResp) break;
      const rCalls = rResp.tool_calls;

      if (!rCalls || rCalls.length === 0) {
        researchDone = true;
        session.startTurn({
          type: "turn",
          sessionId,
          ts: new Date().toISOString(),
          turn: turns + rTurns,
          role: "assistant",
          content: rResp.content,
        });
        logEntries.push(`Research turn ${rTurns}: ${(rResp.content || "(no text)").slice(0, 120)} [0 tool calls]`);
        break;
      }

      researchMessages.push({
        role: "assistant",
        content: rResp.content || null,
        tool_calls: rCalls.map((c) => ({
          id: c.function?.name || `r_${rTurns}`,
          type: c.type || "function",
          function: { name: c.function?.name, arguments: c.function?.arguments },
        })),
      });

      const rToolCallEntries: Array<{ name: string; args: string; result?: string }> = [];
      for (const call of rCalls) {
        const fn = call.function;
        if (!fn) continue;
        const argsStr = fn.arguments || "{}";
        const result = await execToolByName(fn.name, JSON.parse(argsStr));
        const raw = typeof result === "string" ? result : JSON.stringify(result);
        const capped = raw.length > TOOL_RESULT_MAX_CHARS
          ? raw.slice(0, TOOL_RESULT_MAX_CHARS) + `\n... [truncated at ${TOOL_RESULT_MAX_CHARS} chars]`
          : raw;
        rToolCallEntries.push({ name: fn.name, args: argsStr, result: capped.slice(0, 300) });
        researchMessages.push({
          role: "tool",
          tool_call_id: fn.name,
          content: capped,
        });
      }

      session.startTurn({
        type: "turn",
        sessionId,
        ts: new Date().toISOString(),
        turn: turns + rTurns,
        role: "assistant",
        content: rResp.content,
        toolCalls: rToolCallEntries.length > 0 ? rToolCallEntries : undefined,
      });
      logEntries.push(`Research turn ${rTurns}: ${(rResp.content || "(no text)").slice(0, 120)} [${rToolCallEntries.length} tool calls]`);
    }

    const researchText = researchMessages
      .filter((m: any) => m.role === "assistant" && m.content)
      .map((m: any) => m.content)
      .join("\n\n");

    session.saveCheckpoint(`Research supplement completed (${rTurns} turns)`, ["orchestrator", "research"], turns + rTurns, sessionId);
    logEntries.push(`Checkpoint: Research supplement (${rTurns} turns)`);

    const researchResult = finalText + "\n\n=== Research Supplement ===\n" + researchText;
    if (researchResult && researchResult.length > 50) {
      session.saveMemory(
        ["orchestrator", "research", userPrompt.slice(0, 60)],
        researchResult.slice(0, 2000),
      );
      logEntries.push(`Auto-saved research findings to memory`);
    }

    return {
      result: researchResult,
      turns,
      qualityScore,
      qualityReason,
      researchDone,
      completed,
      sessionsUsed: 0,
      sessionLog: logEntries,
    };
  }

  session.saveCheckpoint(`Completed with quality score ${qualityScore}: ${qualityReason.slice(0, 100)}`, ["orchestrator", "done"], turns, sessionId);
  logEntries.push(`Checkpoint: Quality ${qualityScore} — ${qualityReason.slice(0, 100)}`);

  // Auto-save findings to disk memory
  if (finalText && finalText.length > 50) {
    const saveContent = finalText.slice(0, 2000);
    session.saveMemory(
      ["orchestrator", "result", userPrompt.slice(0, 60)],
      saveContent,
    );
    logEntries.push(`Auto-saved findings to memory: ${saveContent.slice(0, 100)}`);
  }

  return { result: finalText, turns, qualityScore, qualityReason, researchDone, completed, sessionsUsed: 0, sessionLog: logEntries };
}

// ─── Tools Provider ──────────────────────────────────────────────────────────

export async function toolsProvider(ctl: ToolsProviderController) {
  const setWorkspaceTool = tool({
    name: "set_workspace",
    description: text`Changes the workspace root for all file and bash operations (persisted).`,
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
  });

  const getConfigTool = tool({
    name: "get_config",
    description: text`Returns current config: workspace, config file, memory stats.`,
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
  });

  const webFetchTool = tool({
    name: "web_fetch",
    description: text`Fetches a URL and returns text content (max 500KB).`,
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
  });

  const calculateTool = tool({
    name: "calculate",
    description: text`Evaluates a math expression (arithmetic, trig, log, stats, units).`,
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
  });

  const currentDateTimeTool = tool({
    name: "get_current_datetime",
    description: text`Returns current date, time, timezone, and unix timestamp.`,
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
  });

  const listFilesTool = tool({
    name: "list_files",
    description: text`Lists files and directories relative to workspace.`,
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
  });

  const readFileTool = tool({
    name: "read_file",
    description: text`Reads a text file from the workspace (binary files rejected).`,
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
  });

  const writeFileTool = tool({
    name: "write_file",
    description: text`Writes text to a file (creates dirs, overwrites). Path relative to workspace.`,
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
  });

  const appendFileTool = tool({
    name: "append_file",
    description: text`Appends text to a file (creates if missing). Path relative to workspace.`,
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
  });

  const renameFileTool = tool({
    name: "rename_file",
    description: text`Renames or moves a file/dir. Both paths relative to workspace.`,
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
  });

  const searchFilesTool = tool({
    name: "search_files",
    description: text`Searches file contents recursively for a case-insensitive pattern.`,
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
  });

  const deleteFileTool = tool({
    name: "delete_file",
    description: text`Deletes a file or empty directory. Path relative to workspace.`,
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
  });

  const bashTerminalTool = tool({
    name: "bash_terminal",
    description: text`Runs a bash command in the workspace (fresh process each call).`,
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
  });

  const webSearchTool = tool({
    name: "web_search",
    description: text`Searches the web via DuckDuckGo (returns titles, snippets, URLs).`,
    parameters: {
      query: z.string().min(1).max(500).describe("Search query"),
      maxResults: z.number().int().min(1).max(10).optional().default(5).describe("Max results (default 5)"),
    },
    implementation: async ({ query, maxResults }) => {
      try { return ok(await webSearch(query, maxResults)); }
      catch (e: any) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const generateUuidTool = tool({
    name: "generate_uuid",
    description: text`Generates a random UUID v4 string. No parameters needed.`,
    parameters: {},
    implementation: async () => { const { randomUUID } = await import("crypto"); return ok({ uuid: randomUUID() }); },
  });

  const generatePasswordTool = tool({
    name: "generate_password",
    description: text`Generates a cryptographically random password with configurable length and special chars.`,
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
  });

  const encodeBase64Tool = tool({
    name: "encode_base64",
    description: text`Encodes text to Base64.`,
    parameters: { text: z.string().min(1).describe("Text to encode") },
    implementation: async ({ text }) => ok({ encoded: Buffer.from(text).toString("base64"), original: text }),
  });

  const decodeBase64Tool = tool({
    name: "decode_base64",
    description: text`Decodes Base64 to text.`,
    parameters: { base64: z.string().min(1).describe("Base64 string to decode") },
    implementation: async ({ base64 }) => {
      try { return ok({ decoded: Buffer.from(base64, "base64").toString("utf-8") }); }
      catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const saveMemoryTool = tool({
    name: "save_memory",
    description: text`Stores info in persistent JSONL knowledge base (survives restarts).`,
    parameters: {
      content: z.string().min(1).max(50000).describe("Information to store"),
      tags: z.array(z.string().max(50)).min(1).max(20).describe("Tags like ['project:myapp', 'language:python']"),
    },
    implementation: async ({ content, tags }) => {
      getSessionLog().saveMemory(tags, content);
      return ok({ saved: true });
    },
  });

  const searchMemoryTool = tool({
    name: "search_memory",
    description: text`Searches memories by tags and/or keyword (newest first).`,
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
  });

  const listMemoriesTool = tool({
    name: "list_memories",
    description: text`Lists total memories in the JSONL knowledge base.`,
    parameters: {},
    implementation: async () => {
      const total = getSessionLog().totalTurnsLogged();
      return ok({ totalEntries: total, message: "Use search_memory to find specific entries." });
    },
  });

  const deleteMemoryTool = tool({
    name: "delete_memory",
    description: text`Deletion not supported with append-only JSONL. Use clear_memories to reset the log.`,
    parameters: { id: z.string().min(1).describe("Memory entry ID") },
    implementation: async () => {
      return fail("Delete not supported with append-only JSONL. Use clear_memories to reset, or save_memory with fresh content.");
    },
  });

  const updateMemoryTool = tool({
    name: "update_memory",
    description: text`Update not supported with append-only JSONL. Use save_memory with new content and tags.`,
    parameters: {
      id: z.string().min(1).describe("Memory entry ID to update"),
      content: z.string().max(50000).optional().describe("New content"),
      tags: z.array(z.string().max(50)).min(1).max(20).optional().describe("New tags"),
    },
    implementation: async () => {
      return fail("Update not supported with append-only JSONL. Use save_memory with new content and tags.");
    },
  });

  const sshExecTool = tool({
    name: "ssh_exec",
    description: text`Executes a command on a remote machine via SSH (password auth).`,
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
  });

  const checkServiceTool = tool({
    name: "check_service",
    description: text`Checks if a network service is reachable via TCP (port check).`,
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
  });

  const clearMemoriesTool = tool({
    name: "clear_memories",
    description: text`Deletes all memory entries (irreversible).`,
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
  });

  // ─── Orchestrator Tool ──────────────────────────────────────────────────

  const consultExpertTool = tool({
    name: "consult_expert",
    description: text`CALL THIS when the user asks you to explore, analyze, read, search, investigate, or explain files, code, directories, or projects. This tool has full access to read files, list directories, search code, run commands, search the web, and save findings. It handles multi-step tasks autonomously with sub-agents.`,
    parameters: {
      task: z.string().min(1).max(10000).describe("Detailed task instructions"),
      maxTurns: z.number().int().min(1).max(50).optional().default(5).describe("Max execution turns (default 5)"),
      autoWebSearch: z.boolean().optional().default(false).describe("Auto-search web if quality is low (default false)"),
      qualityThreshold: z.number().min(0).max(1).optional().default(0.6).describe("Quality threshold (0-1)"),
    },
    implementation: async ({ task, maxTurns: mt, autoWebSearch: aws, qualityThreshold: qt }) => {
      const maxTurns = Math.min(mt || 5, 50);
      const autoSearch = aws !== false;
      const qualityThreshold = qt ?? 0.6;

      console.log(`[AgenticTools] consult_expert: task="${task?.slice(0, 80)}..." maxTurns=${maxTurns}`);

      // Phase 1: Plan
      let planText = "";
      const planMessages: Array<Record<string, unknown>> = [
        { role: "system", content: "You are a code analyst. Given a task, list 2-3 steps to investigate it. One step per line. Just plain text, no JSON." },
        { role: "user", content: `Task: ${task}` },
      ];
      const planResp = await callLLM(planMessages, false, 0.2);
      if (planResp?.content) {
        planText = planResp.content.trim();
        console.log(`[AgenticTools] Plan:\n${planText}`);
      }

      // Phase 2: Execute
      const systemPrompt = `You are an AI agent that works step by step using tools.

Plan:
${planText}

RULES:
- One tool call at a time. After each result, decide the next tool.
- You must complete ALL steps in the plan before saying COMPLETE.
- "Exploring" means: list files THEN read the actual file contents.
- You must read source files — not just list them — to provide real analysis.
- If you don't know enough, search_files or read more files.
- CRITICAL: You will lose context if you complete early.

BEFORE saying COMPLETE, verify:
  [ ] Did I list all relevant files?
  [ ] Did I read the file contents?
  [ ] Did I analyze what I read?

After completing ALL steps, respond:
COMPLETE: <your final analysis>`;

      const result = await orchestratorLoop(
        systemPrompt,
        `Task: ${task}\nPlan:\n${planText}`,
        maxTurns,
        autoSearch,
        qualityThreshold,
        0,
        (readConfigSync() as any).skipQualityEval !== false,
      );

      // Save result to persistent memory
      if (result.result && result.result.length > 50) {
        getSessionLog().saveMemory([`task:${task?.slice(0, 60)}`], result.result.slice(0, 2000));
      }

      return ok({
        result: result.result,
        qualityScore: result.qualityScore,
        qualityReason: result.qualityReason,
        turnsUsed: result.turns,
        researchTriggered: result.researchDone,
        completed: result.completed,
      });
    },
  });

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
    consult_expert: consultExpertTool,
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
  };

  const DEFAULT_ENABLED = [
    "set_workspace", "get_config", "save_memory", "search_memory",
    "consult_expert", "web_fetch", "web_search",
    "read_file", "list_files", "search_files", "bash_terminal",
    "calculate", "get_current_datetime", "write_file",
  ];

  const configTools = readConfigSync();
  const enabledNames = (configTools as any).enabledTools || DEFAULT_ENABLED;
  const allTools = enabledNames
    .filter((name: string) => ALL_TOOL_MAP[name])
    .map((name: string) => ALL_TOOL_MAP[name]);

  for (const t of allTools) {
    const name = t.spec?.name ?? t.name ?? "?";
    const origImpl = t.implementation;
    t.implementation = async (args: any) => {
      console.log(`[AgenticTools] Tool called: ${name}`);
      const result = await origImpl(args);
      console.log(`[AgenticTools] Tool finished: ${name}`);
      return result;
    };
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
