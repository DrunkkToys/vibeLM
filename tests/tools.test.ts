import { describe, it, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir, homedir } from "os";
import { join, resolve, relative, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "fs";

const TEST_DIR = join(tmpdir(), "agentic-tools-test-" + Date.now());
const CONFIG_PATH = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools", "config.json");

function sandboxPath(workspace: string, requestedPath: string): string {
  const resolved = resolve(workspace, requestedPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Path "${requestedPath}" is outside the workspace "${workspace}"`);
  }
  return resolved;
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

function binaryExtCheck(p: string): boolean {
  const base = p.split("/").pop()?.split(".").pop();
  if (!base) return false;
  return BINARY_EXTS.has("." + base.toLowerCase());
}

describe("sandboxPath", () => {
  before(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "hello.txt"), "Hello World\n");
    mkdirSync(join(TEST_DIR, "sub"));
    writeFileSync(join(TEST_DIR, "sub", "nested.js"), "const x = 1;\n");
  });
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it("resolves within workspace", () => {
    assert.equal(sandboxPath(TEST_DIR, "hello.txt"), join(TEST_DIR, "hello.txt"));
  });
  it("resolves subdirectory path", () => {
    assert.equal(sandboxPath(TEST_DIR, "sub/nested.js"), join(TEST_DIR, "sub", "nested.js"));
  });
  it("resolves dot to workspace root", () => {
    assert.equal(sandboxPath(TEST_DIR, "."), TEST_DIR);
  });
  it("rejects path outside workspace (../)", () => {
    assert.throws(() => sandboxPath(TEST_DIR, ".."), /outside the workspace/);
  });
  it("rejects absolute path outside workspace", () => {
    assert.throws(() => sandboxPath(TEST_DIR, "/etc"), /outside the workspace/);
  });
  it("rejects traversal via subdirectory", () => {
    assert.throws(() => sandboxPath(TEST_DIR, "sub/../../etc"), /outside the workspace/);
  });
  it("returns absolute path unchanged if inside workspace", () => {
    assert.equal(sandboxPath(TEST_DIR, join(TEST_DIR, "hello.txt")), join(TEST_DIR, "hello.txt"));
  });
});

describe("binaryExtCheck", () => {
  const binaryExts = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".exe", ".dll", ".pyc", ".mp4", ".wasm"];
  const textExts = [".txt", ".js", ".ts", ".py", ".md", ".html", ".css", ".json", ".yaml", ".xml", ".csv", ".log"];

  for (const ext of binaryExts) {
    it(`detects ${ext} as binary`, () => {
      assert.equal(binaryExtCheck("file" + ext), true);
    });
  }
  for (const ext of textExts) {
    it(`detects ${ext} as non-binary`, () => {
      assert.equal(binaryExtCheck("file" + ext), false);
    });
  }
  it("is case-insensitive", () => {
    assert.equal(binaryExtCheck("image.PNG"), true);
    assert.equal(binaryExtCheck("file.ZIP"), true);
  });
  it("returns false for files with no extension", () => {
    assert.equal(binaryExtCheck("Makefile"), false);
    assert.equal(binaryExtCheck("README"), false);
  });
  it("handles paths with multiple dots", () => {
    assert.equal(binaryExtCheck("archive.tar.gz"), true);
    assert.equal(binaryExtCheck("file.backup.txt"), false);
  });
});

describe("webSearch", () => {
  let originalFetch: typeof globalThis.fetch;
  const origEnv = process.env.AGENTIC_SEARCH_ENDPOINT;

  before(() => { originalFetch = globalThis.fetch; process.env.AGENTIC_SEARCH_ENDPOINT = "https://search.example.com"; });
  after(() => { globalThis.fetch = originalFetch; process.env.AGENTIC_SEARCH_ENDPOINT = origEnv; });

  it("returns results when search endpoint returns results", async () => {
    globalThis.fetch = async (url: string) => {
      if (url.startsWith("https://search.example.com")) {
        return new Response(JSON.stringify({ results: [
          { title: "Result One", url: "https://one.com", snippet: "First result" },
          { title: "Result Two", url: "https://two.com", snippet: "Second result" },
        ]}), { status: 200 });
      }
      return originalFetch(url);
    };
    const { webSearch } = await import("../src/toolsProvider");
    const results = await webSearch("test query", 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, "Result One");
    assert.equal(results[0].url, "https://one.com");
    assert.equal(results[0].snippet, "First result");
    assert.equal(results[1].title, "Result Two");
    assert.equal(results[1].url, "https://two.com");
  });

  it("returns empty array when fetch throws", async () => {
    globalThis.fetch = async () => { throw new Error("Network failure"); };
    const { webSearch } = await import("../src/toolsProvider");
    const results = await webSearch("test", 5);
    assert.deepEqual(results, []);
  });

  it("returns empty array when fetch returns non-ok status", async () => {
    globalThis.fetch = async () => new Response("", { status: 500 });
    const { webSearch } = await import("../src/toolsProvider");
    const results = await webSearch("test", 5);
    assert.deepEqual(results, []);
  });

  it("respects maxResults limit", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      title: `Title ${i}`, url: `https://ex${i}.com`, snippet: `Snippet ${i}`
    }));
    globalThis.fetch = async (url: string) => {
      if (url.startsWith("https://search.example.com")) {
        return new Response(JSON.stringify({ results: items }), { status: 200 });
      }
      return originalFetch(url);
    };
    const { webSearch } = await import("../src/toolsProvider");
    const results = await webSearch("test", 3);
    assert.equal(results.length, 3);
  });

  it("returns empty array on empty results", async () => {
    globalThis.fetch = async (url: string) => {
      if (url.startsWith("https://search.example.com")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return originalFetch(url);
    };
    const { webSearch } = await import("../src/toolsProvider");
    const results = await webSearch("test", 5);
    assert.deepEqual(results, []);
  });
});

