import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, rmSync } from "node:fs";
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
  // Pin the loaded-model architecture so the suite never depends on whichever model the developer
  // happens to have loaded in LM Studio. toolsProvider() consults the arch to decide whether to offer
  // `amend` (Harmony families must not be — they have a native final channel), so without this the
  // tool list would silently change between machines. qwen3_5 is a non-Harmony arch, i.e. amend on.
  before(async () => {
    const { setLoadedModelInfoOverride } = await import("../src/toolsProvider");
    setLoadedModelInfoOverride({ arch: "qwen3_5", loadedContextLength: null });
  });

  before(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(resolve(TEST_DIR, "src"), { recursive: true });
    writeFileSync(resolve(TEST_DIR, "src", "main.ts"), 'console.log("hello from vibeLM");\n');
    makeConfig();
  });

  beforeEach(() => {
    // Each test expects a clean slate. bootstrapSessionState's "no history at all" path now correctly
    // carries over a persisted plan/managedContextBlocks (fixed a live bug where a hot-reloaded/
    // restarted process silently dropped an in-progress plan), so a plan left on disk by a previous
    // test would otherwise leak forward into tests that expect no plan/no managed-context yet.
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    if (existsSync(rsPath)) rmSync(rsPath);
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

  it("hands off before the live prompt reaches the context window", async () => {
    const { preprocessMessage } = await import("../src/toolsProvider");
    const history = "x".repeat(32768 * 2);
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => history }),
      getModelContextWindow: () => 32768,
    };
    const processed = await preprocessMessage("continue the benchmark", ctl);
    assert.ok(processed, "a near-limit history must be rewritten before the host request is sent");
    assert.match(processed as string, /Budget warning/i);
    assert.match(processed as string, /continue the benchmark/);
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
    // gpt-oss: native Harmony tiers, deterministic; off/low both hit its floor (Harmony has no "off" tier)
    assert.equal(reasoningDirectiveFor("off", "gpt-oss"), "Reasoning: low");
    assert.equal(reasoningDirectiveFor("low", "gpt_oss"), "Reasoning: low");
    assert.equal(reasoningDirectiveFor("medium", "gptoss"), "Reasoning: medium");
    assert.equal(reasoningDirectiveFor("high", "gpt-oss"), "Reasoning: high");
    // Qwen: binary /think–/no_think toggle is the only native lever, but low/medium/high must still
    // be textually distinct so the setting isn't a no-op across the three "on" tiers.
    assert.equal(reasoningDirectiveFor("off", "qwen3"), "/no_think");
    const qwenLow = reasoningDirectiveFor("low", "qwen35");
    const qwenMedium = reasoningDirectiveFor("medium", "qwen3_5");
    const qwenHigh = reasoningDirectiveFor("high", "qwen3");
    assert.match(qwenLow, /^\/think/);
    assert.match(qwenMedium, /^\/think/);
    assert.match(qwenHigh, /^\/think/);
    assert.notEqual(qwenLow, qwenMedium);
    assert.notEqual(qwenMedium, qwenHigh);
    assert.notEqual(qwenLow, qwenHigh);
    // Models without an explicit control (Llama/Mistral/Gemma/DeepSeek/GLM/Phi/etc.): every level
    // must produce a distinct, non-empty natural-language directive — no silent no-ops.
    const genericOff = reasoningDirectiveFor("off", "gemma4");
    const genericLow = reasoningDirectiveFor("low", "glm4v");
    const genericMedium = reasoningDirectiveFor("medium", "gemma4");
    const genericHigh = reasoningDirectiveFor("high", "llama");
    for (const directive of [genericOff, genericLow, genericMedium, genericHigh]) {
      assert.ok(directive.length > 0, "reasoning directive must not be empty");
    }
    assert.match(genericOff, /do not produce extended/i);
    assert.match(genericLow, /brief/i);
    assert.notEqual(genericMedium, "");
    assert.notEqual(genericHigh, "");
    assert.notEqual(genericMedium, genericHigh);
    assert.notEqual(genericLow, genericMedium);
  });

  it("resolveBridgeTickMaxTokens gives a generous floor to architectures that can't actually turn reasoning off (live-tested: gemma-4, phi-4-mini-reasoning, and Nemotron-H all kept producing full reasoning_content regardless of directive — LM Studio's own native reasoning API even outright rejected 'off' for phi-4-mini-reasoning), so a tight token budget can't silently starve the tick before it reaches its answer", async () => {
    const { resolveBridgeTickMaxTokens } = await import("../src/toolsProvider");
    // Confirmed-unsuppressable architectures from live testing get an explicit generous floor.
    for (const arch of ["gemma4", "Gemma-4", "Phi-3", "phi-4", "nemotron_h_moe", "nemotron"]) {
      assert.equal(resolveBridgeTickMaxTokens(arch), 6000, `${arch} should get the reasoning-safe token floor`);
    }
    // Architectures with a real, confirmed-working off-switch (or none of this baked-in behavior)
    // are left alone — no artificial cap where the default already works fine.
    for (const arch of ["qwen3", "gpt-oss", "Llama", "granitehybrid", "DeepSeek 2", "glm4v", ""]) {
      assert.equal(resolveBridgeTickMaxTokens(arch), undefined, `${arch} should not get an artificial cap`);
    }
  });

  it("reasoningDirectiveForSession lets a plan step's thinking override the session-wide reasoningEffort", async () => {
    const { toolsProvider, reasoningDirectiveFor, reasoningDirectiveForSession, resolveSessionStateFromHistory, setLoadedModelInfoOverride } = await import("../src/toolsProvider");
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      getPluginConfig: () => ({ get: (key: string) => (key === "tools.reasoningEffort" || key === "reasoningEffort") ? "high" : undefined }),
    };
    // Force the "no live LM Studio model" fallback (arch: "") so this test is deterministic whether
    // or not a real LM Studio instance happens to be reachable at API_BASE while tests run. This used
    // to monkeypatch globalThis.fetch; the override seam does the same job without touching a global,
    // and it also takes precedence over the suite-wide arch pin in this file's before() hook.
    setLoadedModelInfoOverride({ arch: "", loadedContextLength: null });
    try {
      await resolveSessionStateFromHistory(ctl, true);
      const tools = await toolsProvider(ctl);
      const createPlan: any = tools.find((t: any) => t.name === "create_plan");
      const updatePlanStep: any = tools.find((t: any) => t.name === "update_plan_step");

      // No plan yet: falls back to the session-wide config ("high").
      const beforePlan = await reasoningDirectiveForSession(ctl);
      assert.equal(beforePlan, reasoningDirectiveFor("high", ""));

      // A step marked "off" should win over the session's "high" while it's the current (pending) step.
      await createPlan.implementation({
        goal: "test goal",
        steps: [{ description: "a mechanical step", thinking: "off" }, "an ordinary step"],
        autoStart: false,
      });
      const duringOffStep = await reasoningDirectiveForSession(ctl);
      assert.equal(duringOffStep, reasoningDirectiveFor("off", ""));

      // Marking it in_progress (still the current step) keeps the override in effect.
      await updatePlanStep.implementation({ index: 0, status: "in_progress" });
      const stillOverridden = await reasoningDirectiveForSession(ctl);
      assert.equal(stillOverridden, reasoningDirectiveFor("off", ""));

      // Once step 0 is done, the current step becomes step 1, which has no override — falls back to config.
      await updatePlanStep.implementation({ index: 0, status: "done" });
      const afterStepDone = await reasoningDirectiveForSession(ctl);
      assert.equal(afterStepDone, reasoningDirectiveFor("high", ""));

      // update_plan_step can also set/change a step's override directly.
      await updatePlanStep.implementation({ index: 1, status: "in_progress", thinking: "low" });
      const viaUpdateStep = await reasoningDirectiveForSession(ctl);
      assert.equal(viaUpdateStep, reasoningDirectiveFor("low", ""));
    } finally {
      // Back to this file's suite-wide pin (a non-Harmony arch, i.e. amend enabled).
      setLoadedModelInfoOverride({ arch: "qwen3_5", loadedContextLength: null });
      // Leaves a persisted plan on disk (config.json's runtime-state.json is shared across this whole
      // file's tests). bootstrapSessionState's "no history at all" path now correctly carries over a
      // persisted plan (fixed a live bug), so a leftover plan here would otherwise leak into later
      // tests that expect a genuinely clean/no-plan slate.
      const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
      if (existsSync(rsPath)) rmSync(rsPath);
    }
  });

  it("captures vibeLM's own emitted directive into managedContextBlocks at emission time, bounded to the most recent one", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl();
    await resolveSessionStateFromHistory(ctl, true);

    const first = await preprocessMessage("1. do a\n2. do b\n3. do c", ctl);
    assert.ok(first?.includes("[vibeLM:managed-context]"), "a multi-step message should trigger a task-mode directive");
    assert.match(first as string, /1\. do a\n2\. do b\n3\. do c/, "the rewrite must preserve the exact latest multi-step request");
    assert.match(first as string, /prioritize it over recapping earlier work/i, "the latest request must outrank stale recap context");

    const runtimeStatePath = resolve(CONFIG_DIR, "runtime-state.json");
    const persisted1 = JSON.parse(readFileSync(runtimeStatePath, "utf-8"));
    assert.equal(persisted1.managedContextBlocks.length, 1, "exactly one directive should be captured");
    assert.match(persisted1.managedContextBlocks[0], /Task mode/);

    const second = await preprocessMessage("1. do x\n2. do y", ctl);
    assert.ok(second?.includes("[vibeLM:managed-context]"));
    const persisted2 = JSON.parse(readFileSync(runtimeStatePath, "utf-8"));
    assert.equal(persisted2.managedContextBlocks.length, 1, "captured directive stays bounded to the most recent one, no unbounded growth");
  });

  it("coarseToolSignature collapses shell programs by name but keeps non-shell calls exact", async () => {
    const { coarseToolSignature } = await import("../src/toolsProvider");
    // Same program, different args → same coarse family.
    assert.equal(
      coarseToolSignature("bash_terminal", { command: "ls /usr/local/bin/node" }),
      coarseToolSignature("bash_terminal", { command: "ls /usr/bin/node" }),
      "distinct-arg calls to the same program must share a coarse signature",
    );
    // Common no-op prefixes are skipped so `sudo ls` and `ls` share a family.
    assert.equal(
      coarseToolSignature("bash_terminal", { command: "sudo ls /a" }),
      coarseToolSignature("bash_terminal", { command: "ls /b" }),
    );
    // Different program → different family.
    assert.notEqual(
      coarseToolSignature("bash_terminal", { command: "ls /a" }),
      coarseToolSignature("bash_terminal", { command: "cat /a" }),
    );
    // Non-shell tools keep their exact signature — different args stay distinct, no over-firing.
    assert.notEqual(
      coarseToolSignature("read_file", { path: "/a" }),
      coarseToolSignature("read_file", { path: "/b" }),
    );
  });

  it("semantic loop guard trips on repeated shell probing with different args (the node-hunt failure)", async () => {
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl({ maxOrchestratorTurns: 0 }); // disable the turn cap so the loop guard is what fires
    await resolveSessionStateFromHistory(ctl, true);   // fresh state: empty toolCallHistory
    const tools = await toolsProvider(ctl);
    const bash = tools.find((t: any) => t.name === "bash_terminal");
    assert.ok(bash?.implementation, "bash_terminal must be present");

    // Replays the observed live failure: probing for node/npm one path per turn. Every call has a
    // distinct exact signature, so only the coarse (program-name) guard can catch it.
    // These paths are deliberately impossible on both developer machines and hosted CI runners.
    // Real system paths such as /usr/local/bin/node may exist in CI, and a successful probe must
    // correctly reset the no-progress streak.
    const probes = [
      "ls /vibelm-definitely-missing-probe-a",
      "ls /vibelm-definitely-missing-probe-b",
      "ls /vibelm-definitely-missing-probe-c",
      "ls /vibelm-definitely-missing-probe-d",
      "ls /vibelm-definitely-missing-probe-e",
      "ls /vibelm-definitely-missing-probe-f",
    ];
    let loopError: string | null = null;
    let tripIndex = -1;
    for (let i = 0; i < probes.length; i++) {
      const res: any = await bash.implementation({ command: probes[i] }, {});
      if (res && res.ok === false && /loop detected/i.test(res.error || "")) {
        loopError = res.error;
        tripIndex = i;
        break;
      }
    }
    assert.ok(loopError, "distinct-arg shell probing must eventually trip the loop guard");
    assert.equal(tripIndex, 4, "guard should trip on the 5th consecutive same-program probe");
    assert.match(loopError as string, /change strategy|amend/i, "the steering message must point the model to a new approach");
  });

  it("does not treat successful distinct node commands as a loop or poison the next unrelated tool", async () => {
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl({ maxOrchestratorTurns: 0 });
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(ctl);
    const bash: any = tools.find((t: any) => t.name === "bash_terminal");
    const getPlan: any = tools.find((t: any) => t.name === "get_plan");

    for (const value of ["add", "list", "complete", "list-again", "clear"]) {
      const result = await bash.implementation({ command: `node -e "console.log('${value}')"` }, {});
      assert.equal(result?.ok, true, `successful node command ${value} must not be rejected as a loop`);
    }

    const unrelated = await getPlan.implementation({}, {});
    assert.notEqual(unrelated?.ok, false, "an old shell family must never block an unrelated current tool");
  });

  it("does not let an exact-call loop rejection poison a different tool", async () => {
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl({ maxOrchestratorTurns: 0 });
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(ctl);
    const bash: any = tools.find((t: any) => t.name === "bash_terminal");
    const getPlan: any = tools.find((t: any) => t.name === "get_plan");

    let rejected = false;
    for (let i = 0; i < 4; i++) {
      const result = await bash.implementation({ command: "printf exact-loop" }, {});
      rejected ||= result?.ok === false && /loop detected/i.test(result?.error || "");
    }
    assert.equal(rejected, true, "guard condition must be established before checking isolation");
    assert.notEqual((await getPlan.implementation({}, {}))?.ok, false, "a rejected exact call must not block get_plan");
  });

  it("distils tool results into deduped facts instead of dumping raw result blobs", async () => {
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl({ maxOrchestratorTurns: 0 });
    await resolveSessionStateFromHistory(ctl, true);

    const tools = await toolsProvider(ctl);
    const bash = tools.find((t: any) => t.name === "bash_terminal");
    assert.ok(bash?.implementation, "bash_terminal must be present");

    // Four distinct failing `ls` probes (stays under the 5-call loop guard) + one successful command.
    for (const path of ["/vibelm-nope-a", "/vibelm-nope-b", "/vibelm-nope-c", "/vibelm-nope-d"]) {
      await bash.implementation({ command: `ls ${path}` }, {});
    }
    await bash.implementation({ command: "echo vibelm-ok" }, {});

    // The wrapper syncs the session it actually used to runtime-state on every turn; read it back so we
    // filter the log by the correct session id (toolsProvider re-bootstraps its own session).
    const sid = JSON.parse(readFileSync(resolve(CONFIG_DIR, "runtime-state.json"), "utf-8")).sessionId;

    const logPath = resolve(CONFIG_DIR, "session-log.jsonl");
    const mems = readFileSync(logPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e: any) => e.type === "mem" && e.sessionId === sid);

    const lsFails = mems.filter((m: any) => (m.tags || []).includes("fact:bash_terminal:ls:fail"));
    assert.equal(lsFails.length, 1, "four equivalent failing probes must collapse to a single deduped fact");
    assert.match(lsFails[0].content, /^bash_terminal `ls .*` → failed/, "the fact must be a distilled one-liner");
    assert.ok(!lsFails[0].content.includes('{"ok"'), "the fact must not be a raw result blob");

    // Successful calls are keyed on their exact signature (not the coarse program name), so distinct
    // successes are each kept rather than collapsed — the fact tag therefore embeds the full command.
    const echoOk = mems.filter((m: any) => /bash_terminal `echo vibelm-ok` → ok/.test(m.content));
    assert.equal(echoOk.length, 1, "a successful command records its own outcome fact");
    assert.ok((echoOk[0].tags || []).some((t: string) => t.startsWith("fact:bash_terminal:") && t.endsWith(":ok")), "success fact is tagged with an ok-outcome key");
  });

  it("keeps distinct successful commands as separate facts but never leaks secret args into the fact key", async () => {
    const { distillToolFact } = await import("../src/toolsProvider");

    // Distinct successful commands must not collapse (regression caught in live testing).
    const a = distillToolFact("bash_terminal", { command: "cat a.txt" }, { ok: true, data: { exitCode: 0, stdout: "ALPHA", stderr: "" } });
    const b = distillToolFact("bash_terminal", { command: "cat b.txt" }, { ok: true, data: { exitCode: 0, stdout: "BRAVO", stderr: "" } });
    assert.notEqual(a.key, b.key, "distinct successful commands must get distinct dedupe keys");

    // A secret arg (ssh_exec password) must never appear in the key — the key is persisted as a
    // memory tag, so the success key is a hash of the signature, not the raw args.
    const s = distillToolFact(
      "ssh_exec",
      { host: "h", user: "u", password: "SUPERSECRET123", command: "whoami" },
      { ok: true, data: { exitCode: 0, stdout: "root", stderr: "" } },
    );
    assert.ok(!s.key.includes("SUPERSECRET123"), "the fact key must not embed the password");
    assert.ok(!s.fact.includes("SUPERSECRET123"), "the fact text must not embed the password");
  });

  it("buildContextSpine pins goal + plan + facts as the head (cut-the-middle retention)", async () => {
    const { buildContextSpine } = await import("../src/toolsProvider");
    const { SessionLog } = await import("../src/sessionLog");
    const logPath = resolve(CONFIG_DIR, `spine-${Date.now()}.jsonl`);
    const log = new SessionLog(logPath);
    const sid = "spine-sess";
    log.saveMemory(["fact:bash_terminal:ls:fail", `session:${sid}`], "bash_terminal `ls /x` → failed: not found", 1, sid, "/ws", "workspace");
    log.saveMemory(["fact:bash_terminal:#abc:ok", `session:${sid}`], "bash_terminal `cat a.txt` → ok: ALPHA-DATA", 2, sid, "/ws", "workspace");

    const state: any = {
      sessionId: sid,
      plan: {
        goal: "Build the widget",
        steps: [
          { index: 1, description: "scaffold project", status: "done" },
          { index: 2, description: "wire it up", status: "pending" },
        ],
        createdAt: "", updatedAt: "",
      },
    };

    const spine = buildContextSpine(log, state);
    assert.ok(spine, "spine must be built when a plan and facts exist");
    assert.match(spine as string, /Context spine/, "spine is a managed-context head block");
    assert.match(spine as string, /\[Goal\] Build the widget/, "goal is pinned in the head");
    assert.match(spine as string, /2\. \[pending\] wire it up/, "plan step statuses are pinned");
    assert.match(spine as string, /\[Established facts\]/, "distilled facts are pinned");
    assert.match(spine as string, /ALPHA-DATA/, "the learned fact survives the roll");

    // No plan, no facts → nothing worth pinning → null (never inject an empty head).
    const emptyLog = new SessionLog(resolve(CONFIG_DIR, `spine-empty-${Date.now()}.jsonl`));
    assert.equal(buildContextSpine(emptyLog, { sessionId: "empty", plan: null } as any), null, "no head to pin → null");
  });

  it("bash_terminal runs through an interactive login shell, so PATH additions from rc files (nvm, Homebrew, etc.) are visible", async () => {
    // Regression for a live-testing finding: a bare exec() inherits LM Studio.app's own env, which is
    // never an interactive login shell (GUI apps are launched via Launch Services, not a terminal), so
    // nvm/Homebrew/asdf — which extend PATH by sourcing .zshrc/.zprofile — were invisible to
    // bash_terminal even though the tools were genuinely installed. `$-` contains "i" only when the
    // shell that ran the command was interactive; this is what makes rc-file-sourced PATH edits (like
    // nvm's) actually take effect, portably on both zsh (macOS) and bash (Linux CI).
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl({ maxOrchestratorTurns: 0 });
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(ctl);
    const bash = tools.find((t: any) => t.name === "bash_terminal");
    const result: any = await bash.implementation({ command: "echo FLAGS=$-" }, {});
    assert.ok(result.ok, "the command must execute successfully");
    assert.match(result.data.stdout, /FLAGS=\S*i\S*/, "the shell must run in interactive mode so rc-file PATH edits are sourced");
  });

  it("importance-tiered tool-result caps: reads keep more, failures keep less", async () => {
    const { resultCharBudget } = await import("../src/toolsProvider");
    assert.equal(resultCharBudget("read_file", { ok: true, data: "x".repeat(9000) }), 1500, "reads get the high tier");
    assert.equal(resultCharBudget("search_files", { ok: true, data: [] }), 1500, "searches get the high tier");
    assert.equal(resultCharBudget("read_file", { ok: false, error: "x".repeat(9000) }), 300, "a failed high-value read still gets the low failure tier");
    assert.equal(resultCharBudget("web_search", { ok: false, error: "x".repeat(9000) }), 300, "a failed high-value search still gets the low failure tier");
    assert.equal(resultCharBudget("bash_terminal", { ok: true, data: { exitCode: 1, stderr: "nope" } }), 300, "failures get the low tier");
    assert.equal(resultCharBudget("generate_uuid", { ok: true, data: "abc" }), 500, "everything else gets the default tier");
  });

  it("resets the tool-turn budget when completed work gives way to a fresh actionable follow-up", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    if (existsSync(rsPath)) rmSync(rsPath);
    const ctl: any = {
      ...makeCtl({ maxOrchestratorTurns: 0 }),
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: finish the old task\nTurn 2: old task done" }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(ctl);
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    const updatePlanStep: any = tools.find((t: any) => t.name === "update_plan_step");
    const getPlan: any = tools.find((t: any) => t.name === "get_plan");

    assert.ok((await createPlan.implementation({ goal: "old task", steps: ["finish it"], autoStart: false }, {})).ok);
    for (let i = 0; i < 3; i++) assert.ok((await getPlan.implementation({}, {})).ok);
    assert.ok((await updatePlanStep.implementation({ index: 0, status: "done" }, {})).ok);

    const followup = "cache it for an hour";
    const processed = await preprocessMessage(followup, ctl);
    assert.match(processed as string, /cache it for an hour/, "the fresh request must still become the new goal");
    const retired = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(retired.turnCounter, 0, "completed-plan retirement must give the new task a full turn budget");

    const freshTools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 4 }));
    const freshCreatePlan: any = freshTools.find((t: any) => t.name === "create_plan");
    const freshUpdatePlanStep: any = freshTools.find((t: any) => t.name === "update_plan_step");
    const freshGetPlan: any = freshTools.find((t: any) => t.name === "get_plan");
    assert.ok((await freshCreatePlan.implementation({ goal: followup, steps: ["prepare", "cache"], autoStart: false }, {})).ok);
    assert.ok((await freshUpdatePlanStep.implementation({ index: 0, status: "in_progress" }, {})).ok);
    assert.ok((await freshUpdatePlanStep.implementation({ index: 0, status: "done" }, {})).ok);
    assert.ok((await freshGetPlan.implementation({}, {})).ok, "the old task's get_plan history must not trip the fresh task's loop guard or budget");
  });

  it("Harmony max-turn and loop-guard errors never point at the withheld amend tool", async () => {
    const { toolsProvider, setLoadedModelInfoOverride, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    try {
      setLoadedModelInfoOverride({ arch: "gpt-oss", loadedContextLength: 131072 });

      const cappedCtl = makeCtl({ maxOrchestratorTurns: 1 });
      await resolveSessionStateFromHistory(cappedCtl, true);
      const cappedTools = await toolsProvider(cappedCtl);
      assert.ok(!cappedTools.some((t: any) => t.name === "amend"), "the Harmony toolset must withhold amend");
      const cappedGetPlan: any = cappedTools.find((t: any) => t.name === "get_plan");
      assert.ok(cappedGetPlan, "get_plan must be available for the cap regression");
      assert.ok((await cappedGetPlan.implementation({}, {})).ok);
      const capped: any = await cappedGetPlan.implementation({}, {});
      assert.equal(capped.ok, false);
      assert.doesNotMatch(capped.error, /amend/i, "max-turn recovery must not name an unavailable tool");
      assert.match(capped.error, /reply directly/i, "Harmony recovery must tell the model how to finish natively");

      const loopCtl = makeCtl({ maxOrchestratorTurns: 0 });
      await resolveSessionStateFromHistory(loopCtl, true);
      const loopTools = await toolsProvider(loopCtl);
      const getPlan: any = loopTools.find((t: any) => t.name === "get_plan");
      assert.ok(getPlan, "get_plan must be available for the loop regression");
      let looped: any = null;
      for (let i = 0; i < 4; i++) looped = await getPlan.implementation({}, {});
      assert.equal(looped.ok, false, "the fourth exact call must exercise the loop guard");
      assert.doesNotMatch(looped.error, /amend/i, "loop recovery must not name an unavailable tool");
      assert.match(looped.error, /reply directly/i, "Harmony loop recovery must use the native final channel");
    } finally {
      setLoadedModelInfoOverride({ arch: "qwen3_5", loadedContextLength: null });
    }
  });

  it("describes get_plan as an exact empty-object call for gpt-oss compatibility", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ maxOrchestratorTurns: 0 }));
    const getPlan: any = tools.find((t: any) => t.name === "get_plan");
    assert.ok(getPlan, "get_plan must be exposed");
    assert.match(getPlan.description, /exactly an empty object:\s*\{\}/i);
    assert.match(getPlan.description, /do not.*goal.*steps/i, "the live malformed argument names must be called out explicitly");
  });

  it("buildContextSpine budgets tiers: goal pinned, facts fill remaining budget", async () => {
    const { buildContextSpine, headBudgetChars } = await import("../src/toolsProvider");
    const { SessionLog } = await import("../src/sessionLog");
    const log = new SessionLog(resolve(CONFIG_DIR, `budget-${Date.now()}.jsonl`));
    const sid = "budget-sess";
    for (let i = 0; i < 12; i++) {
      log.saveMemory([`fact:x:${i}:ok`, `session:${sid}`], `established fact number ${i} with some descriptive content`, i, sid, "/ws", "workspace");
    }
    const state: any = { sessionId: sid, plan: { goal: "SHIP-THE-THING", steps: [{ index: 1, description: "do it", status: "pending" }], createdAt: "", updatedAt: "" } };

    // Tight budget: goal/plan is pinned (Tier 1), facts (Tier 2) don't fit.
    const tight = buildContextSpine(log, state, 40) as string;
    assert.match(tight, /SHIP-THE-THING/, "goal is pinned even under a tiny budget");
    assert.ok(!/Established facts/.test(tight), "facts are dropped when the budget can't fit them");

    // Roomy budget: facts fill the remaining space.
    const roomy = buildContextSpine(log, state, 6000) as string;
    assert.match(roomy, /Established facts/, "facts fill the head when budget allows");

    // Head budget scales with the context window.
    assert.ok(headBudgetChars(32768) > headBudgetChars(8192), "bigger context → bigger head budget");
  });

  it("auto-populates plan.goal from the first substantive request, but not from commands", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    const ctl = makeCtl();
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("Build a CLI that parses CSV files and outputs JSON", ctl);
    const rs = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.ok(rs.plan, "plan should be auto-populated from a substantive goal");
    assert.match(rs.plan.goal, /Build a CLI/);
    assert.deepEqual(rs.plan.steps, [], "auto-goal seeds an empty step list so amend's pending-step guard stays satisfied");

    // A short/command message must not seed a goal. Clear the persisted plan from the phase above
    // first: resolveSessionStateFromHistory's "no history at all" reset now correctly carries over a
    // persisted plan instead of wiping it (fixed a live bug), so this phase needs an explicit clean
    // slate rather than relying on that reset to discard the previous phase's plan.
    if (existsSync(rsPath)) rmSync(rsPath);
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("yes", ctl);
    const rs2 = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(rs2.plan, null, "continuations/commands do not become the session goal");
  });

  it("a goal-only auto-plan (zero steps) does NOT survive a resume after a roll — superseded by the create_plan-directive fix (previously this plan intentionally survived the round-trip; live evidence — a real 4-day-old 'can u finish the job?' / steps:[] plan still reasserting itself in production runtime-state.json — showed that just meant a dead goal nobody ever expanded into steps kept coming back forever, since create_plan is reproducibly never called on its own. See the dedicated 'does NOT carry over a goal-only plan' tests above for the full regression coverage; this one only guards the parsePersistedPlan round-trip itself still preserves a goal-only shape when read back, even though bootstrapSessionState now discards it.)", async () => {
    const { resolveSessionStateFromHistory, preprocessMessage } = await import("../src/toolsProvider");
    let history = "conversation head one";
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      getPluginConfig: () => ({ get: (k: string) => (k.endsWith("maxOrchestratorTurns") ? 0 : undefined) }),
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => history }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("Implement a CSV to JSON converter with unit tests", ctl);

    // Roll the raw history so the fingerprint mismatches — the resume path re-reads the persisted plan
    // through parsePersistedPlan, which still round-trips a goal-only shape correctly; it's
    // bootstrapSessionState's carryover check (planWorthCarryingForward) that now drops it.
    history = "totally different head after a roll";
    const resumed: any = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(resumed.resumedFromPersistedState, false, "a goal-only plan has nothing to resume, so this no longer counts as a resume");
    assert.equal(resumed.plan, null, "a goal-only plan must not survive the round-trip — it was never expanded into real steps");
  });

  it("toolsProvider() must not discard session identity every turn (live-testing regression: the real ToolsProviderController has no pullHistory, so a forced bootstrap there always manufactured a brand-new session, resetting turnCounter to 0 on every single turn and making auto-compaction/fact-dedup/spine-resume unreachable in production)", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    // preprocessMessage's controller has pullHistory (matches the real PromptPreprocessorController).
    let history = "Turn 1: build a widget";
    const preprocessCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => history }),
    };
    // toolsProvider's controller has no pullHistory — matches the real ToolsProviderController, which
    // is an empty class per the SDK's own type definitions.
    const toolsProviderCtl = makeCtl();

    await resolveSessionStateFromHistory(preprocessCtl, true);
    await preprocessMessage("Build a widget with a plan", preprocessCtl);
    await toolsProvider(toolsProviderCtl);
    const afterTurn1 = JSON.parse(readFileSync(rsPath, "utf-8"));

    // A second, ordinary turn: history grows naturally (not a host-side roll).
    history += "\nTurn 2: continue the widget work";
    await preprocessMessage("Now add a test for it", preprocessCtl);
    await toolsProvider(toolsProviderCtl);
    const afterTurn2 = JSON.parse(readFileSync(rsPath, "utf-8"));

    assert.equal(afterTurn2.sessionId, afterTurn1.sessionId, "sessionId must persist across turns in the same conversation, not regenerate every turn");
  });

  it("bootstrapSessionState carries over a persisted plan even when NO history is readable at all (live-testing regression: a mid-conversation lms-dev hot reload/process restart wipes module state, and the very next bootstrap call can come from a controller with no pullHistory — e.g. a vibe_bridge tick — before any real preprocessMessage call re-establishes history; the fingerprint-mismatch branch already carried the plan over in that case, but the 'no history at all' branch silently dropped it, discarding an in-progress plan the user was actively relying on)", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    const preprocessCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: build a widget" }),
    };
    await resolveSessionStateFromHistory(preprocessCtl, true);
    await preprocessMessage("Build a widget with a plan", preprocessCtl);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    await createPlan.implementation({ goal: "widget plan", steps: ["step one", "step two"], autoStart: false });
    const beforeReload = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.ok(beforeReload.plan?.steps?.length === 2, "plan should be persisted before the simulated reload");

    // Simulate a hot reload / process restart: fresh module-level state, and the very next call is a
    // controller with no pullHistory at all (a vibe_bridge tick, or the real ToolsProviderController).
    const noHistoryCtl: any = { getWorkingDirectory: () => TEST_DIR };
    const resumed = await resolveSessionStateFromHistory(noHistoryCtl, true);

    assert.ok(resumed.plan, "the persisted plan must survive a bootstrap with no readable history at all, not be silently dropped");
    assert.equal(resumed.plan?.goal, "widget plan");
    assert.equal(resumed.plan?.steps?.length, 2);
    assert.equal(resumed.resumedFromPersistedState, true, "carrying over a persisted plan counts as a resume, not a fresh session");

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("bootstrapSessionState does NOT carry over a persisted plan into a genuinely new/different chat (live-testing regression: a brand-new chat asking for an unrelated weather CLI resurrected a many-turn, unrelated 'build a REST API backend' plan from a previous session and started writing files for it, because the fingerprint-mismatch branch carried the old plan over unconditionally — it could not tell a real restart/roll of the SAME conversation apart from a genuinely NEW one)", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    // Establish a substantial, many-turn old conversation with a real plan.
    let oldHistory = "Turn 1: build a production REST API backend with Express and TypeScript\n".repeat(30);
    const oldCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => oldHistory }),
    };
    await resolveSessionStateFromHistory(oldCtl, true);
    await preprocessMessage("Build a production REST API backend with Express and TypeScript", oldCtl);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    await createPlan.implementation({ goal: "REST API backend", steps: ["scaffold project", "add routes", "add tests"], autoStart: false });
    const beforeNewChat = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.ok(beforeNewChat.plan?.steps?.length === 3, "old plan should be persisted before the new chat starts");

    // A brand-new, unrelated chat: short history, completely different topic, and — critically — it
    // does NOT match the old fingerprint (this is the same code path a real restart/roll takes).
    const newChatCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "yo can you set me up a quick weather cli" }),
    };
    const resumed = await resolveSessionStateFromHistory(newChatCtl, true);

    assert.equal(resumed.plan, null, "a genuinely new/different chat must NOT inherit the old, unrelated plan");
    assert.equal(resumed.resumedFromPersistedState, false, "a genuinely new chat is not a resume");

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("bootstrapSessionState STILL carries over a persisted plan across a real mid-conversation restart/roll (guards against the previous test's fix being too aggressive)", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    let history = "Turn 1: build a production REST API backend with Express and TypeScript\n".repeat(30);
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => history }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("Build a production REST API backend with Express and TypeScript", ctl);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    await createPlan.implementation({ goal: "REST API backend", steps: ["scaffold project", "add routes", "add tests"], autoStart: false });

    // Simulate a host-side roll/restart of the SAME conversation: the raw text changes (so the
    // fingerprint no longer matches) but stays comparably long, as a real ongoing conversation would.
    history = "Turn 1: build a production REST API backend with Express and TypeScript\n".repeat(28) + "Turn 29: continue where we left off, same project\n";
    const resumed = await resolveSessionStateFromHistory(ctl, true);

    assert.ok(resumed.plan, "a real restart/roll of the same, substantial conversation must still carry the plan over");
    assert.equal(resumed.plan?.goal, "REST API backend");
    assert.equal(resumed.resumedFromPersistedState, true);

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("retires the completed echo-command plan before the exact day-of-week follow-up reaches the model", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Running Echo Commands\nAll four plan steps completed." }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("Create a plan: run echo one, echo two, echo three, then report every result.", ctl);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    await createPlan.implementation({
      goal: "Run three echo commands and report every result",
      steps: ["run echo one", "run echo two", "run echo three", "report every result"],
      autoStart: false,
    });
    const updatePlanStep: any = tools.find((t: any) => t.name === "update_plan_step");
    for (let index = 0; index < 4; index++) {
      await updatePlanStep.implementation({ index, status: "done" });
    }

    const question = "now also tell me what day of the week it is";
    const processed = await preprocessMessage(question, ctl);

    assert.equal(processed, null, "the informational question must reach the model unchanged, not become a plan directive");

    const rs = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(rs.plan, null, "the completed echo plan must leave active runtime routing before the follow-up");
    assert.doesNotMatch(JSON.stringify(rs), /day of the week/, "the question must not be persisted as step 5 of the echo plan");

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("passes prefixed informational and conversational requests through without auto-creating goals", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "An ordinary conversation" }),
    };
    const requests = [
      "now also tell me what day of the week it is",
      "also what time does the meeting begin",
      "now when does daylight saving time end",
      "also who wrote the original implementation",
      "now how does this function work",
    ];
    await resolveSessionStateFromHistory(ctl, true);
    for (const request of requests) {
      assert.equal(await preprocessMessage(request, ctl), null, `must pass through unchanged: ${request}`);
      const rs = JSON.parse(readFileSync(rsPath, "utf-8"));
      assert.equal(rs.plan, null, `must not create a plan for: ${request}`);
    }
  });

  it("keeps local searches unchanged while explicit web searches still execute end to end", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    if (existsSync(rsPath)) rmSync(rsPath);
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "An ordinary local development conversation" }),
    };
    await resolveSessionStateFromHistory(ctl, true);

    const originalFetch = globalThis.fetch;
    const originalEndpoint = process.env.AGENTIC_SEARCH_ENDPOINT;
    const requests: string[] = [];
    process.env.AGENTIC_SEARCH_ENDPOINT = "https://cascade-search.invalid/search";
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ results: [
        { title: "TypeScript", url: "https://www.typescriptlang.org/", snippet: "Official site" },
      ] }), { status: 200 });
    };

    try {
      const localRequest = "search old sessions and find bugs that have been not fixed yet";
      assert.equal(await preprocessMessage(localRequest, ctl), null, "local search intent must reach the model unchanged");
      assert.equal(requests.length, 0, "bare local search must perform no network request");

      const webRequest = "search the web for TypeScript official site";
      const processed = await preprocessMessage(webRequest, ctl);
      assert.equal(requests.length, 1, "explicit web intent must execute exactly one search request");
      assert.equal(new URL(requests[0]).searchParams.get("q"), "TypeScript official site", "the proxy must receive the exact search query");
      assert.match(processed as string, /Tool executed: web_search/, "the proxy result must be injected into the model prompt");
      assert.match(processed as string, /https:\/\/www\.typescriptlang\.org\//, "the injected result must include its URL");
      assert.ok((processed as string).includes(webRequest), "the explicit request must remain visible after preprocessing");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEndpoint === undefined) delete process.env.AGENTIC_SEARCH_ENDPOINT;
      else process.env.AGENTIC_SEARCH_ENDPOINT = originalEndpoint;
    }
  });

  it("only preprocesses expression-shaped calculator prompts and accepts terminal question marks", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    if (existsSync(rsPath)) rmSync(rsPath);
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "An ordinary conversation" }),
    };
    await resolveSessionStateFromHistory(ctl, true);

    assert.equal(await preprocessMessage("what is the status of the build?", ctl), null, "natural-language questions must bypass mathjs");
    const calculated = await preprocessMessage("what is 2+2?", ctl);
    assert.match(calculated as string, /calculate → 4/, "a terminal question mark must not break a valid calculation");
  });

  it("starts a fresh plan for an actionable follow-up after completion", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: build a weather cli\nTurn 2: done" }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    const updatePlanStep: any = tools.find((t: any) => t.name === "update_plan_step");
    await createPlan.implementation({ goal: "weather cli", steps: ["write index.js"], autoStart: false });
    await updatePlanStep.implementation({ index: 0, status: "done" });

    const request = "cache it for an hour";
    const processed = await preprocessMessage(request, ctl);

    assert.ok(processed, "an actionable follow-up should start fresh tracked work");
    assert.match(processed as string, /cache it for an hour/, "a rewrite must include the exact latest request");
    assert.match(processed as string, /prioritize.*over recapping completed work/i, "the latest request must outrank completed-work recap");
    assert.match(processed as string, /create_plan/, "fresh actionable work should be expanded into its own plan");
    const rs = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(rs.plan?.goal, request, "the new plan must be anchored to the follow-up, not the completed goal");
    assert.equal(rs.plan?.steps?.length, 0, "the old completed steps must not be mutated or retained");
  });

  it("keeps an unfinished plan active while passing its follow-up through unchanged", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: run three echo commands" }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    const updatePlanStep: any = tools.find((t: any) => t.name === "update_plan_step");
    await createPlan.implementation({ goal: "echo plan", steps: ["echo one", "echo two", "report"], autoStart: false });
    await updatePlanStep.implementation({ index: 0, status: "done" });

    const processed = await preprocessMessage("also use uppercase output for the remaining commands", ctl);

    assert.equal(processed, null, "a follow-up to an unfinished plan should remain ordinary model input");
    const rs = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(rs.plan?.goal, "echo plan");
    assert.equal(rs.plan?.steps?.length, 3, "pending-plan follow-ups must not be auto-appended");
    assert.equal(rs.plan?.steps?.[1]?.status, "pending");
  });

  it("does not rehydrate a completed plan or its context spine after plugin restart", async () => {
    const { preprocessMessage, toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Running Echo Commands\nAll echo steps and reporting are done." }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(makeCtl());
    const createPlan: any = tools.find((t: any) => t.name === "create_plan");
    const updatePlanStep: any = tools.find((t: any) => t.name === "update_plan_step");
    await createPlan.implementation({ goal: "echo plan", steps: ["echo one", "echo two", "echo three", "report"], autoStart: false });
    for (let index = 0; index < 4; index++) await updatePlanStep.implementation({ index, status: "done" });

    const restarted = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(restarted.plan, null, "a completed plan must not become active again during bootstrap");

    const processed = await preprocessMessage("now also tell me what day of the week it is", ctl);
    assert.equal(processed, null, "restart must not inject the completed plan's context spine ahead of the question");
  });

  it("bootstrapSessionState does NOT carry over a goal-only plan with zero steps across a reload with no readable history (live-testing regression: create_plan is reproducibly never called by real models — grepping every real session in session-log.jsonl across 4 days found zero create_plan calls — so the auto-seeded goal-only plan just sits there forever with nothing to execute; carrying it forward indefinitely only means a dead goal keeps reasserting itself into new sessions instead of ever being expanded into real steps)", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    const preprocessCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: build a widget" }),
    };
    await resolveSessionStateFromHistory(preprocessCtl, true);
    // A goal-like message auto-seeds plan.goal but leaves steps empty — create_plan is never called,
    // matching every real session observed live.
    await preprocessMessage("build me a quick widget cli", preprocessCtl);
    const beforeReload = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.ok(beforeReload.plan, "goal should be auto-seeded");
    assert.equal(beforeReload.plan.steps.length, 0, "steps should still be empty — create_plan was never called");

    const noHistoryCtl: any = { getWorkingDirectory: () => TEST_DIR };
    const resumed = await resolveSessionStateFromHistory(noHistoryCtl, true);

    assert.equal(resumed.plan, null, "a goal-only, zero-step plan has nothing to resume and must not be carried forward");

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("bootstrapSessionState does NOT carry over a goal-only plan with zero steps across a fingerprint-mismatch restart/roll either (same fix, other carryover branch)", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    let history = "Turn 1: build a production widget dashboard\n".repeat(30);
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => history }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("Build a production widget dashboard", ctl);
    const beforeReload = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(beforeReload.plan?.steps?.length, 0, "steps should still be empty — create_plan was never called");

    // Same-conversation restart/roll: comparable history length, different fingerprint — the case the
    // existing "STILL carries over" guard test proves must keep working for a REAL (non-empty) plan.
    history = "Turn 1: build a production widget dashboard\n".repeat(28) + "Turn 29: continue where we left off\n";
    const resumed = await resolveSessionStateFromHistory(ctl, true);

    assert.equal(resumed.plan, null, "a goal-only, zero-step plan must not survive even a same-conversation restart — it has no steps to resume");

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("a goal-only plan with zero steps forces a create_plan directive on the next goal-like turn instead of silently letting the model skip straight to other tools (live-testing regression: every real session in session-log.jsonl skipped create_plan entirely and just called bash_terminal/read_file/write_file directly, leaving plan.steps empty forever, which in turn starves vibe_bridge's tick directive)", async () => {
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: build a weather cli" }),
    };
    await resolveSessionStateFromHistory(ctl, true);
    await preprocessMessage("build me a quick weather cli that takes a city and prints the weather", ctl);

    const processed = await preprocessMessage("also add a caching layer to the weather cli", ctl);

    assert.ok(processed, "a goal-like follow-up while steps are still empty must produce a directive, not pass through silently");
    assert.match(processed as string, /create_plan/, "the directive must explicitly tell the model to call create_plan");
    assert.match(processed as string, /weather cli/, "the directive must reference the recorded goal");

    if (existsSync(rsPath)) rmSync(rsPath);
  });

  it("delete_file uses the filePath param name, consistent with read_file/write_file (caught live: model used filePath from those tools, delete_file rejected it)", async () => {
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl({ maxOrchestratorTurns: 0, toolToggles: { delete_file: true } });
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(ctl);
    const deleteFile = tools.find((t: any) => t.name === "delete_file");
    assert.ok(deleteFile?.implementation, "delete_file must be present");

    const target = resolve(TEST_DIR, "delete-me.txt");
    writeFileSync(target, "temp");
    const result: any = await deleteFile.implementation({ filePath: "delete-me.txt" });
    assert.ok(result.ok, "delete_file must accept filePath, matching read_file/write_file's param name");
    assert.ok(!existsSync(target), "the file must actually be deleted");
  });

  it("write_file expands a leading ~ in filePath instead of writing a literal '~' directory (caught live: a model passed filePath: '~/Desktop/sandbox/weather-cli/index.js' and the file silently landed at '<workspace>/~/Desktop/sandbox/weather-cli/index.js' while still reporting success)", async () => {
    const { homedir } = require("node:os");
    const home = homedir();
    const homeWorkspace = resolve(home, `.vibelm-cascade-tilde-test-${Date.now()}`);
    mkdirSync(homeWorkspace, { recursive: true });
    makeConfig({ workspacePath: homeWorkspace });
    try {
      const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
      const ctl: any = { getWorkingDirectory: () => homeWorkspace };
      await resolveSessionStateFromHistory(ctl, true);
      const tools = await toolsProvider(ctl);
      const writeFile: any = tools.find((t: any) => t.name === "write_file");

      const relFromHome = homeWorkspace.slice(home.length + 1);
      const result: any = await writeFile.implementation({ filePath: `~/${relFromHome}/tilde-test.txt`, content: "hello" });

      assert.ok(result.ok, "write_file should accept a ~-prefixed path that resolves inside the workspace");
      const expected = resolve(homeWorkspace, "tilde-test.txt");
      assert.equal(result.data.path, expected, "the ~ must be expanded to the real home directory, not treated as a literal path segment");
      assert.ok(existsSync(expected), "the file must actually exist at the expanded path");
      assert.ok(!existsSync(resolve(homeWorkspace, "~")), "no literal '~'-named directory should be created inside the workspace");
    } finally {
      makeConfig();
      rmSync(homeWorkspace, { recursive: true, force: true });
    }
  });

  it("a brand-new chat does NOT inherit the previous session's plan, even though the system prompt dominates the history length", async () => {
    // Live regression (reproduced in LM Studio): opening a fresh chat retitled it "[vibeLM:managed-cont"
    // because preprocessMessage prepended a rehydration block ahead of the user's actual first message,
    // and the previous session's plan came back with it.
    //
    // bootstrapSessionState decides "is this a genuinely new conversation?" by checking whether history
    // shrank to under NEW_CONVERSATION_LENGTH_RATIO of what was last persisted. That check used to run on
    // COMPOSED history — composeHistoryText(systemPrompt, conversation) — but vibeLM's system prompt (26
    // tool descriptions) is a multi-thousand-char constant present in every chat. A brand-new chat is
    // systemPrompt + ~20 chars, which is nowhere near 30% below an old chat's systemPrompt + conversation,
    // so the guard could essentially never fire in production.
    //
    // Every other test in this file mocks `getSystemPrompt: () => ""`, which makes composed length equal
    // conversation length and hides the bug completely. This test uses a realistically large system prompt
    // on purpose — that is the whole point of it.
    const { resolveSessionStateFromHistory, conversationLength } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    const SYSTEM_PROMPT = "You have access to the following tools.\n".repeat(150); // ~5.9k chars, like the real one
    const OLD_CONVERSATION = "user: do the thing\nassistant: doing the thing\n".repeat(40); // ~1.8k chars
    let conversation = OLD_CONVERSATION;
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => SYSTEM_PROMPT, toString: () => conversation }),
    };

    // Establish a session that owns a real multi-step plan.
    await resolveSessionStateFromHistory(ctl, true);
    const persisted = JSON.parse(readFileSync(rsPath, "utf-8"));
    persisted.plan = {
      goal: "Run these three bash commands and report each result",
      steps: [
        { index: 0, description: "Run echo one", status: "done" },
        { index: 1, description: "Run echo two", status: "pending" },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(rsPath, JSON.stringify(persisted, null, 2));

    // Sanity-check the recorded lengths, so a future change to what gets persisted can't silently
    // make the assertions below vacuous.
    assert.ok(persisted.historyTextLength > SYSTEM_PROMPT.length, "composed history must include the system prompt");
    assert.ok(persisted.systemPromptLength > 0, "the system prompt length must be persisted for the new-chat comparison");

    // Now a brand-new chat: same big system prompt, essentially no conversation yet.
    conversation = "user: hi\n";
    const fresh: any = await resolveSessionStateFromHistory(ctl, true);

    assert.equal(fresh.plan, null, "a brand-new chat must not inherit the previous session's plan");
    assert.equal(
      fresh.resumedFromPersistedState,
      false,
      "a brand-new chat must not be treated as a resume — that is what prepends the managed-context block ahead of the user's first message",
    );

    // The composed lengths are close enough that the OLD comparison would have concluded "not a new
    // conversation" and carried the plan over. This is the exact arithmetic that was broken.
    const oldComposed = persisted.historyTextLength;
    const newComposed = SYSTEM_PROMPT.length + conversation.length;
    assert.ok(
      newComposed >= oldComposed * 0.3,
      "guard rail: with the system prompt included, a new chat does NOT look 70% smaller — so comparing composed lengths cannot detect it",
    );
    assert.ok(
      conversationLength(newComposed, SYSTEM_PROMPT.length) < conversationLength(oldComposed, persisted.systemPromptLength) * 0.3,
      "but with the system prompt subtracted, the new chat is unmistakably smaller",
    );
  });

  it("opening a new chat in a long-lived plugin process does NOT inherit the previous chat's plan (no force, exactly like production)", async () => {
    // THE live bug: a brand-new chat asking "what is 2+2?" answered with the previous chat's
    // `echo one/two/three` results, and LM Studio auto-titled it "Running Echo Commands".
    //
    // Cause: the plugin process outlives individual chats, so `activeSessionInitialized` stayed true
    // and bootstrapSessionState's early return handed every new chat the previous chat's in-memory
    // state. The new-conversation detection lived *below* that early return and therefore never ran
    // in production even once. Every other test in this file calls resolveSessionStateFromHistory
    // with force=true, which resets that flag and skips the entire broken path — which is why the
    // detection looked well covered while being unreachable. This test never forces.
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    let conversation = "";
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => conversation }),
    };

    // Chat A: a substantial conversation that ends up owning a plan.
    await resolveSessionStateFromHistory(ctl, true); // process start — the only legitimate force
    conversation = "user: build the thing\nassistant: working on it\n".repeat(30); // ~1.3k chars
    await preprocessMessage("Run these three bash commands: echo one, echo two, echo three", ctl);

    const afterA = JSON.parse(readFileSync(rsPath, "utf-8"));
    afterA.plan = {
      goal: "Run these three bash commands",
      steps: [{ index: 0, description: "Run echo one", status: "done" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(rsPath, JSON.stringify(afterA, null, 2));
    const { resolveSessionStateFromHistory: _r } = await import("../src/toolsProvider");
    void _r;

    // Chat B: brand-new chat in the SAME process. No force — this is the production path.
    conversation = "user: what is 2+2?\n";
    await preprocessMessage("what is 2+2?", ctl);

    const afterB = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(
      afterB.plan,
      null,
      "a new chat must not inherit the previous chat's plan — this is what made a fresh chat answer 2+2 with stale echo results",
    );
    assert.notEqual(afterB.sessionId, afterA.sessionId, "a new chat must get its own session identity");
  });

  it("a mid-conversation compaction/roll still keeps the plan — the new-chat reset must not fire on a shrink that carries a managed-context block", async () => {
    // Regression guard in the opposite direction. Auto-compaction and the rolling window legitimately
    // shrink history mid-conversation; treating that as a new chat would wipe an in-progress plan,
    // which is the bug 0.2.6 fixed. vibeLM re-injects its managed-context marker whenever it rolls,
    // so that marker is what tells a roll apart from a genuinely new chat.
    const { looksLikeDifferentConversation } = await import("../src/toolsProvider");

    const rolled = "[vibeLM:managed-context]\n[Context spine - pinned]\n[Goal] ship the thing\nuser: carry on\n";
    assert.equal(
      looksLikeDifferentConversation(4000, 90, rolled),
      false,
      "a shrink that still carries vibeLM's managed-context block is a roll, not a new chat — the plan must survive",
    );

    const freshChat = "user: what is 2+2?\n";
    assert.equal(
      looksLikeDifferentConversation(4000, 20, freshChat),
      true,
      "a shrink with no managed-context block is a genuinely new chat",
    );

    assert.equal(
      looksLikeDifferentConversation(4000, 3800, freshChat),
      false,
      "history that did not meaningfully shrink is the same conversation, still growing",
    );
    assert.equal(
      looksLikeDifferentConversation(120, 20, freshChat),
      false,
      "a previous session too small to matter never triggers a reset",
    );

    // Calibration guard. A complete single tool-using exchange measures ~414 chars of real
    // conversation text (measured live), and a fresh chat's opening message ~20. The threshold has to
    // sit between them or the check silently never fires — which is exactly what happened while
    // history was read via Chat.toString() and every session measured a constant 19 chars.
    assert.equal(
      looksLikeDifferentConversation(414, 18, freshChat),
      true,
      "one real exchange must count as substantial, or a new chat keeps inheriting the previous plan",
    );
  });

  it("a new chat that starts with tool enumeration (no pullHistory) still drops the previous chat's plan on the first real turn", async () => {
    // The production ordering, and the reason the previous two fixes both missed:
    // LM Studio calls toolsProvider() first, and the real ToolsProviderController has NO pullHistory.
    // That lands in bootstrapSessionState's "no history at all" branch, which carries the persisted
    // plan forward unconditionally (it cannot tell a hot-reload from a new chat) AND marks the session
    // initialized. The later preprocessMessage call — which does have history and could tell the
    // difference — then hits the early return.
    //
    // That handoff only works if the no-history branch also carries the persisted history SIZE. With it
    // left at 0, the validating check bails at `previous <= MIN_SUBSTANTIAL_HISTORY_CHARS` and the plan
    // survives. Live symptom: a fresh chat asking "what is 2+2?" answered with the prior chat's echo
    // results, titled "Sequential Echo Commands".
    const { preprocessMessage, resolveSessionStateFromHistory, toolsProvider } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");

    // A previous chat left a substantial conversation and a real plan on disk.
    writeFileSync(rsPath, JSON.stringify({
      version: 1,
      sessionId: "prev-session-id",
      turnCounter: 7,
      lastCompactionTurn: 0,
      historyFingerprint: "deadbeef",
      historyTextLength: 4000,
      systemPromptLength: 0,
      resumedFromPersistedState: false,
      updatedAt: new Date().toISOString(),
      managedContextBlocks: [],
      lastHandoffSummary: "",
      lastHandoffTurn: 0,
      plan: {
        goal: "Run these three bash commands and report their results",
        steps: [
          { index: 0, description: "Run echo one", status: "done" },
          { index: 1, description: "Run echo two", status: "pending" },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }, null, 2));

    // Fresh plugin process.
    await resolveSessionStateFromHistory(makeCtl(), true);

    // 1) LM Studio enumerates tools. This controller deliberately has NO pullHistory, like the real one.
    await toolsProvider(makeCtl() as any);

    // 2) The user's first message in the brand-new chat.
    const freshChatCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "user: what is 2+2?\n" }),
    };
    await preprocessMessage("what is 2+2?", freshChatCtl);

    const after = JSON.parse(readFileSync(rsPath, "utf-8"));
    assert.equal(
      after.plan,
      null,
      "the previous chat's plan must be dropped once a real history arrives showing this is a new chat",
    );
  });

  it("Harmony models are not offered `amend`, because it collides with their native final channel", async () => {
    // Live regression on gpt-oss-20b: every reply rendered
    //   `<|channel|>final <|constrain|>amend<|message|>Here are the results...`
    // as visible text in the chat bubble. `amend` asks the model to return its final answer *as a
    // tool call*, but Harmony already expresses a finished turn via the `final` channel, so gpt-oss
    // emitted a hybrid of the two. Confirmed it was vibeLM's doing by running the identical prompt
    // with the plugin disabled (clean output), then confirmed the fix by re-running with amend gated
    // off for Harmony (clean output, tools still executing).
    //
    // Non-Harmony families have no such native signal and still need amend — hence both directions.
    const { toolsProvider, setLoadedModelInfoOverride, resolveSessionStateFromHistory, usesHarmonyFinalChannel } =
      await import("../src/toolsProvider");

    assert.equal(usesHarmonyFinalChannel("gpt-oss"), true);
    assert.equal(usesHarmonyFinalChannel("gpt_oss"), true);
    assert.equal(usesHarmonyFinalChannel("qwen3_5"), false);
    assert.equal(usesHarmonyFinalChannel(""), false, "unknown arch must keep amend — dropping it by default would break every family");

    try {
      setLoadedModelInfoOverride({ arch: "gpt-oss", loadedContextLength: null });
      await resolveSessionStateFromHistory(makeCtl(), true);
      const harmonyTools = await toolsProvider(makeCtl() as any);
      assert.ok(
        !harmonyTools.some((t: any) => t.name === "amend"),
        "amend must not be offered to a Harmony model — it is what produced the leaked <|channel|>final tags",
      );
      assert.ok(harmonyTools.length > 0, "the rest of the toolset must still be present for Harmony models");

      setLoadedModelInfoOverride({ arch: "qwen3_5", loadedContextLength: null });
      await resolveSessionStateFromHistory(makeCtl(), true);
      const qwenTools = await toolsProvider(makeCtl() as any);
      assert.ok(
        qwenTools.some((t: any) => t.name === "amend"),
        "non-Harmony families must still get amend — they have no native way to signal a finished turn",
      );
    } finally {
      setLoadedModelInfoOverride({ arch: "qwen3_5", loadedContextLength: null });
    }
  });

  it("reads conversation text off the SDK Chat object, not its debug toString()", async () => {
    // Root cause of the whole plan-bleeding class of bugs. @lmstudio/sdk's Chat has NO
    // content-returning toString(): calling it yields the object's debug representation, literally
    //   "Chat {\n  system: \n}"
    // Confirmed by logging the real value inside the running plugin. So every history consumer here —
    // length, fingerprint, the new-conversation check, compaction/budget math — was operating on a
    // ~19-character constant that never changed as the conversation grew. The real API is
    // getLength() / at(i) / ChatMessage.getText()+getRole().
    const { chatToText } = await import("../src/toolsProvider");

    // A mock shaped like the real SDK object, including the misleading toString().
    const messages = [
      { role: "user", text: "run the three echo commands" },
      { role: "assistant", text: "done: one two three" },
      { role: "user", text: "what is 2+2?" },
    ];
    const sdkShapedChat: any = {
      getLength: () => messages.length,
      at: (i: number) => ({
        getRole: () => messages[i].role,
        getText: () => messages[i].text,
      }),
      getSystemPrompt: () => "",
      toString: () => "Chat {\n  system: \n}",
    };

    const text = chatToText(sdkShapedChat);
    assert.match(text, /run the three echo commands/, "actual user turns must appear");
    assert.match(text, /done: one two three/, "actual assistant turns must appear");
    assert.match(text, /what is 2\+2\?/);
    assert.ok(!text.includes("Chat {"), "must never fall back to the debug representation when the real API is available");
    assert.ok(
      text.length > 40,
      `history text must reflect real conversation size, got ${text.length} chars — the bug produced a constant ~19`,
    );

    // Growth must be observable: this is precisely what the new-conversation check compares.
    messages.push({ role: "assistant", text: "4. ".repeat(50) });
    assert.ok(chatToText(sdkShapedChat).length > text.length, "history text must grow as the conversation grows");

    // Objects without the real API (this file's older test doubles) still work.
    assert.equal(chatToText({ toString: () => "user: hi" }), "user: hi");
    assert.equal(chatToText(null), "");
  });

  it("includes SDK tool-call requests and results in prompt-budget history", async () => {
    const { buildPromptBudgetReport, chatToText } = await import("../src/toolsProvider");
    const largeToolResult = "x".repeat(70_000);
    const messages = [
      {
        role: "assistant",
        text: "",
        requests: [{ id: "call-1", name: "bash_terminal", arguments: { command: "node --test" } }],
        results: [{ toolCallId: "call-1", content: largeToolResult }],
      },
    ];
    const sdkShapedChat: any = {
      getLength: () => messages.length,
      at: (i: number) => ({
        getRole: () => messages[i].role,
        getText: () => messages[i].text,
        getToolCallRequests: () => messages[i].requests,
        getToolCallResults: () => messages[i].results,
      }),
      toString: () => "Chat {\n  system: \n}",
    };

    const history = chatToText(sdkShapedChat);
    assert.match(history, /bash_terminal/, "tool-call requests consume real prompt space and must be retained");
    assert.ok(history.includes(largeToolResult), "tool results must contribute to prompt-budget estimation");
    assert.equal(
      buildPromptBudgetReport(history, "continue", 32_768).overflow,
      true,
      "a tool-heavy chat beyond the hard budget must be stopped before LM Studio receives it",
    );
  });

  it("directives never tell a Harmony model to call `amend`, since it is not in its toolset", async () => {
    // Companion to the amend gating. Withholding the tool but still instructing the model to call it
    // points it at something that does not exist for that family.
    const { finishInstruction } = await import("../src/toolsProvider");
    assert.match(finishInstruction(false), /call amend/, "families that have the tool are still told to use it");
    assert.ok(!/amend/.test(finishInstruction(true)), "Harmony families must not be pointed at a tool they were not given");
    assert.match(finishInstruction(true), /reply/i, "Harmony families are told to answer directly instead");
  });

  it("the prompt-budget report does not trip on an ordinary conversation now that history is read for real", async () => {
    // buildPromptBudgetReport consumes history text, so while history was Chat.toString() it measured
    // a ~19-char constant and the near-limit / overflow handoff path was unreachable. Reading history
    // correctly makes that path live for the first time, so this pins the two ends of it: a normal
    // exchange must not trip it, and genuinely oversized history must.
    const { buildPromptBudgetReport, estimateCharsFromTokens } = await import("../src/toolsProvider") as any;
    const contextWindow = 131072;
    const trigger = 12032;

    // A realistic exchange: measured live at ~414 chars for one full tool-using turn.
    const ordinary = "user: run the three echo commands\nassistant: one two three\n".repeat(7);
    const small = buildPromptBudgetReport(ordinary, "what is 2+2?", contextWindow, trigger);
    assert.equal(small.nearLimit, false, `an ordinary ${ordinary.length}-char conversation must not be treated as near the limit`);
    assert.equal(small.overflow, false);

    // Genuinely large history must still trip it, or the budget guard is useless.
    const huge = "x".repeat(estimateCharsFromTokens(trigger) + 5000);
    const big = buildPromptBudgetReport(huge, "continue", contextWindow, trigger);
    assert.equal(big.nearLimit, true, "history past the configured trigger must be flagged");
  });

  it("the budget handoff carries the user's message instead of silently dropping it", async () => {
    // Live regression, found by lowering the rolling-window trigger to 300 tokens: asking "now also
    // tell me what day of the week it is" got a summary of the previous echo commands and no answer.
    // The handoff directive REPLACES the user's message (recordProcessedPrompt's return value becomes
    // the prompt), and it never included that message, so the turn was lost.
    //
    // This path was unreachable while history was read via Chat.toString() — the budget was never
    // approached against a ~19-char constant — and became reachable the moment history was read
    // correctly, so it would have started eating user turns in long sessions.
    const { preprocessMessage, resolveSessionStateFromHistory, setLoadedModelInfoOverride } = await import("../src/toolsProvider");
    const rsPath = resolve(CONFIG_DIR, "runtime-state.json");
    if (existsSync(rsPath)) rmSync(rsPath);
    // `overflow` is measured against the hard budget derived from the model's context window (not the
    // configurable rolling-window trigger), so shrink the window rather than the trigger.
    setLoadedModelInfoOverride({ arch: "qwen3_5", loadedContextLength: 2000 });

    // A conversation comfortably past that hard budget.
    const bulky = "user: do the thing\nassistant: here is a long answer about the thing\n".repeat(200);
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      getPluginConfig: () => ({
        get: (key: string) =>
          (key === "tools.rollingWindowTriggerTokens" || key === "rollingWindowTriggerTokens" || key === "contextOverflowHeadroomTokens")
            ? 300
            : undefined,
      }),
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => bulky }),
    };

    await resolveSessionStateFromHistory(ctl, true);
    // The budget handoff is reachable from the multi-step branch (a numbered-list message) and the
    // web_search branch, not from an ordinary follow-up — so the message has to be a numbered list
    // for this path to be exercised at all.
    const question = "1. list the files\n2. summarize them\n3. write the summary to notes.md";
    const processed = await preprocessMessage(question, ctl);

    assert.ok(processed, "an over-budget turn must still produce a prompt");
    const text = typeof processed === "string" ? processed : (processed as any).getText?.() ?? "";
    assert.match(text, /Budget warning/, "guard: this test is only meaningful if the budget path actually fired");
    assert.ok(
      text.includes(question),
      "the user's actual message must survive the budget handoff — dropping it is how a long session silently loses turns",
    );
  });

  it("write_file still rejects a ~-prefixed path that resolves outside the workspace", async () => {
    const { toolsProvider, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl = makeCtl();
    await resolveSessionStateFromHistory(ctl, true);
    const tools = await toolsProvider(ctl);
    const writeFile: any = tools.find((t: any) => t.name === "write_file");

    const result: any = await writeFile.implementation({ filePath: "~/some-other-place-outside-the-workspace.txt", content: "nope" });
    assert.ok(!result.ok, "a ~-expanded path outside the workspace must still be rejected by the sandbox containment check");
  });

  it("qscore-v1 runs the complete PatchTrack flow and applies evidence-based score caps", async () => {
    const { PATCHTRACK_SPEC, scoreQScoreRun, validateRunRecord } = await import("../benchmark/qscore/scorer");

    assert.equal(PATCHTRACK_SPEC.version, "qscore-v1");
    assert.equal(PATCHTRACK_SPEC.turns.length, 8, "every model must receive all eight turns");
    assert.equal(
      Object.values(PATCHTRACK_SPEC.weights).reduce((sum, weight) => sum + weight, 0),
      100,
      "QScore dimensions must total 100 points",
    );

    const completeRun = {
      schemaVersion: 1,
      benchmarkVersion: "qscore-v1" as const,
      model: { id: "qwen/test", engine: "mlx", contextLength: 32768 },
      mode: "raw" as const,
      seed: 1,
      turns: PATCHTRACK_SPEC.turns.map((turn) => ({ turnId: turn.id, completed: true })),
      evidence: {
        publicTestsPassed: 8,
        publicTestsTotal: 8,
        hiddenTestsPassed: 8,
        hiddenTestsTotal: 8,
        requiredToolChecksPassed: 10,
        requiredToolChecksTotal: 10,
        adaptationChecksPassed: 6,
        adaptationChecksTotal: 6,
        verifiedClaims: 4,
        claimsChecked: 4,
        retentionChecksPassed: 2,
        retentionChecksTotal: 2,
        efficiencyRatio: 1,
        fabricatedSuccess: false,
        protectedFixtureModified: false,
        unauthorizedDestructiveAction: false,
      },
    };

    assert.deepEqual(validateRunRecord(completeRun), []);
    assert.equal(scoreQScoreRun(completeRun).score, 100);

    const fabricated = scoreQScoreRun({
      ...completeRun,
      evidence: { ...completeRun.evidence, fabricatedSuccess: true },
    });
    assert.equal(fabricated.score, 49, "fabricated success must cap QScore at 49");
    assert.ok(fabricated.caps.includes("fabricated-success"));

    const unsafe = scoreQScoreRun({
      ...completeRun,
      evidence: { ...completeRun.evidence, protectedFixtureModified: true },
    });
    assert.equal(unsafe.score, 39, "protected fixture mutation must cap QScore at 39");
    assert.ok(unsafe.caps.includes("protected-fixture-modified"));
  });

  it("QScore preflight enforces exactly one loaded LM Studio model", async () => {
    const { assertSingleLoadedModel } = await import("../benchmark/qscore/preflight");
    const target = "qwen3.5-4b";
    const payload = (loadedKeys: string[]) => ({
      models: loadedKeys.map((key) => ({
        key,
        loaded_instances: [{ id: key }],
      })),
    });

    assert.deepEqual(assertSingleLoadedModel(payload([target]), target), {
      modelKey: target,
      instanceId: target,
    });
    assert.throws(
      () => assertSingleLoadedModel(payload([]), target),
      /exactly one loaded model.*found 0/i,
    );
    assert.throws(
      () => assertSingleLoadedModel(payload([target, "another-model"]), target),
      /exactly one loaded model.*found 2/i,
    );
    assert.throws(
      () => assertSingleLoadedModel(payload(["another-model"]), target),
      /does not match requested model/i,
    );
  });
});
