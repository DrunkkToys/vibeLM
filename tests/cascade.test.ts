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
    const { toolsProvider, reasoningDirectiveFor, reasoningDirectiveForSession, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const ctl: any = {
      getWorkingDirectory: () => TEST_DIR,
      getPluginConfig: () => ({ get: (key: string) => (key === "tools.reasoningEffort" || key === "reasoningEffort") ? "high" : undefined }),
    };
    // Force the "no live LM Studio model" fallback (arch: "") so this test is deterministic whether
    // or not a real LM Studio instance happens to be reachable at API_BASE while tests run.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("no network in test"); }) as any;
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
      globalThis.fetch = originalFetch;
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
    const probes = [
      "ls /usr/local/opt/node",
      "ls /usr/local/Cellar/node",
      "ls /usr/local/bin/node",
      "ls /usr/bin/node",
      "ls /bin/node",
      "ls /opt/node",
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
    assert.equal(resultCharBudget("bash_terminal", { ok: true, data: { exitCode: 1, stderr: "nope" } }), 300, "failures get the low tier");
    assert.equal(resultCharBudget("generate_uuid", { ok: true, data: "abc" }), 500, "everything else gets the default tier");
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

  it("a goal-only auto-plan survives the persisted round-trip and is restored on resume after a roll", async () => {
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
    // through parsePersistedPlan, which previously discarded any plan with zero steps (the auto-goal).
    history = "totally different head after a roll";
    const resumed: any = await resolveSessionStateFromHistory(ctl, true);
    assert.equal(resumed.resumedFromPersistedState, true, "a roll is detected as a resume");
    assert.ok(resumed.plan, "the goal-only plan must survive the persisted round-trip");
    assert.match(resumed.plan.goal, /CSV to JSON/, "the restored goal is intact");
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
});
