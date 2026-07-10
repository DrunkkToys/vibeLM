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

  it("effectiveContextWindow caps the reported window against the sustainable ceiling", async () => {
    const { effectiveContextWindow } = await import("../src/toolsProvider");
    // cap disabled → trust the reported window
    assert.equal(effectiveContextWindow(262144, 0), 262144);
    // cap below reported → clamp to cap (the real crash-avoidance case)
    assert.equal(effectiveContextWindow(262144, 32768), 32768);
    // cap above reported → reported wins (never inflate a small model's window)
    assert.equal(effectiveContextWindow(8192, 32768), 8192);
  });

  it("parseLoadedModelInfo reads the loaded context length, not the model's max ceiling", async () => {
    const { parseLoadedModelInfo } = await import("../src/toolsProvider");
    // Mirrors the live payload: the loaded model's real window (40640) is far below its max (262144).
    const info = parseLoadedModelInfo({
      data: [
        { id: "other", state: "not-loaded", arch: "llama", loaded_context_length: 999999 },
        { id: "qwen/qwen3.5-9b", state: "loaded", arch: "qwen3_5", loaded_context_length: 40640 },
      ],
    } as any);
    assert.equal(info.loadedContextLength, 40640, "must use loaded_context_length of the loaded model, not max");
    assert.equal(info.arch, "qwen3_5");
    // Missing loaded_context_length → null (falls back to SDK/default resolution downstream).
    assert.equal(parseLoadedModelInfo({ data: [{ id: "m", state: "loaded", arch: "gemma4" }] } as any).loadedContextLength, null);
  });

  it("budget/compaction thresholds computed from the real loaded window fire before overflow", async () => {
    const { parseLoadedModelInfo } = await import("../src/toolsProvider");
    const window = parseLoadedModelInfo({ data: [{ state: "loaded", arch: "qwen3_5", loaded_context_length: 40640 }] } as any).loadedContextLength!;
    // hardPromptBudgetLimit = window * 0.50; shouldAutoCompactSession trips at window * 0.30.
    const budgetLimit = Math.floor(window * 0.5);
    const autoCompactTrigger = Math.floor(window * 0.3);
    assert.equal(budgetLimit, 20320, "budget warning should trip at ~20K (half the real 40K window)");
    assert.ok(autoCompactTrigger < window, `auto-compaction (${autoCompactTrigger}) must trip below the real window (${window})`);
    assert.ok(autoCompactTrigger <= 12192, `auto-compaction trigger should be ~12K: got ${autoCompactTrigger}`);
  });

  it("resolveCompactionTriggerRatio reads the configured percent, clamps it, and defaults to 30%", async () => {
    const { resolveCompactionTriggerRatio } = await import("../src/toolsProvider");
    const ctlWith = (percent: unknown) => ({
      getPluginConfig: () => ({ get: (k: string) => (k === "tools.compactionTriggerPercent" || k === "compactionTriggerPercent" ? percent : undefined) }),
    } as any);
    assert.equal(resolveCompactionTriggerRatio(ctlWith(50)), 0.5, "50% → 0.5");
    assert.equal(resolveCompactionTriggerRatio(ctlWith(95)), 0.9, "clamps above 90%");
    assert.equal(resolveCompactionTriggerRatio(ctlWith(1)), 0.1, "clamps below 10%");
    assert.equal(resolveCompactionTriggerRatio({} as any), 0.3, "no config → default 30%");
    // At a real 40640 window, a higher trigger keeps more live context before compacting.
    assert.equal(Math.floor(40640 * resolveCompactionTriggerRatio(ctlWith(60))), 24384);
  });

  it("effectiveContextWindow still clamps further when the optional cap is set", async () => {
    const { effectiveContextWindow } = await import("../src/toolsProvider");
    // With cap disabled (default 0) the loaded window passes through untouched.
    assert.equal(effectiveContextWindow(40640, 0), 40640);
    // A user-set cap lowers the budget further for machines that can't sustain the loaded length.
    assert.equal(effectiveContextWindow(40640, 16384), 16384);
  });

  it("reasoningDirectiveFor maps effort + arch to each family's native thinking control", async () => {
    const { reasoningDirectiveFor } = await import("../src/toolsProvider");
    // gpt-oss: native Harmony tiers, deterministic; off/low both hit its floor
    assert.equal(reasoningDirectiveFor("off", "gpt-oss"), "Reasoning: low");
    assert.equal(reasoningDirectiveFor("low", "gpt_oss"), "Reasoning: low");
    assert.equal(reasoningDirectiveFor("medium", "gptoss"), "Reasoning: medium");
    assert.equal(reasoningDirectiveFor("high", "gpt-oss"), "Reasoning: high");
    // Qwen soft switches: off suppresses, any active tier enables thinking
    assert.equal(reasoningDirectiveFor("off", "qwen3"), "/no_think");
    assert.equal(reasoningDirectiveFor("low", "qwen35"), "/think");
    assert.equal(reasoningDirectiveFor("medium", "qwen3_5"), "/think");
    assert.equal(reasoningDirectiveFor("high", "qwen3"), "/think");
    // Models without an explicit control: natural-language nudge for off/low, no-op for medium/high
    assert.match(reasoningDirectiveFor("off", "gemma4"), /do not produce extended/i);
    assert.match(reasoningDirectiveFor("low", "glm4v"), /brief/i);
    assert.equal(reasoningDirectiveFor("medium", "gemma4"), "");
    assert.equal(reasoningDirectiveFor("high", "llama"), "");
  });
});
