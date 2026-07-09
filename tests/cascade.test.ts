import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = resolve(tmpdir(), `vibelm-cascade-test-${Date.now()}`);
const CONFIG_DIR = resolve(tmpdir(), `vibelm-cascade-data-${Date.now()}`);
process.env.VIBE_LM_DATA_DIR = CONFIG_DIR;

function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = { workspacePath: TEST_DIR };
  const merged = { ...base, ...overrides };
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(resolve(CONFIG_DIR, "config.json"), JSON.stringify(merged, null, 2));
}

function makeCtl(options: { maxOrchestratorTurns?: number; rollingWindowTriggerTokens?: number; toolToggles?: Record<string, boolean> } = {}) {
  const base = { getWorkingDirectory: () => TEST_DIR };
  if (typeof options.maxOrchestratorTurns !== "number" && typeof options.rollingWindowTriggerTokens !== "number" && !options.toolToggles) {
    return base as any;
  }
  return {
    ...base,
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "tools.maxOrchestratorTurns" || key === "maxOrchestratorTurns") return options.maxOrchestratorTurns;
        if (key === "tools.rollingWindowTriggerTokens" || key === "rollingWindowTriggerTokens" || key === "contextOverflowHeadroomTokens") return options.rollingWindowTriggerTokens;
        if (key.startsWith("tools.") || options.toolToggles) {
          const toolKey = key.startsWith("tools.") ? key.slice("tools.".length) : key;
          if (options.toolToggles && toolKey in options.toolToggles) return options.toolToggles[toolKey];
        }
        return undefined;
      },
    }),
  } as any;
}

describe("vibeLM Cascade Integration", () => {
  before(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(resolve(TEST_DIR, "src"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, "src", "main.ts"), 'console.log("hello from vibeLM");\n');
    makeConfig();
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true });
  });

  it("should load tools provider and return tools", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    assert.ok(Array.isArray(tools), "tools must be an array");
    assert.ok(tools.length >= 1, "expected at least 1 tool");
  });

  it("should expose the amend tool (renamed from respond_to_user)", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const amend = tools.find((t: any) => t.name === "amend");
    assert.ok(amend, "amend tool must be present");
    assert.ok(amend.implementation, "amend must have implementation");
  });

  it("should expose tools that are defaultEnabled or toggled on", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const toolNames = tools.map((t: any) => t.name);
    const mustBeExposed = [
      "set_workspace", "explore_workspace", "get_config",
      "save_memory", "compact_context", "search_memory",
      "web_fetch", "calculate", "get_current_datetime",
      "list_files", "read_file", "write_file",
      "search_files", "bash_terminal", "web_search",
      "amend",
    ];
    for (const name of mustBeExposed) {
      assert.ok(toolNames.includes(name), `${name} must be exposed`);
    }
  });

  it("should not expose respond_to_user (renamed to amend)", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const toolNames = tools.map((t: any) => t.name);
    assert.ok(!toolNames.includes("respond_to_user"), "respond_to_user should not exist");
  });

  it("should force amend on even when config disables it", async () => {
    makeConfig({ toolToggles: { amend: false } });
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const amend = tools.find((t: any) => t.name === "amend");
    assert.ok(amend, "amend must stay enabled as a mandatory finalizer");
    makeConfig();
  });

  it("should allow amend to pass with a real answer", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const amend = tools.find((t: any) => t.name === "amend");
    assert.ok(amend, "amend tool must be present");
    const result = await amend.implementation({ text: "Here is the completed result." });
    assert.ok(result?.ok, "amend should accept a concrete final response");
    assert.equal(result.data.text, "Here is the completed result.");
  });

  it("should reject passive handoffs via amend before turn cap", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 50 }));
    const amend = tools.find((t: any) => t.name === "amend");
    assert.ok(amend, "amend tool must be present");
    const result = await amend.implementation({ text: "Let me know if you want more." });
    assert.ok(!result?.ok, "passive handoff should be rejected before the cap");
    assert.match(String(result.error), /passive handoff/i);
  });

  it("should allow amend when at turn cap even for passive text", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 2 }));
    const amend = tools.find((t: any) => t.name === "amend");
    assert.ok(amend, "amend tool must be present");
    await amend.implementation({ text: "First turn" });
    const result = await amend.implementation({ text: "Let me know if you want more." });
    assert.ok(result?.ok, "amend should allow passive text at turn cap");
  });

  it("should honor per-tool on/off toggles from plugin config", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({
      toolToggles: {
        generate_uuid: false,
        generate_password: false,
      },
    }));
    const toolNames = tools.map((tool: any) => tool.name);
    assert.ok(!toolNames.includes("generate_uuid"), "disabled generate_uuid should not be exposed");
    assert.ok(!toolNames.includes("generate_password"), "disabled generate_password should not be exposed");
    assert.ok(toolNames.includes("amend"), "amend must remain exposed");
  });

  it("should export configSchematics", () => {
    const { configSchematics } = require("../src/config");
    assert.ok(configSchematics, "configSchematics must be exported");
  });

  it("should export session related functions", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    assert.ok(typeof SessionLog === "function", "SessionLog must be a class");
  });

  it("SessionLog should log and retrieve checkpoints", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    const logPath = resolve(TEST_DIR, "test-session-log.jsonl");
    const log = new SessionLog(logPath);
    log.startTurn({ type: "turn", sessionId: "test-1", ts: new Date().toISOString(), turn: 1, role: "user", content: "hello" });
    log.saveCheckpoint("test checkpoint", ["cascade:test"], 1, "test-1");
    const checkpoints = log.searchCheckpoints("test-1", 10);
    assert.ok(checkpoints.length === 1, `should find checkpoint: got ${checkpoints.length}`);
    log.clear();
  });
});
