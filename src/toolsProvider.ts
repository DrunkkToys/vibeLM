import { text, tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { writeFile, appendFile, unlink, mkdir, rm } from "fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, relative, extname } from "path";
import { homedir } from "os";
import * as math from "mathjs";

const LMSTUDIO_API_PORT = process.env.LMSTUDIO_API_PORT || "1234";
const API_BASE = `http://localhost:${LMSTUDIO_API_PORT}`;

const CONFIG_PATH = resolve(
  homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "config.json",
);
const KNOWLEDGE_PATH = resolve(
  homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "knowledge-base.json",
);

const MAX_KB_ENTRIES = 10_000;
const MAX_KB_BYTES = 50 * 1024 * 1024;
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".o", ".obj", ".pyc", ".class",
  ".ttf", ".otf", ".woff", ".woff2",
]);

interface PluginConfig {
  workspacePath: string;
}

function defaultConfig(): PluginConfig {
  return { workspacePath: homedir() };
}

function readConfigSync(): PluginConfig {
  try {
    const raw = existsSync(CONFIG_PATH)
      ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
      : {};
    return { ...defaultConfig(), ...raw };
  } catch {
    return defaultConfig();
  }
}

function writeConfigSync(config: PluginConfig): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  require("fs").writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function mkdirSync(dir: string, opts: { recursive: boolean }): void {
  require("fs").mkdirSync(dir, opts);
}

function getWorkspace(sessionDir?: string): string {
  const config = readConfigSync();
  return (config.workspacePath || sessionDir || process.cwd()).trim();
}

