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
const RUNTIME_STATE_PATH = resolve(CONFIG_DIR, "runtime-state.json");
const SESSION_LOG_PATH = resolve(CONFIG_DIR, "session-log.jsonl");

function makeConfig(overrides: Record<string, unknown> = {}) {
  const base = {
    workspacePath: TEST_DIR,
  };
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

function makePromptCtl(options: {
  historyText: string;
  models?: Array<{ identifier: string; modelKey?: string; path?: string; contextLength: number }>;
  failLoadedModels?: boolean;
}): any {
  const models = options.models ?? [];
  return {
    getWorkingDirectory: () => TEST_DIR,
    pullHistory: async () => ({
      getSystemPrompt: () => options.historyText,
      toString: () => options.historyText,
    }),
    client: {
      llm: {
        listLoaded: async () => {
          if (options.failLoadedModels) {
            throw new Error("temporary model lookup failure");
          }
          return models.map((model) => ({
            identifier: model.identifier,
            modelKey: model.modelKey ?? model.identifier,
            path: model.path ?? model.identifier,
            contextLength: model.contextLength,
            getModelInfo: async () => ({ contextLength: model.contextLength }),
          }));
        },
      },
    },
  } as any;
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
    try { unlinkSync(RUNTIME_STATE_PATH); } catch {}
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    try {
      unlinkSync(resolve(CONFIG_DIR, "config.json"));
    } catch {}
    try {
      unlinkSync(RUNTIME_STATE_PATH);
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

  it("should force respond_to_user on even when config disables it", async () => {
    makeConfig({
      toolToggles: {
        read_file: false,
        write_file: false,
        bash_terminal: false,
      },
    });
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const rt = tools.find((t: any) => t.name === "respond_to_user");
    assert.ok(rt, "respond_to_user must stay enabled as a mandatory finalizer");
    makeConfig();
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

  it("should allow distinct repeated read_file calls without tripping the loop guard", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    writeFileSync(resolve(TEST_DIR, "src", "alpha.txt"), "alpha\n");
    writeFileSync(resolve(TEST_DIR, "src", "beta.txt"), "beta\n");
    writeFileSync(resolve(TEST_DIR, "src", "gamma.txt"), "gamma\n");
    writeFileSync(resolve(TEST_DIR, "src", "delta.txt"), "delta\n");
    writeFileSync(resolve(TEST_DIR, "src", "epsilon.txt"), "epsilon\n");

    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const readFile = tools.find((t: any) => t.name === "read_file");
    assert.ok(readFile, "read_file tool must be present");

    const paths = ["src/alpha.txt", "src/beta.txt", "src/gamma.txt", "src/delta.txt", "src/epsilon.txt"];
    for (const [index, filePath] of paths.entries()) {
      const result = await readFile.implementation({ filePath, maxChars: 200, offset: 0 });
      assert.ok(result?.ok, `distinct read_file call ${index + 1} should succeed: ${JSON.stringify(result)}`);
    }
  });

  it("should return real workspace from get_config when workspace is set", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const gc = tools.find((t: any) => t.name === "get_config");
    assert.ok(gc, "get_config tool must be present");
    const result = await gc.implementation({});
    assert.ok(result?.ok, `get_config should succeed: ${JSON.stringify(result)}`);
    assert.equal(result.data.workspace, TEST_DIR);
    assert.ok(typeof result.data.sessionId === "string" && result.data.sessionId.length > 10, "sessionId must be present");
    assert.equal(result.data.maxOrchestratorTurns, 50, "default max turns should be 50");
    assert.equal(result.data.rollingWindowTriggerTokensConfigured, 0, "default rolling-window trigger should auto-derive from the model");
    assert.equal(result.data.rollingWindowTriggerTokens, result.data.promptBudget.hardLimitTokens, "auto rolling-window trigger should match the model-derived hard limit");
  });

  it("should strip legacy enabledTools from the persisted config", async () => {
    writeFileSync(
      resolve(CONFIG_DIR, "config.json"),
      JSON.stringify({
        workspacePath: TEST_DIR,
        preferredModel: "qwen/qwen3-4b",
        enabledTools: ["read_file", "write_file"],
      }, null, 2),
    );

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const gc = tools.find((t: any) => t.name === "get_config");
    assert.ok(gc, "get_config tool must be present");

    const result = await gc.implementation({});
    assert.ok(result?.ok, `get_config should succeed: ${JSON.stringify(result)}`);

    const normalized = JSON.parse(readFileSync(resolve(CONFIG_DIR, "config.json"), "utf-8"));
    assert.ok(!Object.prototype.hasOwnProperty.call(normalized, "enabledTools"), "legacy enabledTools should be removed from config.json");
    assert.ok(Object.prototype.hasOwnProperty.call(normalized, "preferredModel"), "other config fields must remain intact");
  });

  it("should allow maxOrchestratorTurns to be set to 0 and keep the cap disabled", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 0 }));
    const gc = tools.find((t: any) => t.name === "get_config");
    assert.ok(gc, "get_config tool must be present");

    const first = await gc.implementation({});
    assert.ok(first?.ok, `first call should succeed: ${JSON.stringify(first)}`);
    assert.equal(first.data.maxOrchestratorTurns, 0, "configured max turns should allow 0");

    const second = await gc.implementation({});
    assert.ok(second?.ok, `second call should also succeed when the cap is disabled: ${JSON.stringify(second)}`);
  });

  it("should honor the configured maxOrchestratorTurns limit", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 1, rollingWindowTriggerTokens: 512 }));
    const gc = tools.find((t: any) => t.name === "get_config");
    const respondToUser = tools.find((t: any) => t.name === "respond_to_user");
    assert.ok(gc, "get_config tool must be present");
    assert.ok(respondToUser, "respond_to_user tool must be present");

    const first = await gc.implementation({});
    assert.ok(first?.ok, `first call should succeed: ${JSON.stringify(first)}`);
    assert.equal(first.data.maxOrchestratorTurns, 1, "configured max turns should be reported");
    assert.equal(first.data.rollingWindowTriggerTokensConfigured, 512, "configured rolling-window trigger should be reported");
    assert.equal(first.data.rollingWindowTriggerTokens, 512, "effective rolling-window trigger should be reported");

    const second = await gc.implementation({});
    assert.ok(!second?.ok, "second call should fail when the configured cap is 1");
    assert.match(String(second.error), /Max turns \(1\) exceeded/i);

    const finalResponse = await respondToUser.implementation({ text: "Let me know if you want more." });
    assert.ok(finalResponse?.ok, `respond_to_user should remain available after the cap: ${JSON.stringify(finalResponse)}`);
  });

  it("should accept large rolling-window thresholds up to 16384 tokens", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ rollingWindowTriggerTokens: 16384 }));
    const gc = tools.find((t: any) => t.name === "get_config");
    assert.ok(gc, "get_config tool must be present");

    const result = await gc.implementation({});
    assert.ok(result?.ok, `get_config should succeed: ${JSON.stringify(result)}`);
    assert.equal(result.data.rollingWindowTriggerTokensConfigured, 16384, "configured rolling-window trigger should allow the new ceiling");
    assert.ok(
      result.data.rollingWindowTriggerTokens <= result.data.promptBudget.hardLimitTokens,
      "effective rolling-window trigger must still respect the model-derived hard limit",
    );
  });

  it("should honor per-tool on/off toggles from plugin config", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({
      toolToggles: {
        read_file: false,
        write_file: false,
        bash_terminal: false,
      },
    }));

    const toolNames = tools.map((tool: any) => tool.name);
    assert.ok(!toolNames.includes("read_file"), "disabled read_file should not be exposed");
    assert.ok(!toolNames.includes("write_file"), "disabled write_file should not be exposed");
    assert.ok(!toolNames.includes("bash_terminal"), "disabled bash_terminal should not be exposed");
    assert.ok(toolNames.includes("respond_to_user"), "respond_to_user must remain exposed");
  });

  it("should still reject passive handoffs before the cap is reached", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 50 }));
    const respondToUser = tools.find((t: any) => t.name === "respond_to_user");
    assert.ok(respondToUser, "respond_to_user tool must be present");

    const result = await respondToUser.implementation({ text: "Let me know if you want more." });
    assert.ok(!result?.ok, "passive handoff should be rejected before the cap");
    assert.match(String(result.error), /passive handoff/i);
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

  it("should hand off oversized multi-step prompts instead of hard failing", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const hugeSteps = Array.from({ length: 3000 }, (_, i) => `${i + 1}. step ${i}`).join("\n");
    const processed = await preprocessMessage(hugeSteps);
    assert.ok(processed, "preprocessMessage should return a response");
    assert.match(processed!, /\[vibeLM:managed-context\]/, "overflow response should preserve managed context");
    assert.match(processed!, /respond_to_user/i, "overflow response should tell the model to hand off");
  });

  it("should use the loaded model context and avoid false overflow at 32000 tokens", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const hugeHistory = "tool output ".repeat(5000);
    const ctl = makePromptCtl({
      historyText: hugeHistory,
      models: [
        { identifier: "qwen/qwen3.5-9b", contextLength: 32000 },
      ],
    });

    const processed = await preprocessMessage("hello", ctl);
    assert.equal(processed, null, "preprocessMessage should not overflow when the loaded model context is 32000");
  });

  it("should reuse the last known loaded context during a transient model lookup failure and invalidate it on model change", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const historyText = "tool output ".repeat(3500);
    const firstCtl = makePromptCtl({
      historyText,
      models: [
        { identifier: "model-a", contextLength: 16000 },
      ],
    });

    const first = await preprocessMessage("hello", firstCtl);
    assert.equal(first, null, "initial request should fit under the loaded 16000-token context");

    const failedCtl = makePromptCtl({
      historyText,
      failLoadedModels: true,
    });
    const second = await preprocessMessage("hello", failedCtl);
    assert.equal(second, null, "transient model lookup failure should reuse the last known loaded context");

    const changedCtl = makePromptCtl({
      historyText,
      models: [
        { identifier: "model-b", contextLength: 8192 },
      ],
    });
    const third = await preprocessMessage("hello", changedCtl);
    assert.ok(third, "model change should invalidate the cache and restore overflow protection");
    assert.match(third!, /\[vibeLM:managed-context\]/, "overflow response should be a handoff prompt");
  });

  it("should inject managed context once and skip duplicate injection after history reload", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    let historyText = "";
    const ctl = {
      pullHistory: async () => ({
        getSystemPrompt: () => historyText,
        toString: () => historyText,
      }),
    } as any;

    const first = await preprocessMessage("1. do the first thing\n2. do the second thing", ctl);
    assert.ok(first, "first preprocess should inject managed context");
    assert.match(first!, /\[vibeLM:managed-context\]/, "injected prompt should carry the managed context marker");

    historyText = first!;
    const second = await preprocessMessage("1. do the first thing\n2. do the second thing", ctl);
    assert.equal(second, null, "preprocessMessage should not inject a duplicate managed prompt after reload");
  });

  it("should reuse the same session anchor after a restart without doubling the managed context", async () => {
    const { preprocessMessage, toolsProvider, estimatePromptBudgetSnapshot } = await import("../src/toolsProvider");
    let historyText = "";
    const ctl = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({
        getSystemPrompt: () => historyText,
        toString: () => historyText,
      }),
      client: {
        llm: {
          listLoaded: async () => ([
            {
              identifier: "model-a",
              modelKey: "model-a",
              path: "model-a",
              contextLength: 16000,
              getModelInfo: async () => ({ contextLength: 16000 }),
            },
          ]),
        },
      },
    } as any;

    const firstPrompt = await preprocessMessage("1. do the first thing\n2. do the second thing", ctl);
    assert.ok(firstPrompt, "first preprocess should inject managed context");
    assert.match(firstPrompt!, /\[vibeLM:managed-context\]/, "first injected prompt should carry the managed context marker");
    historyText = firstPrompt!;

    const firstTools = await toolsProvider(ctl);
    const readFileTool = firstTools.find((t: any) => t.name === "read_file");
    assert.ok(readFileTool, "read_file tool should be available");
    const getConfigTool = firstTools.find((t: any) => t.name === "get_config");
    assert.ok(getConfigTool, "get_config tool should be available");
    const readResult = await readFileTool.implementation({ filePath: "README.md", maxChars: 200, offset: 0 });
    assert.ok(readResult?.ok, `read_file should succeed before restart: ${JSON.stringify(readResult)}`);

    const firstConfig = await getConfigTool.implementation({});
    assert.ok(firstConfig?.ok, "get_config should succeed before restart");
    const firstSessionId = firstConfig.data.sessionId as string;
    const baseBudget = estimatePromptBudgetSnapshot(firstPrompt!, "1. do the first thing\n2. do the second thing", 16000);
    const managedBlock = firstPrompt!.slice(0, firstPrompt!.indexOf("\n\n1. do the first thing\n2. do the second thing"));
    const duplicateBudget = estimatePromptBudgetSnapshot(
      `${firstPrompt!}\n${managedBlock}`,
      "1. do the first thing\n2. do the second thing",
      16000,
    );
    assert.equal(
      duplicateBudget.estimatedTokens,
      baseBudget.estimatedTokens,
      "duplicate managed context should be normalized out of prompt-budget estimation",
    );

    const restartedTools = await toolsProvider(ctl);
    const restartedConfigTool = restartedTools.find((t: any) => t.name === "get_config");
    assert.ok(restartedConfigTool, "get_config tool should be available after restart");
    const restartedConfig = await restartedConfigTool.implementation({});
    assert.ok(restartedConfig?.ok, "get_config should succeed after restart");
    assert.equal(restartedConfig.data.sessionId, firstSessionId, "restart should reuse the same session anchor");
    assert.ok(
      restartedConfig.data.promptBudget.rollingWindowTriggerTokens <= restartedConfig.data.promptBudget.hardLimitTokens,
      "restart should keep rolling-window limits aligned with the model budget",
    );

    const secondPrompt = await preprocessMessage("1. do the first thing\n2. do the second thing", ctl);
    assert.equal(secondPrompt, null, "restart should not inject a duplicate managed prompt");
  });

  it("should reject bare set workspace requests without an explicit path", async () => {
    const { preprocessMessage, toolsProvider } = await import("../src/toolsProvider");
    const workspaceFromMemory = resolve(TEST_DIR, "memory-workspace");
    mkdirSync(workspaceFromMemory, { recursive: true });

    const configPath = resolve(CONFIG_DIR, "config.json");
    const previousConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;

    try {
      const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
      const saveMemory = tools.find((tool: any) => tool.name === "save_memory");
      assert.ok(saveMemory, "save_memory tool should be available for the memory-backed workspace test");
      const saved = await saveMemory.implementation({
        content: `Workspace: ${workspaceFromMemory}`,
        tags: ["workspace"],
        scope: "workspace",
      });
      assert.ok(saved?.ok, `save_memory should succeed: ${JSON.stringify(saved)}`);

      const result = await preprocessMessage("set workspace");
      assert.ok(result, "bare set workspace should return a controlled error");
      assert.match(result!, /explicit path required/i, "bare set workspace should no longer search memory");

      const configAfter = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.equal(configAfter.workspacePath, TEST_DIR, "bare set workspace should not change the workspace without an explicit path");
    } finally {
      if (previousConfig === null) {
        try { unlinkSync(configPath); } catch {}
      } else {
        writeFileSync(configPath, previousConfig);
      }
      makeConfig();
    }
  });

  it("should ignore older workspace memories when the latest memory is unrelated", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    const { getLatestWorkspaceMemory } = await import("../src/toolsProvider");
    const log = new SessionLog(resolve(SESSION_LOG_PATH));
    const workspaceFromMemory = resolve(TEST_DIR, "older-memory-workspace");
    mkdirSync(workspaceFromMemory, { recursive: true });

    log.saveMemory(["workspace"], `Workspace: ${workspaceFromMemory}`, undefined, "session-memory", undefined, "workspace");
    log.saveMemory(["note"], "latest memory does not mention a workspace", undefined, "session-memory", undefined, "workspace");

    assert.equal(getLatestWorkspaceMemory(log), null, "only the latest memory entry should be considered");
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
      scope: "research",
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
    assert.match(compactResult.data.handoff, /Start a new chat/i, "compact_context should provide a handoff block");
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
      scope: "session",
    });
    assert.ok(reloadResult?.ok, "search_memory should succeed");
    assert.ok(reloadResult.data.results.length >= 1, "compact memory must be reloadable");
    assert.equal(reloadResult.data.scope, "session");
    assert.ok(
      reloadResult.data.results.some((entry: any) => String(entry.content).includes("[omitted; local source should be re-read on demand]")),
      "stored compact memory must point back to local source instead of storing raw code",
    );

    const researchResult = await searchMemory.implementation({
      query: "compact context without paraphrasing code",
      maxResults: 10,
      scope: "research",
    });
    assert.ok(researchResult?.ok, "research-scoped search should succeed");
    assert.ok(
      researchResult.data.results.some((entry: any) => entry.scope === "research"),
      "research-scoped search should return the explicitly scoped memory",
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

  it("should complete a full user journey end to end", async () => {
    const { preprocessMessage, toolsProvider } = await import("../src/toolsProvider");

    const workspaceRequest = await preprocessMessage(`set workspace ${TEST_DIR}`);
    assert.ok(workspaceRequest, "workspace setup should be rewritten by the preprocessor");
    assert.match(workspaceRequest!, /\[Tool executed: set_workspace\]/, "workspace setup should stay neutral and not encourage exploration");
    assert.doesNotMatch(workspaceRequest!, /\[vibeLM:managed-context\]/, "workspace setup should not inject managed context");
    assert.doesNotMatch(workspaceRequest!, new RegExp(TEST_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "workspace path should not be echoed into the prompt");

    const tools = await toolsProvider({ getWorkingDirectory: () => TEST_DIR } as any);
    const toolMap = new Map(tools.map((tool: any) => [tool.name, tool]));

    const configResult = await toolMap.get("get_config").implementation({});
    assert.ok(configResult?.ok, `get_config should succeed: ${JSON.stringify(configResult)}`);
    assert.equal(configResult.data.workspace, TEST_DIR);
    assert.ok(configResult.data.promptBudget.hardLimitTokens > 0, "prompt budget should be reported");

    const listResult = await toolMap.get("list_files").implementation({ path: "." });
    assert.ok(listResult?.ok, `list_files should succeed: ${JSON.stringify(listResult)}`);
    assert.ok(
      listResult.data.entries.some((entry: any) => entry.name === "README.md"),
      "user journey should see the repository README",
    );
    assert.ok(
      listResult.data.entries.some((entry: any) => entry.name === "src"),
      "user journey should see the source tree",
    );

    const readResult = await toolMap.get("read_file").implementation({ filePath: "src/snippet.ts", maxChars: 2000, offset: 0 });
    assert.ok(readResult?.ok, `read_file should succeed: ${JSON.stringify(readResult)}`);
    assert.match(readResult.data.content, /export const meaning = 42;/, "user journey should read exact code");

    const memoryResult = await toolMap.get("save_memory").implementation({
      content: "User journey: workspace, file inspection, memory, compaction, final response.",
      tags: ["journey", "user-flow"],
      scope: "workspace",
    });
    assert.ok(memoryResult?.ok, `save_memory should succeed: ${JSON.stringify(memoryResult)}`);

    const memorySearch = await toolMap.get("search_memory").implementation({
      tags: ["journey"],
      maxResults: 10,
      scope: "workspace",
    });
    assert.ok(memorySearch?.ok, `search_memory should succeed: ${JSON.stringify(memorySearch)}`);
    assert.ok(
      memorySearch.data.results.some((entry: any) => String(entry.content).includes("workspace, file inspection, memory, compaction")),
      "saved journey memory should be recoverable",
    );
    assert.ok(
      typeof memorySearch.data.results[0].matchScore === "number" && Array.isArray(memorySearch.data.results[0].matchedTags),
      "search_memory results should expose match metadata",
    );

    const compactResult = await toolMap.get("compact_context").implementation({
      maxTokens: 600,
      includeCode: true,
      saveToMemory: true,
      force: true,
      goalHint: "Validate the full user journey from workspace setup to final response.",
    });
    assert.ok(compactResult?.ok, `compact_context should succeed: ${JSON.stringify(compactResult)}`);
    assert.match(compactResult.data.handoff, /Start a new chat/i, "user journey should include a handoff block");
    assert.ok(compactResult.data.savedToMemory, "compaction should be stored for reuse");
    assert.ok(compactResult.data.importantPaths.includes("src/snippet.ts"), "user journey should keep important paths");

    const respondResult = await toolMap.get("respond_to_user").implementation({
      text: "Done. I checked the workspace, read the code, saved memory, compacted context, and validated the final handoff.",
    });
    assert.ok(respondResult?.ok, `respond_to_user should accept a completed final response: ${JSON.stringify(respondResult)}`);
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

  it("should search memories beyond the old 500-line tail window", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    const log = new SessionLog(resolve(TEST_DIR, "search-memory-regression.jsonl"));
    log.clear();

    log.saveMemory(["target", "deep-target"], "needle memory at the start of the log", 1, "session-a", TEST_DIR, "workspace");
    for (let i = 0; i < 520; i++) {
      log.saveMemory([`noise:${i}`], `noise content ${i}`, i + 2, "session-a", TEST_DIR, "workspace");
    }

    const contentResults = log.searchMemoriesByContent("needle memory", 5, { workspace: TEST_DIR, scope: "workspace" });
    assert.ok(contentResults.length >= 1, "content search should find the older memory");
    assert.match(contentResults[0].content, /needle memory/, "content search should return the matching memory");

    const tagResults = log.searchMemoriesByTags(["deep-target"], 5, { workspace: TEST_DIR, scope: "workspace" });
    assert.ok(tagResults.length >= 1, "tag search should find the older memory");
    assert.ok(tagResults[0].tags.includes("deep-target"), "tag search should return the tagged memory");
    log.clear();
  });

  it("should rank exact memory matches ahead of fuzzy ones", async () => {
    const { SessionLog } = await import("../src/sessionLog");
    const log = new SessionLog(resolve(TEST_DIR, "search-memory-ranking.jsonl"));
    log.clear();

    log.saveMemory(["project:alpha"], "match memory", 1, "session-rank", TEST_DIR, "workspace");
    log.saveMemory(["project:alpha-beta"], "fuzzy match memory", 2, "session-rank", TEST_DIR, "workspace");

    const tagResults = log.searchMemoriesByTags(["project:alpha"], 5, { workspace: TEST_DIR, scope: "workspace" });
    assert.ok(tagResults.length >= 2, "tag search should return both exact and fuzzy matches");
    assert.equal(tagResults[0].tags[0], "project:alpha", "exact tag match should rank first");

    const contentResults = log.searchMemoriesByContent("match memory", 5, { workspace: TEST_DIR, scope: "workspace" });
    assert.ok(contentResults.length >= 2, "content search should return both exact and fuzzy matches");
    assert.equal(contentResults[0].content, "match memory", "exact content should rank first");
    assert.ok(typeof contentResults[0].matchScore === "number", "match score should be exposed for debugging");
    log.clear();
  });
});