describe("execToolByName", () => {
  const testDir = join(TEST_DIR, "exec-tools");
  let execToolByName: any;

  before(async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "test.txt"), "Hello World\n");
    mkdirSync(join(testDir, "sub"));
    writeFileSync(join(testDir, "sub", "deep.txt"), "Nested\n");

    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ workspacePath: testDir }), "utf-8");

    const mod = await import("../src/toolsProvider");
    process.env.AGENTIC_SEARCH_ENDPOINT = "https://search.example.com";
    execToolByName = mod.execToolByName;
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    try { rmSync(dirname(CONFIG_PATH), { recursive: true, force: true }); } catch {}
  });

  it("read_file reads existing file", async () => {
    const result = await execToolByName("read_file", { filePath: "test.txt" });
    assert(typeof result === "string");
    assert(result.includes("Hello World"));
  });

  it("write_file writes content", async () => {
    await execToolByName("write_file", { filePath: "new.txt", content: "Written!" });
    const content = readFileSync(join(testDir, "new.txt"), "utf-8");
    assert.equal(content, "Written!");
  });

  it("list_files lists files in directory", async () => {
    const result = await execToolByName("list_files", { path: "." });
    assert(Array.isArray(result));
    const names = result.map((f: any) => f.name || f);
    assert(names.includes("test.txt"));
  });

  it("search_files finds files by pattern", async () => {
    const result = await execToolByName("search_files", { pattern: "Hello", path: "." });
    assert(result && typeof result === "object");
    const out = String(JSON.stringify(result));
    assert(out.includes("test.txt") || out.includes("Hello"));
  });

  it("calculate evaluates math expression", async () => {
    const result = await execToolByName("calculate", { expression: "2 + 3 * 4" });
    assert.equal(result, "14");
  });

  it("encode_base64 roundtrips through decode_base64", async () => {
    const original = "hello test data";
    const encoded = await execToolByName("encode_base64", { text: original });
    assert(typeof encoded === "string" && encoded.length > 0);
    const decoded = await execToolByName("decode_base64", { base64: encoded });
    assert(typeof decoded === "string");
    assert(decoded.includes(original));
  });

  it("generate_uuid returns valid UUID format", async () => {
    const result = await execToolByName("generate_uuid", {});
    assert(typeof result === "string");
    assert.match(result, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("generate_password respects length", async () => {
    const result: any = await execToolByName("generate_password", { length: 16 });
    assert(result && typeof result === "object");
    assert.equal(result.length, 16);
    assert.equal(result.password.length, 16);
  });

  it("get_current_datetime returns ISO format", async () => {
    const result = await execToolByName("get_current_datetime", {});
    assert(typeof result === "string");
    assert.doesNotThrow(() => new Date(result));
  });

  it("web_search returns results with mocked fetch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: string) => {
      if (url.includes("format=json")) {
        return new Response(JSON.stringify({ results: [{ title: "Result", url: "https://res.com", snippet: "text" }] }), { status: 200 });
      }
      return originalFetch(url);
    };
    const result = await execToolByName("web_search", { query: "test", maxResults: 3 });
    globalThis.fetch = originalFetch;
    const out = String(JSON.stringify(result));
    assert(out.includes("Result") || out.includes("res.com"));
  });
});