function sandboxPath(workspace: string, requestedPath: string): string {
  const resolved = resolve(workspace, requestedPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Path "${requestedPath}" is outside the workspace "${workspace}"`);
  }
  return resolved;
}

interface MemoryEntry {
  id: string;
  content: string;
  tags: string[];
  created: string;
  updated: string;
}

function readKnowledgeBase(): MemoryEntry[] {
  try {
    return existsSync(KNOWLEDGE_PATH)
      ? JSON.parse(readFileSync(KNOWLEDGE_PATH, "utf-8"))
      : [];
  } catch {
    return [];
  }
}

function writeKnowledgeBase(entries: MemoryEntry[]): void {
  const dir = dirname(KNOWLEDGE_PATH);
  if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
  require("fs").writeFileSync(KNOWLEDGE_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

function kbSize(): number {
  try {
    return statSync(KNOWLEDGE_PATH).size;
  } catch {
    return 0;
  }
}

function ok(data: unknown) {
  return { ok: true, data };
}
function fail(msg: string) {
  return { ok: false, error: msg };
}

const binaryExtCheck = (p: string) => BINARY_EXTS.has(extname(p).toLowerCase());

export async function toolsProvider(ctl: ToolsProviderController) {
  const setWorkspaceTool = tool({
    name: "set_workspace",
    description: text`
      Changes the workspace folder for all subsequent file and bash operations.
      The workspace is persisted to disk so it survives plugin restarts.
      All file tools (list_files, read_file, write_file, append_file, rename_file, search_files, delete_file)
      and bash_terminal will use this as their root directory.
      Paths outside the workspace are blocked for security.
    `,
    parameters: {
      path: z.string().min(1).describe("Absolute path to the new workspace folder"),
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

  const pickWorkspaceTool = tool({
    name: "pick_workspace",
    description: text`
      Opens a native macOS folder picker dialog to visually select a workspace folder.
      Only works on macOS. On other platforms, use set_workspace instead.
    `,
    parameters: {},
    implementation: async () => {
      if (process.platform !== "darwin") {
        return fail("pick_workspace only supports macOS. Use set_workspace instead.");
      }
      try {
        const { execSync } = await import("child_process");
        const selected = execSync(
          'osascript -e \'tell application "Finder" to return POSIX path of (choose folder with prompt "Select workspace for agentic-tools")\'',
          { encoding: "utf-8", timeout: 120000 },
        ).trim();
        if (!selected) return ok({ cancelled: true });
        const resolved = resolve(selected.replace(/:$/, ""));
        if (!existsSync(resolved)) return fail(`Selected path does not exist: ${resolved}`);
        const config = readConfigSync();
        config.workspacePath = resolved;
        writeConfigSync(config);
        return ok({ workspace: resolved });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("User cancelled") || msg.includes("timed out")) return ok({ cancelled: true });
        return fail(`Folder picker error: ${msg}`);
      }
    },
  });

  const getConfigTool = tool({
    name: "get_config",
    description: text`
      Returns current config: workspace folder, config file location, memory stats.
    `,
    parameters: {},
    implementation: async () => {
      const config = readConfigSync();
      return ok({
        workspace: getWorkspace(ctl.getWorkingDirectory()),
        configFile: CONFIG_PATH,
        configFileExists: existsSync(CONFIG_PATH),
        config,
        totalMemories: readKnowledgeBase().length,
        sessionWorkingDirectory: ctl.getWorkingDirectory(),
      });
    },
  });

  const webFetchTool = tool({
    name: "web_fetch",
    description: text`
      Fetches a URL and returns its text content. Max 500KB. Use for reading web pages and APIs.
    `,
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
    description: text`
      Evaluates a math expression using mathjs. Supports arithmetic, trig, log, stats, matrices, units.
      Examples: "2+2", "sin(pi/4)", "sqrt(144)", "3km to miles"
    `,
    parameters: {
      expression: z.string().min(1).max(500).describe("Math expression to evaluate"),
    },
    implementation: async ({ expression }) => {
      try {
        const result = math.evaluate(expression);
        if (typeof result === "object" && result?.toString) return ok({ result: result.toString() });
        return ok({ result });
      } catch (e: unknown) {
        return fail(`Evaluation error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  const currentDateTimeTool = tool({
    name: "get_current_datetime",
    description: text`
      Returns current date, time, timezone, and unix timestamp.
    `,
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
    description: text`
      Lists files and directories in the workspace. Paths are relative to workspace.
    `,
    parameters: {
      path: z.string().optional().default(".").describe("Directory relative to workspace"),
    },
    implementation: async ({ path }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const dir = sandboxPath(ws, path);
        const entries = readdirSync(dir, { withFileTypes: true });
        return ok({
          workspace: ws,
          path: dir,
          entries: entries.map((e) => {
            const full = resolve(dir, e.name);
            let size = null;
            try { if (e.isFile()) size = statSync(full).size; } catch {}
            return { name: e.name, type: e.isDirectory() ? "directory" : "file", size };
          }),
          count: entries.length,
        });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const readFileTool = tool({
    name: "read_file",
    description: text`
      Reads a text file from the workspace. Path is relative to workspace. Binary files (.png, .pdf, .zip etc.) are detected and rejected.
    `,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars (default 50000)"),
    },
    implementation: async ({ filePath, maxChars }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const resolved = sandboxPath(ws, filePath);
        if (!existsSync(resolved)) return fail(`File not found: ${resolved}`);
        const st = statSync(resolved);
        if (st.isDirectory()) return fail(`Is a directory: ${resolved}`);
        if (binaryExtCheck(resolved)) return fail(`Cannot read binary file: ${filePath}. Use bash_terminal for binary files.`);
        const content = readFileSync(resolved, "utf-8");
        if (content.length > maxChars) return ok({ content: content.slice(0, maxChars), truncated: true, originalLength: content.length });
        return ok({ content });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const writeFileTool = tool({
    name: "write_file",
    description: text`
      Writes text content to a file. Creates parent directories automatically. Overwrites existing files. Path relative to workspace.
    `,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      content: z.string().describe("Text content to write"),
    },
    implementation: async ({ filePath, content }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const resolved = sandboxPath(ws, filePath);
        const parent = dirname(resolved);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
        await writeFile(resolved, content, "utf-8");
        return ok({ path: resolved, workspace: ws, size: Buffer.byteLength(content, "utf-8"), action: "written" });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const appendFileTool = tool({
    name: "append_file",
    description: text`
      Appends text to the end of an existing file. Creates the file if it doesn't exist. Path relative to workspace.
    `,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      content: z.string().describe("Text content to append"),
    },
    implementation: async ({ filePath, content }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const resolved = sandboxPath(ws, filePath);
        const parent = dirname(resolved);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
        await appendFile(resolved, content, "utf-8");
        const size = statSync(resolved).size;
        return ok({ path: resolved, workspace: ws, size, action: "appended" });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const renameFileTool = tool({
    name: "rename_file",
    description: text`
      Renames or moves a file or directory. Creates parent directory for destination if needed. Both paths relative to workspace.
    `,
    parameters: {
      sourcePath: z.string().min(1).describe("Current path relative to workspace"),
      destPath: z.string().min(1).describe("New path relative to workspace"),
    },
    implementation: async ({ sourcePath, destPath }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const src = sandboxPath(ws, sourcePath);
        const dst = sandboxPath(ws, destPath);
        if (!existsSync(src)) return fail(`Source not found: ${sourcePath}`);
        const dstParent = dirname(dst);
        if (!existsSync(dstParent)) await mkdir(dstParent, { recursive: true });
        const { rename } = await import("fs/promises");
        await rename(src, dst);
        return ok({ from: src, to: dst, workspace: ws });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const searchFilesTool = tool({
    name: "search_files",
    description: text`
      Searches file contents recursively from a directory for a case-insensitive text pattern.
      Returns matching file paths with line numbers. Path relative to workspace.
    `,
    parameters: {
      pattern: z.string().min(1).max(200).describe("Text pattern to search for (case-insensitive)"),
      path: z.string().optional().default(".").describe("Starting directory relative to workspace"),
      include: z.string().optional().describe("File glob pattern (e.g. '*.ts', '*.{js,ts,md}')"),
      maxResults: z.number().int().min(1).max(200).optional().default(50).describe("Max matches (default 50)"),
    },
    implementation: async ({ pattern, path, include, maxResults }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const dir = sandboxPath(ws, path);
        const q = pattern.toLowerCase();
        const results: Array<{ file: string; line: number; content: string }> = [];

        function walk(current: string): void {
          if (results.length >= maxResults) return;
          try {
            const ents = readdirSync(current, { withFileTypes: true });
            for (const e of ents) {
              if (results.length >= maxResults) return;
              const full = resolve(current, e.name);
              if (e.isDirectory()) {
                if (!e.name.startsWith(".") && e.name !== "node_modules") walk(full);
              } else if (e.isFile()) {
                if (include) {
                  const minimatch = (name: string, pat: string): boolean => {
                    const re = new RegExp("^" + pat.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
                    return re.test(name);
                  };
                  if (!minimatch(e.name, include)) continue;
                }
                if (binaryExtCheck(full)) continue;
                try {
                  const lines = readFileSync(full, "utf-8").split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (results.length >= maxResults) break;
                    if (lines[i].toLowerCase().includes(q)) {
                      results.push({ file: full, line: i + 1, content: lines[i].trim().slice(0, 200) });
                    }
                  }
                } catch {}
              }
            }
          } catch {}
        }

        walk(dir);
        return ok({ pattern, workspace: ws, path: dir, results, total: results.length });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const deleteFileTool = tool({
    name: "delete_file",
    description: text`
      Deletes a file or empty directory. Use bash_terminal 'rm -rf' for non-empty directories.
      Permanently removes from filesystem. Path relative to workspace.
    `,
    parameters: {
      path: z.string().min(1).describe("Path relative to workspace"),
    },
    implementation: async ({ path }) => {
      try {
        const ws = getWorkspace(ctl.getWorkingDirectory());
        const resolved = sandboxPath(ws, path);
        if (!existsSync(resolved)) return fail(`Not found: ${resolved}`);
        const st = statSync(resolved);
        if (st.isDirectory()) {
          const contents = readdirSync(resolved);
          if (contents.length > 0) return fail(`Directory is not empty (${contents.length} items). Use bash_terminal 'rm -rf' for non-empty directories.`);
          await rm(resolved, { recursive: true });
        } else {
          await unlink(resolved);
        }
        return ok({ path: resolved, workspace: ws, action: "deleted" });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const bashTerminalTool = tool({
    name: "bash_terminal",
    description: text`
      Runs a bash command in the workspace folder. Returns exit code, stdout, stderr.
      Each call is a fresh process — no state persists between calls.
      Use for git, npm, python, file operations, scripts.
    `,
    parameters: {
      command: z.string().min(1).max(5000).describe("Bash command to execute"),
      timeout: z.number().int().min(1000).max(120000).optional().default(30000).describe("Timeout ms (default 30000, max 120000)"),
    },
    implementation: async ({ command, timeout }) => {
      try {
        const { exec } = await import("child_process");
        return await new Promise((res) => {
          exec(command, { cwd: getWorkspace(ctl.getWorkingDirectory()), env: { ...process.env }, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            res(ok({ exitCode: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "", killed: !!err?.killed, signal: err?.signal ?? null }));
          });
        });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const webSearchTool = tool({
    name: "web_search",
    description: text`
      Searches the web via DuckDuckGo. Returns titles, snippets, URLs. For full content, use web_fetch on a result URL.
      Free API — may be rate-limited. If empty, try a different query.
    `,
    parameters: {
      query: z.string().min(1).max(500).describe("Search query"),
      maxResults: z.number().int().min(1).max(10).optional().default(5).describe("Max results (default 5)"),
    },
    implementation: async ({ query, maxResults }) => {
      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "LMStudio-AgenticTools/1.0" } });
        clearTimeout(t);
        if (!resp.ok) return fail(`DuckDuckGo returned HTTP ${resp.status}`);
        const data = await resp.json();
        const results: Array<{ title: string; snippet: string; url: string }> = [];
        if (data.AbstractText) results.push({ title: data.AbstractSource || "Summary", snippet: data.AbstractText, url: data.AbstractURL || "" });
        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics) {
            if (results.length >= maxResults) break;
            if (topic.Text) results.push({ title: topic.FirstURL || topic.Text.split(" - ")[0], snippet: topic.Text, url: topic.FirstURL || "" });
            if (topic.Topics) for (const sub of topic.Topics) { if (results.length < maxResults) results.push({ title: sub.FirstURL || sub.Text.split(" - ")[0], snippet: sub.Text, url: sub.FirstURL || "" }); }
          }
        }
        if (results.length === 0) return ok({ query, results: [], message: "No results. Try a different query." });
        return ok({ query, results });
      } catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const generateUuidTool = tool({
    name: "generate_uuid",
    description: text`Generates a random UUID v4 string. No parameters needed.`,
    parameters: {},
    implementation: async () => {
      const { randomUUID } = await import("crypto");
      return ok({ uuid: randomUUID() });
    },
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
      for (let i = 0; i < length; i++) {
        password += chars[randomInt(0, chars.length)];
      }
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
      catch (e: unknown) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  });

  const saveMemoryTool = tool({
    name: "save_memory",
    description: text`
      Stores information in the persistent knowledge base (survives restarts). Tags for retrieval.
      Max 10,000 entries or 50MB total.
    `,
    parameters: {
      content: z.string().min(1).max(50000).describe("Information to store"),
      tags: z.array(z.string().max(50)).min(1).max(20).describe("Tags like ['project:myapp', 'language:python']"),
    },
    implementation: async ({ content, tags }) => {
      const entries = readKnowledgeBase();
      if (entries.length >= MAX_KB_ENTRIES) return fail(`Knowledge base full (${MAX_KB_ENTRIES} entries). Use clear_memories or delete_memory first.`);
      if (kbSize() >= MAX_KB_BYTES) return fail(`Knowledge base exceeds ${MAX_KB_BYTES / 1024 / 1024}MB. Use clear_memories or delete_memory first.`);
      const now = new Date().toISOString();
      const entry: MemoryEntry = { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, content, tags, created: now, updated: now };
      entries.push(entry);
      writeKnowledgeBase(entries);
      return ok({ id: entry.id, totalEntries: entries.length });
    },
  });

  const searchMemoryTool = tool({
    name: "search_memory",
    description: text`
      Searches the knowledge base by tags and/or keyword. Results sorted newest first.
    `,
    parameters: {
      tags: z.array(z.string().max(50)).optional().describe("Filter by tags (AND: entries matching ANY tag)"),
      query: z.string().max(200).optional().describe("Keyword search in content (case-insensitive)"),
      maxResults: z.number().int().min(1).max(50).optional().default(10).describe("Max results (default 10)"),
    },
    implementation: async ({ tags, query, maxResults }) => {
      const entries = readKnowledgeBase();
      let filtered = entries;
      if (tags && tags.length > 0) filtered = filtered.filter((e) => tags.some((t) => e.tags.includes(t)));
      if (query) { const q = query.toLowerCase(); filtered = filtered.filter((e) => e.content.toLowerCase().includes(q)); }
      filtered.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
      return ok({
        results: filtered.slice(0, maxResults).map((e) => ({ id: e.id, content: e.content.length > 500 ? e.content.slice(0, 500) + "..." : e.content, tags: e.tags, created: e.created })),
        totalMatches: filtered.length,
      });
    },
  });

  const listMemoriesTool = tool({
    name: "list_memories",
    description: text`
      Lists all tags in the knowledge base with entry counts and total entries.
    `,
    parameters: {},
    implementation: async () => {
      const entries = readKnowledgeBase();
      const tagCounts: Record<string, number> = {};
      for (const e of entries) for (const t of e.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
      return ok({
        totalEntries: entries.length,
        tags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
      });
    },
  });

  const deleteMemoryTool = tool({
    name: "delete_memory",
    description: text`Deletes a memory entry by ID. Use search_memory to find the ID first.`,
    parameters: { id: z.string().min(1).describe("Memory entry ID") },
    implementation: async ({ id }) => {
      const entries = readKnowledgeBase();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return fail(`No memory entry with ID "${id}"`);
      entries.splice(idx, 1);
      writeKnowledgeBase(entries);
      return ok({ deletedId: id, remainingEntries: entries.length });
    },
  });

  const updateMemoryTool = tool({
    name: "update_memory",
    description: text`Updates an existing memory entry. Omit fields you don't want to change.`,
    parameters: {
      id: z.string().min(1).describe("Memory entry ID to update"),
      content: z.string().max(50000).optional().describe("New content (omit to keep)"),
      tags: z.array(z.string().max(50)).min(1).max(20).optional().describe("New tags (omit to keep)"),
    },
    implementation: async ({ id, content, tags }) => {
      const entries = readKnowledgeBase();
      const entry = entries.find((e) => e.id === id);
      if (!entry) return fail(`No memory entry with ID "${id}"`);
      if (content !== undefined) entry.content = content;
      if (tags !== undefined) entry.tags = tags;
      entry.updated = new Date().toISOString();
      writeKnowledgeBase(entries);
      return ok({ id });
    },
  });

  const clearMemoriesTool = tool({
    name: "clear_memories",
    description: text`
      Deletes all memory entries from the knowledge base, or only those matching specific tags.
      Use with caution — this is irreversible.
    `,
    parameters: {
      tags: z.array(z.string().max(50)).optional().describe("If provided, only delete entries matching ANY of these tags"),
    },
    implementation: async ({ tags }) => {
      const entries = readKnowledgeBase();
      if (tags && tags.length > 0) {
        const before = entries.length;
        const remaining = entries.filter((e) => !tags.some((t) => e.tags.includes(t)));
        const removed = before - remaining.length;
        writeKnowledgeBase(remaining);
        return ok({ deletedCount: removed, remainingEntries: remaining.length });
      }
      writeKnowledgeBase([]);
      return ok({ deletedCount: entries.length, remainingEntries: 0 });
    },
  });

  const consultExpertTool = tool({
    name: "consult_expert",
    description: text`
      Delegates a complex task to a specialist sub-agent. Roles: coder, debugger, architect, reviewer, writer, analyst, researcher, data_scientist, knowledge_keeper.
      The sub-agent runs autonomously with full tool access and returns results.
    `,
    parameters: {
      task: z.string().min(1).max(10000).describe("Detailed task instructions"),
      expertRole: z.enum(["coder", "debugger", "architect", "reviewer", "writer", "analyst", "researcher", "data_scientist", "knowledge_keeper"]).optional().default("coder").describe("Expert persona"),
      context: z.string().max(20000).optional().default("").describe("Background context for the expert"),
    },
    implementation: async ({ task, expertRole, context }) => {
      const expertPrompts: Record<string, string> = {
        coder: "You are an expert software engineer. Write clean, safe code. Run linting, type-checking, and tests. Use bash_terminal and file tools to create/modify files.",
        debugger: "You are an expert debugger. Systematically diagnose issues, check logs, test hypotheses, implement fixes, and verify.",
        architect: "You are a software architect. Design robust systems. Review code structure and document architecture decisions.",
        reviewer: "You are a senior code reviewer. Check for bugs, security, performance, and style issues. Be thorough and constructive.",
        writer: "You are a technical writer. Create clear documentation, READMEs, API docs in markdown.",
        analyst: "You are a research analyst. Gather data, analyze, verify facts. Use web_fetch and web_search.",
        researcher: "You are a research specialist. Do deep multi-source web research. Cross-reference and verify all facts. Save results as .md or .jsonl files using write_file with descriptive filenames.",
        data_scientist: "You are a data scientist and Python/pandas expert. Analyze data, create .ipynb notebooks, run Python via bash_terminal. Use pandas, numpy, matplotlib. Save results as .csv, .json, .md, .png. Document methodology in .md files.\n\nCheck: python3 -c 'import pandas, numpy, matplotlib; print(\"ready\")'\nCheck jupyter: python3 -c 'import nbformat; print(\"nbformat ready\")'\nIf missing: pip install jupyter nbformat",
        knowledge_keeper: "You are a knowledge base librarian. Store, organize, retrieve, and maintain information using save_memory, search_memory, list_memories, update_memory, delete_memory. Save project configs, code patterns, research findings, and decisions with descriptive tags.",
      };
      const systemPrompt = expertPrompts[expertRole] || expertPrompts.coder;
      const fullPrompt = context ? `Context:\n${context}\n\n---\n\nTask:\n${task}` : task;
      const toolNames = [
        "web_fetch", "calculate", "get_current_datetime",
        "list_files", "read_file", "write_file", "append_file", "rename_file", "delete_file", "search_files",
        "bash_terminal", "web_search",
        "generate_uuid", "generate_password", "encode_base64", "decode_base64",
        "save_memory", "search_memory", "list_memories", "delete_memory", "update_memory", "clear_memories",
      ];

      async function execTool(name: string, args: Record<string, unknown>): Promise<unknown> {
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
              exec(String(args.command || ""), { cwd: getWorkspace(), timeout: Number(args.timeout) || 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
                res({ exitCode: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "" });
              });
            });
          }
          case "read_file": {
            try {
              const p = sandboxPath(getWorkspace(), String(args.filePath || args.path || ""));
              return readFileSync(p, "utf-8");
            } catch (e) { return String(e); }
          }
          case "write_file": {
            try {
              const pw = sandboxPath(getWorkspace(), String(args.filePath || ""));
              const dir = dirname(pw);
              if (!existsSync(dir)) await mkdir(dir, { recursive: true });
              await writeFile(pw, String(args.content || ""), "utf-8");
              return { success: true, path: pw };
            } catch (e) { return String(e); }
          }
          case "append_file": {
            try {
              const pw = sandboxPath(getWorkspace(), String(args.filePath || ""));
              const dir = dirname(pw);
              if (!existsSync(dir)) await mkdir(dir, { recursive: true });
              await appendFile(pw, String(args.content || ""), "utf-8");
              return { success: true, path: pw };
            } catch (e) { return String(e); }
          }
          case "rename_file": {
            try {
              const { rename } = await import("fs/promises");
              const src = sandboxPath(getWorkspace(), String(args.sourcePath || ""));
              const dst = sandboxPath(getWorkspace(), String(args.destPath || ""));
              const d = dirname(dst);
              if (!existsSync(d)) await mkdir(d, { recursive: true });
              await rename(src, dst);
              return { success: true, from: src, to: dst };
            } catch (e) { return String(e); }
          }
          case "delete_file": {
            try {
              const p = sandboxPath(getWorkspace(), String(args.path || ""));
              const st = statSync(p);
              if (st.isDirectory()) {
                if (readdirSync(p).length > 0) return "Directory not empty. Use bash_terminal rm -rf.";
                await rm(p, { recursive: true });
              } else {
                await unlink(p);
              }
              return { success: true, path: p };
            } catch (e) { return String(e); }
          }
          case "list_files": {
            try {
              const pl = sandboxPath(getWorkspace(), String(args.path || "."));
              return readdirSync(pl, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
            } catch (e) { return String(e); }
          }
          case "search_files": {
            try {
              const pattern = String(args.pattern || "").toLowerCase();
              const start = sandboxPath(getWorkspace(), String(args.path || "."));
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
            try {
              const q = String(args.query || "");
              const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, { headers: { "User-Agent": "LMStudio-AgenticTools/1.0" } });
              const d = await r.json();
              const results: Array<{ title: string; snippet: string }> = [];
              if (d.AbstractText) results.push({ title: d.AbstractSource || "Summary", snippet: d.AbstractText });
              if (d.RelatedTopics) for (const t of d.RelatedTopics) { if (t.Text) results.push({ title: t.FirstURL || "", snippet: t.Text }); if (t.Topics) for (const s of t.Topics) results.push({ title: s.FirstURL || "", snippet: s.Text }); }
              return results.slice(0, Number(args.maxResults) || 5);
            } catch (e) { return String(e); }
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
            const entries = readKnowledgeBase();
            if (entries.length >= MAX_KB_ENTRIES) return "Knowledge base full.";
            const entry: MemoryEntry = { id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, content: String(args.content || ""), tags: (args.tags as string[]) || [], created: new Date().toISOString(), updated: new Date().toISOString() };
            entries.push(entry);
            writeKnowledgeBase(entries);
            return { success: true, id: entry.id };
          }
          case "search_memory": {
            const all = readKnowledgeBase();
            const tagFilter = (args.tags as string[]) || [];
            const q = String(args.query || "").toLowerCase();
            let f = all;
            if (tagFilter.length > 0) f = f.filter((e) => tagFilter.some((t) => e.tags.includes(t)));
            if (q) f = f.filter((e) => e.content.toLowerCase().includes(q));
            f.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
            return f.slice(0, Number(args.maxResults) || 10).map((e) => ({ id: e.id, content: e.content.slice(0, 500), tags: e.tags, created: e.created }));
          }
          case "list_memories": {
            const m = readKnowledgeBase();
            const cts: Record<string, number> = {};
            for (const e of m) for (const t of e.tags) cts[t] = (cts[t] || 0) + 1;
            return { totalEntries: m.length, tags: Object.entries(cts).sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ tag: t, count: c })) };
          }
          case "delete_memory": {
            const mems = readKnowledgeBase();
            const idx = mems.findIndex((e) => e.id === String(args.id || ""));
            if (idx === -1) return `Not found: ${args.id}`;
            mems.splice(idx, 1);
            writeKnowledgeBase(mems);
            return { success: true, deletedId: args.id };
          }
          case "update_memory": {
            const mems = readKnowledgeBase();
            const entry = mems.find((e) => e.id === String(args.id || ""));
            if (!entry) return `Not found: ${args.id}`;
            if (args.content !== undefined) entry.content = String(args.content);
            if (args.tags !== undefined) entry.tags = args.tags as string[];
            entry.updated = new Date().toISOString();
            writeKnowledgeBase(mems);
            return { success: true, id: args.id };
          }
          case "clear_memories": {
            const all = readKnowledgeBase();
            const tgs = (args.tags as string[]) || [];
            if (tgs.length > 0) {
              const remaining = all.filter((e) => !tgs.some((t) => e.tags.includes(t)));
              const removed = all.length - remaining.length;
              writeKnowledgeBase(remaining);
              return { deletedCount: removed };
            }
            writeKnowledgeBase([]);
            return { deletedCount: all.length };
          }
          default: return `Unknown tool: ${name}`;
        }
      }

      try {
        const systemMsg = `${systemPrompt}\n\nAvailable tools: ${toolNames.join(", ")}. Use them. Reply with analysis, actions, and results.`;
        const messages: Array<Record<string, unknown>> = [
          { role: "system", content: systemMsg },
          { role: "user", content: fullPrompt },
        ];
        let finalResult = "";
        let done = false;
        let turns = 0;
        const maxTurns = 15;

        while (!done && turns < maxTurns) {
          turns++;
          const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "", messages, max_tokens: 4096, temperature: 0.3 }),
          });
          if (!resp.ok) return `Expert API returned HTTP ${resp.status}`;
          const data = await resp.json() as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ type: string; function?: { name: string; arguments: string } }> } }> };
          const msg = data.choices?.[0]?.message;
          if (!msg) return "No response from expert API.";
          const text = msg.content || "";
          finalResult += text;
          const calls = msg.tool_calls;
          if (!calls || calls.length === 0) { done = true; break; }
          messages.push({ role: "assistant", content: text || null, tool_calls: calls.map((c) => ({ id: c.function?.name, type: c.type, function: { name: c.function?.name, arguments: c.function?.arguments } })) } as never);
          for (const call of calls) {
            const fn = call.function;
            if (!fn) continue;
            const result = await execTool(fn.name, JSON.parse(fn.arguments || "{}"));
            messages.push({ role: "tool", tool_call_id: fn.name, content: typeof result === "string" ? result : JSON.stringify(result) } as never);
          }
        }
        return ok({ expert: expertRole, task, result: finalResult, turns, completed: done });
      } catch (e: unknown) {
        return fail(`Expert error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  return [
    setWorkspaceTool,
    pickWorkspaceTool,
    getConfigTool,
    saveMemoryTool,
    searchMemoryTool,
    listMemoriesTool,
    updateMemoryTool,
    deleteMemoryTool,
    clearMemoriesTool,
    consultExpertTool,
    webFetchTool,
    calculateTool,
    currentDateTimeTool,
    listFilesTool,
    readFileTool,
    writeFileTool,
    appendFileTool,
    renameFileTool,
    searchFilesTool,
    deleteFileTool,
    bashTerminalTool,
    webSearchTool,
    generateUuidTool,
    generatePasswordTool,
    encodeBase64Tool,
    decodeBase64Tool,
  ];
}
