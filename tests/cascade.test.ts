import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { homedir, tmpdir } from "os";

const TEST_DIR = resolve(tmpdir(), `vibelm-cascade-test-${Date.now()}`);
const CONFIG_DIR = resolve(
  homedir(),
  ".lmstudio", "extensions", "plugins", "drunkktoys", "vibe-lm",
);

function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = {
    workspacePath: TEST_DIR,
    enabledTools: [
      "set_workspace", "get_config", "save_memory", "compact_context", "search_memory",
      "web_fetch", "web_search",
      "read_file", "list_files", "search_files", "bash_terminal",
      "calculate", "get_current_datetime", "write_file",
      "respond_to_user",
    ],
  };
  const merged = { ...base, ...overrides };
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(resolve(CONFIG_DIR, "config.json"), JSON.stringify(merged, null, 2));
}

describe("vibeLM Cascade Integration", () => {
  before(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(resolve(TEST_DIR, "src"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, "src", "main.ts"), 'console.log("hello from vibeLM");\n');
    writeFileSync(
      resolve(TEST_DIR, "src", "snippet.ts"),
      [
        "export const meaning = 42;",
        "export function double(value: number) {",
        "  return value * 2;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(resolve(TEST_DIR, "README.md"), "# vibeLM Test Project\n\nThis is a test.\n");
    makeConfig();
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    try {
      unlinkSync(resolve(CONFIG_DIR, "config.json"));
    } catch {}
  });

  it("should load tools provider and return tools", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const fakeCtl = {
      getWorkingDirectory: () => TEST_DIR,
    } as any;
    const tools = await toolsProvider(fakeCtl);
    assert.ok(Array.isArray(tools), "tools must be an array");
    assert.ok(tools.length >= 10, `expected >=10 tools, got ${tools.length}`);
  });

  it("should find the respond_to_user tool", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const rt = tools.find((t: any) => t.name === "respond_to_user");
    assert.ok(rt, "respond_to_user tool must be present");
    assert.ok(rt.implementation, "respond_to_user must have implementation");
  });


  it("should detect loops in tool calls", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const result = await preprocessMessage("calculate 2 + 2");
    assert.ok(result, "preprocessor should handle calculate prefix");
    if (result) {
      assert.ok(
        result.includes("calculate") || result.includes("Tool executed"),
        `result must mention tool execution: ${result.slice(0, 100)}`,
      );
    }
  });

  it("should return real workspace from get_config when workspace is set", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const gc = tools.find((t: any) => t.name === "get_config");
    assert.ok(gc, "get_config tool must be present");
    const result = await gc.implementation({});
    assert.ok(result?.ok, `get_config should succeed: ${JSON.stringify(result)}`);
    assert.equal(result.data.workspace, TEST_DIR);
    assert.ok(typeof result.data.sessionId === "string" && result.data.sessionId.length > 10, "sessionId must be present");
  });

  it("should create a fresh session id for each toolsProvider instance", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const first = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const second = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const firstConfig = await first.find((t: any) => t.name === "get_config").implementation({});
    const secondConfig = await second.find((t: any) => t.name === "get_config").implementation({});
    assert.ok(firstConfig?.ok && secondConfig?.ok, "get_config should succeed in both sessions");
    assert.notEqual(firstConfig.data.sessionId, secondConfig.data.sessionId, "session ids should be unique per provider instance");
  });

  it("should reject read outside workspace", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const rf = tools.find((t: any) => t.name === "read_file");
    assert.ok(rf, "read_file tool must be present");
    const result = await rf.implementation({ filePath: "/etc/passwd", maxChars: 1000 });
    assert.ok(!result?.ok, "should reject paths outside workspace");
  });

  it("should fail clearly when the configured workspace path is invalid", async () => {
    const invalidWorkspace = resolve(TEST_DIR, "missing-workspace");
    makeConfig({ workspacePath: invalidWorkspace });
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const gc = tools.find((t: any) => t.name === "get_config");
    assert.ok(gc, "get_config tool must be present");
    const result = await gc.implementation({});
    assert.ok(!result?.ok, "get_config should fail with invalid workspace");
    assert.match(String(result.error), /workspace path/i);
    makeConfig();
  });

  it("should reject oversized multi-step prompts before passing them through", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const hugeSteps = Array.from({ length: 3000 }, (_, i) => `${i + 1}. step ${i}`).join("\n");
    const processed = await preprocessMessage(hugeSteps);
    assert.ok(processed, "preprocessMessage should return a response");
    assert.match(processed!, /too large for the current model context/i);
  });

  it("should compact recent turns, preserve code verbatim, and store reloadable memory", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);

    const getConfig = tools.find((t: any) => t.name === "get_config");
    const readFile = tools.find((t: any) => t.name === "read_file");
    const saveMemory = tools.find((t: any) => t.name === "save_memory");
    const compactContext = tools.find((t: any) => t.name === "compact_context");
    const searchMemory = tools.find((t: any) => t.name === "search_memory");

    assert.ok(getConfig && readFile && saveMemory && compactContext && searchMemory, "required tools must be present");

    const configResult = await getConfig.implementation({});
    assert.ok(configResult?.ok, "get_config should succeed");
    const sessionId = configResult.data.sessionId as string;

    const fileContent = readFileSync(resolve(TEST_DIR, "src", "snippet.ts"), "utf-8");
    const readResult = await readFile.implementation({ filePath: "src/snippet.ts", maxChars: 2000, offset: 0 });
    assert.ok(readResult?.ok, `read_file should succeed: ${JSON.stringify(readResult)}`);
    assert.equal(readResult.data.content, fileContent, "read_file must return the exact code content");

    const memoryResult = await saveMemory.implementation({
      content: "Current goal is to compact context without paraphrasing code.",
      tags: ["goal", `session:${sessionId}`],
    });
    assert.ok(memoryResult?.ok, "save_memory should succeed");

    const compactResult = await compactContext.implementation({
      maxTokens: 600,
      includeCode: true,
      saveToMemory: true,
      force: true,
      goalHint: "Compact the session without rewriting code.",
    });
    assert.ok(compactResult?.ok, `compact_context should succeed: ${JSON.stringify(compactResult)}`);
    assert.match(compactResult.data.goal, /compact the session/i);
    assert.ok(
      compactResult.data.codeSnippets.some((snippet: any) => snippet.path === "src/snippet.ts" && snippet.referenceOnly === true),
      "compact_context must keep a reference to local source instead of replaying it",
    );
    assert.ok(
      compactResult.data.codeSnippets.every((snippet: any) => !snippet.content),
      "compact_context must omit raw code content when a local source reference is enough",
    );

    const reloadResult = await searchMemory.implementation({
      tags: ["compact_context", sessionId],
      maxResults: 10,
    });
    assert.ok(reloadResult?.ok, "search_memory should succeed");
    assert.ok(reloadResult.data.results.length >= 1, "compact memory must be reloadable");
    assert.ok(
      reloadResult.data.results.some((entry: any) => String(entry.content).includes("[omitted; local source should be re-read on demand]")),
      "stored compact memory must point back to local source instead of storing raw code",
    );

    const secondResult = await compactContext.implementation({
      maxTokens: 600,
      includeCode: true,
      saveToMemory: false,
      force: true,
      goalHint: "Compact the session without rewriting code.",
    });
    assert.ok(secondResult?.ok, "repeat compaction should succeed");
    assert.deepEqual(
      secondResult.data.codeSnippets.map((snippet: any) => ({ path: snippet.path, referenceOnly: snippet.referenceOnly })),
      compactResult.data.codeSnippets.map((snippet: any) => ({ path: snippet.path, referenceOnly: snippet.referenceOnly })),
      "repeat compaction should stay stable for preserved source references",
    );
  });

  it("should auto-compact a long read-heavy session before the context grows too large", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);

    const getConfig = tools.find((t: any) => t.name === "get_config");
    const readFile = tools.find((t: any) => t.name === "read_file");
    const searchMemory = tools.find((t: any) => t.name === "search_memory");

    assert.ok(getConfig && readFile && searchMemory, "required tools must be present");

    const largeFile = resolve(TEST_DIR, "src", "large.txt");
    writeFileSync(largeFile, Array.from({ length: 800 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n"));

    const configResult = await getConfig.implementation({});
    assert.ok(configResult?.ok, "get_config should succeed");
    const sessionId = configResult.data.sessionId as string;

    const listFiles = tools.find((t: any) => t.name === "list_files");
    assert.ok(listFiles, "list_files tool must be present");

    const sequence = [
      { tool: readFile, args: { filePath: "src/large.txt", maxChars: 4000, offset: 0 } },
      { tool: listFiles, args: { path: "src" } },
      { tool: readFile, args: { filePath: "src/large.txt", maxChars: 4000, offset: 0 } },
      { tool: listFiles, args: { path: "src" } },
      { tool: readFile, args: { filePath: "src/large.txt", maxChars: 4000, offset: 0 } },
      { tool: listFiles, args: { path: "src" } },
      { tool: readFile, args: { filePath: "src/large.txt", maxChars: 4000, offset: 0 } },
      { tool: listFiles, args: { path: "src" } },
      { tool: readFile, args: { filePath: "src/large.txt", maxChars: 4000, offset: 0 } },
      { tool: listFiles, args: { path: "src" } },
      { tool: readFile, args: { filePath: "src/large.txt", maxChars: 4000, offset: 0 } },
    ];

    for (const [index, step] of sequence.entries()) {
      const result = await step.tool.implementation(step.args);
      assert.ok(result?.ok, `tool should succeed on iteration ${index + 1}`);
    }

    const autoResult = await searchMemory.implementation({
      tags: ["compact_context", sessionId],
      maxResults: 10,
    });
    assert.ok(autoResult?.ok, "search_memory should succeed");
    assert.ok(
      autoResult.data.results.length >= 1,
      "long read-heavy sessions should auto-save a compact_context memory entry",
    );
  });
});

describe("SessionLog", () => {
  it("should be importable", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    assert.ok(typeof SessionLog === "function", "SessionLog must be a class");
  });

  it("should log and retrieve turns", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    const log = new SessionLog(resolve(TEST_DIR, "test-session-log.jsonl"));
    log.startTurn({
      type: "turn",
      sessionId: "test-1",
      ts: new Date().toISOString(),
      turn: 1,
      role: "user",
      content: "hello",
    });
    log.startTurn({
      type: "turn",
      sessionId: "test-1",
      ts: new Date().toISOString(),
      turn: 2,
      role: "tool",
      content: "respond_to_user",
      toolCalls: [{ name: "respond_to_user", args: "{}", result: "done" }],
    });
    log.saveCheckpoint("test checkpoint saved", ["cascade:test"], 2, "test-1");
    const total = log.totalTurnsLogged();
    assert.ok(total > 0, "should have logged some turns");
    const checkpoints = log.searchCheckpoints("test-1", 10);
    assert.ok(checkpoints.length === 1, `should find checkpoint: got ${checkpoints.length}`);
    assert.ok(checkpoints[0].summary.includes("checkpoint"), "checkpoint summary should contain 'checkpoint'");
    log.clear();
  });
});
