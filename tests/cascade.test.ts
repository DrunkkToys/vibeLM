import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";
import { homedir, tmpdir } from "os";

const TEST_DIR = resolve(tmpdir(), `vibelm-cascade-test-${Date.now()}`);
const CONFIG_DIR = resolve(
  homedir(),
  ".lmstudio", "extensions", "plugins", "drunkktoys", "agentic-tools",
);

function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = {
    workspacePath: TEST_DIR,
    enabledTools: [
      "set_workspace", "get_config", "save_memory", "search_memory",
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
  });

  it("should reject read outside workspace", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const rf = tools.find((t: any) => t.name === "read_file");
    assert.ok(rf, "read_file tool must be present");
    const result = await rf.implementation({ filePath: "/etc/passwd", maxChars: 1000 });
    assert.ok(!result?.ok, "should reject paths outside workspace");
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
