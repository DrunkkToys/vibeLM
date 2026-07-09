import { describe, it, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { join, resolve, relative, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "fs";

const TEST_DIR = join(tmpdir(), "vibe-lm-test-" + Date.now());
const DATA_DIR = join(tmpdir(), "vibe-lm-test-data-" + Date.now());
process.env.VIBE_LM_DATA_DIR = DATA_DIR;
const RUNTIME_STATE_PATH = resolve(DATA_DIR, "runtime-state.json");

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

describe("pickBestModel and VLM_PATTERNS", () => {
  it("treats glm vision variants as multimodal models", async () => {
    const { VLM_PATTERNS, pickBestModel } = await import("../src/toolsProvider");
    assert.equal(VLM_PATTERNS.test("zai-org/glm-4.6v-flash"), true);
    assert.equal(VLM_PATTERNS.test("qwen/qwen3-4b"), false);

    const chosen = pickBestModel(
      [{ id: "zai-org/glm-4.6v-flash" }, { id: "qwen/qwen3-4b" }],
      undefined,
    );
    assert.equal(chosen, "qwen/qwen3-4b");
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

;


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
    log.saveMemory(["test-tag", "demo"], "memory content", undefined, "session-1", "/workspace-a", "research");
    const results = log.searchMemoriesByTags(["test-tag"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].content, "memory content");
    assert.deepEqual(results[0].tags, ["test-tag", "demo"]);
    assert.equal(results[0].sessionId, "session-1");
    assert.equal(results[0].workspace, "/workspace-a");
    assert.equal(results[0].scope, "research");
  });

  it("countMemories respects scope filters", () => {
    log.saveMemory(["scope-a"], "workspace memory", undefined, "session-a", "/workspace-a", "workspace");
    log.saveMemory(["scope-b"], "session memory", undefined, "session-b", "/workspace-a", "session");
    log.saveMemory(["scope-c"], "research memory", undefined, "session-c", "/workspace-b", "research");

    assert.equal(log.countMemories({ workspace: "/workspace-a", scope: "workspace" }), 1);
    assert.equal(log.countMemories({ workspace: "/workspace-a", sessionId: "session-b", scope: "session" }), 1);
    assert.equal(log.countMemories({ scope: "research" }), 1);
    assert.equal(log.countMemories({ scope: "all" }), 3);
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
    log.saveMemory(["tag1"], "unique searchable text", undefined, "session-1", "/workspace-a", "workspace");
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

  it("searchMemoriesByTags respects workspace, session, and research scope filters", () => {
    log.saveMemory(["scope-a"], "workspace memory", undefined, "session-a", "/workspace-a", "workspace");
    log.saveMemory(["scope-b"], "session memory", undefined, "session-b", "/workspace-a", "session");
    log.saveMemory(["scope-c"], "research memory", undefined, "session-c", "/workspace-b", "research");

    const workspaceResults = log.searchMemoriesByTags(["scope-a"], 10, { workspace: "/workspace-a", scope: "workspace" });
    const sessionResults = log.searchMemoriesByTags(["scope-b"], 10, { workspace: "/workspace-a", sessionId: "session-b", scope: "session" });
    const researchResults = log.searchMemoriesByTags(["scope-c"], 10, { scope: "research" });

    assert.equal(workspaceResults.length, 1);
    assert.equal(sessionResults.length, 1);
    assert.equal(researchResults.length, 1);
  });
});

describe("session resume helper", () => {
  before(() => {
    try { unlinkSync(RUNTIME_STATE_PATH); } catch {}
  });

  after(() => {
    try { unlinkSync(RUNTIME_STATE_PATH); } catch {}
  });

  it("deduplicates overlapping history fragments before restart replay", async () => {
    const { composeHistoryText } = await import("../src/toolsProvider");

    const sharedHistory = [
      "system: starter context",
      "user: first turn",
      "assistant: first response",
    ].join("\n");

    assert.equal(
      composeHistoryText(sharedHistory, sharedHistory),
      sharedHistory,
      "identical history fragments should not be doubled",
    );

    assert.equal(
      composeHistoryText(sharedHistory, `${sharedHistory}\nuser: second turn`),
      `${sharedHistory}\nuser: second turn`,
      "embedded history fragments should keep the longer replay once",
    );
  });

  it("boots fresh for missing, invalid, and stale runtime state while reusing matching history", async () => {
    const { resolveSessionStateFromHistory, fingerprintManagedContextHistory } = await import("../src/toolsProvider");
    const historyText = [
      "system: starter context",
      "user: first turn",
      "assistant: first response",
    ].join("\n");
    const fingerprint = fingerprintManagedContextHistory(historyText);
    const ctl = {
      pullHistory: async () => ({
        getSystemPrompt: () => historyText,
        toString: () => historyText,
      }),
    } as any;

    try { unlinkSync(RUNTIME_STATE_PATH); } catch {}
    const fresh = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(fresh.resumedFromPersistedState, false, "missing state should boot fresh");
    assert.equal(fresh.turnCounter, 0, "fresh state should reset turn count");
    assert.equal(fresh.historyFingerprint, fingerprint, "fresh state should store the live history fingerprint");

    writeFileSync(RUNTIME_STATE_PATH, "{not valid json", "utf-8");
    const invalid = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(invalid.resumedFromPersistedState, false, "invalid state should fall back to fresh");
    assert.notEqual(invalid.sessionId, fresh.sessionId, "invalid state should not be reused");

    writeFileSync(
      RUNTIME_STATE_PATH,
      JSON.stringify({
        version: 1,
        sessionId: "session-stale",
        turnCounter: 9,
        lastCompactionTurn: 4,
        historyFingerprint: "fingerprint-from-old-history",
        resumedFromPersistedState: true,
        updatedAt: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );
    const stale = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(stale.resumedFromPersistedState, false, "stale fingerprint should not be reused");
    assert.notEqual(stale.sessionId, "session-stale", "stale state should be ignored");

    writeFileSync(
      RUNTIME_STATE_PATH,
      JSON.stringify({
        version: 1,
        sessionId: "session-live",
        turnCounter: 12,
        lastCompactionTurn: 8,
        historyFingerprint: fingerprint,
        resumedFromPersistedState: true,
        updatedAt: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );
    const resumed = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(resumed.resumedFromPersistedState, true, "matching fingerprint should resume state");
    assert.equal(resumed.sessionId, "session-live", "matching fingerprint should reuse the stored session id");
    assert.equal(resumed.turnCounter, 12, "matching fingerprint should preserve the stored turn counter");
  });
});

describe("workspace memory helper", () => {
  const logDir = join(TEST_DIR, "workspace-memory-test");

  before(() => {
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
  });

  after(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("returns the latest workspace memory without scanning content", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    const { getLatestWorkspaceMemory } = await import("../src/toolsProvider");
    const log = new SessionLog(join(logDir, "workspace.jsonl"));

    log.saveMemory(["workspace"], "older workspace memory", undefined, "session-1", "/workspace-a", "workspace");
    log.saveMemory(["workspace"], "newer workspace memory", undefined, "session-2", "/workspace-b", "workspace");

    assert.equal(getLatestWorkspaceMemory(log), "/workspace-b");
  });
});
