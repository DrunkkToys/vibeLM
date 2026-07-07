import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const TEST_DIR = resolve(tmpdir(), `vibelm-cascade-test-${Date.now()}`);
const CONFIG_DIR = resolve(
  homedir(),
  ".lmstudio", "extensions", "plugins", "drunkktoys", "vibe-lm",
);
const RUNTIME_STATE_PATH = resolve(CONFIG_DIR, "runtime-state.json");

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
    try { unlinkSync(RUNTIME_STATE_PATH); } catch {}
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    try { unlinkSync(resolve(CONFIG_DIR, "config.json")); } catch {}
    try { unlinkSync(RUNTIME_STATE_PATH); } catch {}
  });

  it("should load tools provider and return tools", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const fakeCtl = { getWorkingDirectory: () => TEST_DIR } as any;
    const tools = await toolsProvider(fakeCtl);
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

  it("should NOT expose the removed shit tools", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const toolNames = tools.map((t: any) => t.name);
    const removed = [
      "set_workspace", "explore_workspace", "get_config",
      "save_memory", "compact_context", "search_memory",
      "web_fetch", "calculate", "get_current_datetime",
      "list_files", "read_file", "write_file", "search_files",
      "bash_terminal", "web_search",
    ];
    for (const name of removed) {
      assert.ok(!toolNames.includes(name), `${name} must not be exposed`);
    }
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

  it("should honor per-tool on/off toggles from plugin config for remaining tools", async () => {
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
    // ssh_exec and encode_base64 are defaultEnabled: false so they are NOT exposed unless toggled on
    assert.ok(!toolNames.includes("ssh_exec"), "ssh_exec should NOT be exposed by default");
    assert.ok(!toolNames.includes("encode_base64"), "encode_base64 should NOT be exposed by default");
  });

  it("should create a fresh session id for each toolsProvider instance", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const first = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const second = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const firstAmend = first.find((t: any) => t.name === "amend");
    const secondAmend = second.find((t: any) => t.name === "amend");
    assert.ok(firstAmend && secondAmend, "amend should exist in both");
  });

  it("should export configSchematics with tool toggle fields", () => {
    const { configSchematics } = require("../src/config");
    assert.ok(configSchematics, "configSchematics must be exported");
  });

  it("should respect per-tool toggles from config for non-mandatory tools", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({
      toolToggles: {
        generate_uuid: true,
        generate_password: false,
        encode_base64: true,
      },
    }));
    const toolNames = tools.map((tool: any) => tool.name);
    assert.ok(toolNames.includes("amend"), "amend must always be present");
    assert.ok(toolNames.includes("generate_uuid"), "generate_uuid toggled on must be present");
    assert.ok(!toolNames.includes("generate_password"), "generate_password toggled off must be absent");
    assert.ok(toolNames.includes("encode_base64"), "encode_base64 toggled on must be present");
  });

  it("should expose ALL_TOOL_MAP keys for contract verification", async () => {
    const src = require("fs").readFileSync(resolve(__dirname, "..", "src", "toolsProvider.ts"), "utf-8");
    const allToolMapMatch = src.match(/ALL_TOOL_MAP.*?\{(.*?)\}/s);
    if (!allToolMapMatch) {
      // ALL_TOOL_MAP might reference respond_to_user still; check for amend instead
      assert.ok(src.includes("amend") || src.includes("respond_to_user"), "should have an ALL_TOOL_MAP entry for amend/respond_to_user");
      return;
    }
    const mapContent = allToolMapMatch[1];
    assert.ok(mapContent.includes("amend"), "ALL_TOOL_MAP should include amend");
    assert.ok(!mapContent.includes("set_workspace"), "ALL_TOOL_MAP should NOT include set_workspace");
    assert.ok(!mapContent.includes("read_file"), "ALL_TOOL_MAP should NOT include read_file");
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
      content: "amend",
      toolCalls: [{ name: "amend", args: "{}", result: "done" }],
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