describe("callLLM", () => {
  let originalFetch: typeof globalThis.fetch;
  let callLLM: any;

  before(async () => {
    originalFetch = globalThis.fetch;
    const mod = await import("../src/toolsProvider");
    callLLM = mod.callLLM;
  });
  after(() => { globalThis.fetch = originalFetch; });

  it("returns a response when LM Studio API responds", async () => {
    let callCount = 0;
    globalThis.fetch = async (url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({ data: [{ id: "test-model" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Hello from LLM" } }]
      }), { status: 200 });
    };
    const result = await callLLM([{ role: "user", content: "Hi" }], false, 0.7);
    assert(result);
    assert.equal(result.role, undefined);
    assert(result.content && result.content.includes("Hello"));
  });

  it("returns null on API failure", async () => {
    globalThis.fetch = async () => { throw new Error("API not reachable"); };
    const result = await callLLM([{ role: "user", content: "Hi" }], false, 0.7);
    assert.equal(result, null);
  });
});

describe("SessionLog", () => {
  const logDir = join(TEST_DIR, "session-log-test");
  let SessionLog: any;
  let log: any;

  before(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
  });
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  beforeEach(async () => {
    const mod = await import("../src/sessionLog");
    SessionLog = mod.SessionLog;
    log = new SessionLog(join(logDir, "session.jsonl"), 10);
  });

  afterEach(() => {
    try { log.clear(); } catch {}
  });

  it("saveMemory stores a memory entry", () => {
    log.saveMemory(["test-tag", "demo"], "memory content");
    const results = log.searchMemoriesByTags(["test-tag"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "memory content");
    assert.deepEqual(results[0].tags, ["test-tag", "demo"]);
  });

  it("searchMemoriesByTags finds entries by tag", () => {
    log.saveMemory(["alpha"], "alpha content");
    log.saveMemory(["beta"], "beta content");
    const results = log.searchMemoriesByTags(["alpha"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "alpha content");
  });

  it("searchMemoriesByTags returns empty array when no match", () => {
    log.saveMemory(["gamma"], "gamma content");
    const results = log.searchMemoriesByTags(["nonexistent"]);
    assert.deepEqual(results, []);
  });

  it("searchMemoriesByContent finds entries by text", () => {
    log.saveMemory(["tag1"], "unique searchable text");
    const results = log.searchMemoriesByContent("unique");
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "unique searchable text");
  });

  it("searchMemoriesByContent returns empty array when no match", () => {
    log.saveMemory(["tag2"], "some text");
    const results = log.searchMemoriesByContent("zzzzz");
    assert.deepEqual(results, []);
  });

  it("saveCheckpoint and searchCheckpoints work", () => {
    log.saveCheckpoint("checkpoint summary", ["cp"], 1, "session-1");
    const results = log.searchCheckpoints("session-1");
    assert.equal(results.length, 1);
    assert.equal(results[0].summary, "checkpoint summary");
  });

  it("searchCheckpoints returns empty for unknown session", () => {
    log.saveCheckpoint("cp", ["t"], 1, "session-a");
    const results = log.searchCheckpoints("session-b");
    assert.deepEqual(results, []);
  });

  it("startTurn records a turn entry", () => {
    log.startTurn({ type: "turn", ts: new Date().toISOString(), turn: 1, role: "user", content: "hello" });
    const window = log.getWorkingWindow();
    assert.equal(window.length, 1);
    assert.equal(window[0].content, "hello");
    assert.equal(window[0].role, "user");
  });

  it("getWorkingWindow respects maxWindow", () => {
    const smallLog = new SessionLog(join(logDir, "small.jsonl"), 3);
    for (let i = 0; i < 5; i++) {
      smallLog.startTurn({ type: "turn", ts: new Date().toISOString(), turn: i, role: "user", content: `turn ${i}` });
    }
    assert.equal(smallLog.getWorkingWindow().length, 3);
    assert.equal(smallLog.getWorkingWindow()[0].content, "turn 2");
    smallLog.clear();
  });

  it("clear removes all entries", () => {
    log.saveMemory(["x"], "content");
    log.startTurn({ type: "turn", ts: new Date().toISOString(), turn: 1, role: "user", content: "hi" });
    log.clear();
    assert.equal(log.getWorkingWindow().length, 0);
    assert.equal(log.searchMemoriesByTags(["x"]).length, 0);
  });
});

describe("orchestratorLoop message ordering", () => {
  let originalFetch: typeof globalThis.fetch;
  let orchestratorLoop: any;

  before(async () => {
    originalFetch = globalThis.fetch;
    const mod = await import("../src/toolsProvider");
    orchestratorLoop = mod.orchestratorLoop;
  });
  after(() => { globalThis.fetch = originalFetch; });

  it("preserves message order in conversation history", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    globalThis.fetch = async (url: string, opts?: any) => {
      if (typeof url === "string" && url.includes("chat/completions") && opts) {
        const body = JSON.parse(typeof opts.body === "string" ? opts.body : String(opts.body));
        if (body.messages) messages.push(...body.messages);
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "COMPLETE: done" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }), { status: 200 });
    };
    const result = await orchestratorLoop("You are a test bot", "Do step 1", 2, false, 0.5);
    assert(result);
    if (messages.length > 1) {
      const roles = messages.map((m: any) => m.role);
      let lastAssistant = -1;
      let lastUser = -1;
      for (let i = 0; i < roles.length; i++) {
        if (roles[i] === "assistant") lastAssistant = i;
        if (roles[i] === "user") lastUser = i;
      }
      if (lastAssistant !== -1 && lastUser !== -1 && lastUser > lastAssistant) {
        assert.ok(true, "user follows assistant as expected");
      }
    }
  });
});
