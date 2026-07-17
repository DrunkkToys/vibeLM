import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = resolve(tmpdir(), `vibelm-plan-test-${Date.now()}`);
const CONFIG_DIR = resolve(tmpdir(), `vibelm-plan-data-${Date.now()}`);
process.env.VIBE_LM_DATA_DIR = CONFIG_DIR;

function makeConfig() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(resolve(CONFIG_DIR, "config.json"), JSON.stringify({ workspacePath: TEST_DIR }, null, 2));
}

// IMPORTANT: readPluginConfigValue returning a real boolean for ANY "tools.<name>" key flips
// resolveEnabledToolNames into "explicit toggles only" mode, which silently drops every other
// default-enabled tool (create_plan/update_plan_step/get_plan included) that this file didn't
// explicitly answer. Only answer booleans for the specific tool names a test needs on; leave
// everything else `undefined` so defaults apply.
function makeCtl(overrides: { vibeBridgeEnabled?: boolean } = {}) {
  return {
    getWorkingDirectory: () => TEST_DIR,
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "tools.vibe_bridge_prompt" || key === "vibe_bridge_prompt") return "Custom configured prompt";
        if (key === "tools.vibe_bridge_interval" || key === "vibe_bridge_interval") return 120;
        if (key === "tools.vibe_bridge_maxDuration" || key === "vibe_bridge_maxDuration") return 3600;
        if (overrides.vibeBridgeEnabled) {
          if (key === "tools.vibe_bridge") return true;
          if (key === "tools.create_plan") return true;
          if (key === "tools.update_plan_step") return true;
          if (key === "tools.get_plan") return true;
        }
        return undefined;
      },
    }),
  } as any;
}

// Safety net: _bridgeActive/_bridgeTimer are module-level singletons shared across every test in
// this process. If a test throws before reaching its own `stop` call, an auto-started bridge would
// otherwise keep firing forever (real setTimeout ticks) and hang the whole test run. Force-stop
// after every test regardless of outcome.
async function stopAnyActiveBridge() {
  const { toolsProvider } = await import("../src/toolsProvider");
  const cleanupCtl = {
    getWorkingDirectory: () => TEST_DIR,
    getPluginConfig: () => ({ get: (key: string) => (key === "tools.vibe_bridge" ? true : undefined) }),
  } as any;
  const tools = await toolsProvider(cleanupCtl);
  const bridge = tools.find((t: any) => t.name === "vibe_bridge");
  if (bridge) await bridge.implementation({ action: "stop" });
}

describe("plan execution", () => {
  before(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    makeConfig();
  });

  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    // Each test expects a clean plan/session slate. toolsProvider() itself no longer force-resets
    // state on every call (that was the live-testing bug fixed in src/toolsProvider.ts — it discarded
    // real session continuity every turn in production), so tests must reset explicitly instead.
    // Also delete any persisted runtime-state.json left by the previous test: bootstrapSessionState's
    // "no history at all" path now legitimately carries over a persisted plan (fixed a live bug where a
    // hot-reloaded/restarted process dropped an in-progress plan instead), so a stale plan on disk
    // would otherwise leak into this "clean slate" the same way it would in a real restart.
    const runtimeStatePath = resolve(CONFIG_DIR, "runtime-state.json");
    if (existsSync(runtimeStatePath)) rmSync(runtimeStatePath);
    const { resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    await resolveSessionStateFromHistory(makeCtl(), true);
  });

  afterEach(async () => {
    await stopAnyActiveBridge();
  });

  after(async () => {
    await stopAnyActiveBridge();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true });
  });

  it("exposes create_plan, update_plan_step, and get_plan by default", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const names = tools.map((t: any) => t.name);
    assert.ok(names.includes("create_plan"));
    assert.ok(names.includes("update_plan_step"));
    assert.ok(names.includes("get_plan"));
  });

  it("create_plan stores an ordered list of pending steps, visible via get_plan", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const getPlan = tools.find((t: any) => t.name === "get_plan");

    const created = await createPlan.implementation({
      goal: "Set up a nightly backup",
      steps: ["Check what's installed", "Write backup script", "Register cron entry"],
      autoStart: false,
    });
    assert.ok(created.ok, "create_plan should succeed");
    assert.equal(created.data.plan.goal, "Set up a nightly backup");
    assert.equal(created.data.plan.steps.length, 3);
    assert.ok(created.data.plan.steps.every((s: any) => s.status === "pending"));

    const fetched = await getPlan.implementation({});
    assert.ok(fetched.ok);
    assert.equal(fetched.data.plan.steps.length, 3);
  });

  it("update_plan_step transitions a step's status and rejects an out-of-range index", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const updateStep = tools.find((t: any) => t.name === "update_plan_step");
    const getPlan = tools.find((t: any) => t.name === "get_plan");

    await createPlan.implementation({ goal: "Two-step task", steps: ["Step one", "Step two"], autoStart: false });

    const updated = await updateStep.implementation({ index: 0, status: "done" });
    assert.ok(updated.ok);
    assert.equal(updated.data.plan.steps[0].status, "done");

    const blocked = await updateStep.implementation({ index: 1, status: "blocked", note: "waiting on credentials" });
    assert.ok(blocked.ok);
    assert.equal(blocked.data.plan.steps[1].status, "blocked");
    assert.equal(blocked.data.plan.steps[1].note, "waiting on credentials");

    const invalid = await updateStep.implementation({ index: 9, status: "done" });
    assert.equal(invalid.ok, false, "an out-of-range step index should fail");

    const fetched = await getPlan.implementation({});
    assert.equal(fetched.data.plan.steps[0].status, "done");
    assert.equal(fetched.data.plan.steps[1].status, "blocked");
  });

  it("update_plan_step fails clearly when no plan exists yet", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const updateStep = tools.find((t: any) => t.name === "update_plan_step");
    const result = await updateStep.implementation({ index: 0, status: "done" });
    assert.equal(result.ok, false);
    assert.match(result.error, /No active plan/);
  });

  it("amend rejects finishing while the plan has untouched pending steps, and succeeds once they're resolved", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const updateStep = tools.find((t: any) => t.name === "update_plan_step");
    const amend = tools.find((t: any) => t.name === "amend");

    await createPlan.implementation({ goal: "One-step task", steps: ["Do the one thing"], autoStart: false });

    const rejected = await amend.implementation({ text: "All done, here is a concrete summary of the work." });
    assert.equal(rejected.ok, false, "amend should refuse to finish with an untouched plan step");
    assert.match(rejected.error, /untouched step/);

    await updateStep.implementation({ index: 0, status: "done" });
    const accepted = await amend.implementation({ text: "All done, here is a concrete summary of the work." });
    assert.ok(accepted.ok, "amend should succeed once the plan's steps are resolved");
  });

  it("amend does not block on plan steps that are in_progress or blocked, only pending/untouched ones", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const updateStep = tools.find((t: any) => t.name === "update_plan_step");
    const amend = tools.find((t: any) => t.name === "amend");

    await createPlan.implementation({ goal: "Blocked task", steps: ["Do a thing"], autoStart: false });
    await updateStep.implementation({ index: 0, status: "blocked", note: "missing credentials" });

    const result = await amend.implementation({ text: "Blocked on credentials, here is the concrete status." });
    assert.ok(result.ok, "amend should allow handoff for a step the model genuinely attempted and got blocked on");
  });

  it("create_plan with autoStart starts vibe_bridge when it's enabled", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ vibeBridgeEnabled: true }));
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    const result = await createPlan.implementation({ goal: "Long running task", steps: ["Step one"] });
    assert.equal(result.data.bridgeStarted, true);

    const status = await bridge.implementation({ action: "status" });
    assert.equal(status.data.active, true);

    await bridge.implementation({ action: "stop" });
  });

  it("create_plan does not auto-start vibe_bridge when it's disabled", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ vibeBridgeEnabled: false }));
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    assert.ok(!tools.some((t: any) => t.name === "vibe_bridge"), "vibe_bridge should not be exposed when disabled");

    const result = await createPlan.implementation({ goal: "Task without bridge", steps: ["Step one"] });
    assert.equal(result.data.bridgeStarted, false, "create_plan should not have started vibe_bridge while it's disabled");
  });

  it("vibe_bridge tick prompt names the next pending plan step", async () => {
    let capturedChat: any = undefined;
    const capturingClient = {
      llm: {
        listLoaded: async () => [{
          act: async (chat: any) => { capturedChat = chat; },
          complete: async () => ({ content: "" }),
        }],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ vibeBridgeEnabled: true }), capturingClient);
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await createPlan.implementation({ goal: "Ticked plan", steps: ["Write the config file"], autoStart: false });
    await bridge.implementation({ action: "start", prompt: "Keep going", interval: 5 });

    await new Promise((r) => setTimeout(r, 7000));
    await bridge.implementation({ action: "stop" });

    assert.ok(capturedChat, "model.act() should have been called with a chat");
    const serialized = typeof capturedChat.toString === "function" ? capturedChat.toString() : JSON.stringify(capturedChat);
    assert.match(serialized, /Write the config file/, "the tick prompt should name the pending plan step");
  });

  it("vibe_bridge ticks include create_plan in their tool list (live-testing regression: create_plan was previously excluded from ticks under the assumption plans are only 'created interactively', but real models reproducibly never call create_plan from the interactive channel either — leaving an unattended tick permanently stuck with an empty plan.steps and no tool available to fix it)", async () => {
    let capturedTools: any = undefined;
    const capturingClient = {
      llm: {
        listLoaded: async () => [{
          act: async (_chat: any, tools: any) => { capturedTools = tools; },
          complete: async () => ({ content: "" }),
        }],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ vibeBridgeEnabled: true }), capturingClient);
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await bridge.implementation({ action: "start", prompt: "Keep going", interval: 5 });
    await new Promise((r) => setTimeout(r, 7000));
    await bridge.implementation({ action: "stop" });

    assert.ok(capturedTools, "model.act() should have been called with a tools list");
    assert.ok(capturedTools.some((t: any) => t.name === "create_plan"), "a tick must be able to create a plan itself when it finds none/an empty one, instead of being permanently stuck");
  });

  it("vibe_bridge tick directs the model to call create_plan when the plan has a goal but zero steps, instead of emitting an empty directive (live-testing regression: plan && nextStep was always false when steps was empty — found via runtime-state.json in production, a real 4-day-old plan with steps:[] — so planDirective silently evaluated to the empty string and ticks got zero plan guidance)", async () => {
    let capturedChat: any = undefined;
    const capturingClient = {
      llm: {
        listLoaded: async () => [{
          act: async (chat: any) => { capturedChat = chat; },
          complete: async () => ({ content: "" }),
        }],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl({ vibeBridgeEnabled: true }), capturingClient);
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    // create_plan's schema requires at least one step, so it can't produce a goal-only/zero-step plan
    // directly — drive the same auto-seed-goal path a real session takes instead (preprocessMessageCore
    // sets goal + empty steps from the first substantive message, exactly what produced the 4-day-old
    // "can u finish the job?" / steps:[] plan found live in production runtime-state.json).
    const { preprocessMessage, resolveSessionStateFromHistory } = await import("../src/toolsProvider");
    const seedCtl: any = {
      getWorkingDirectory: () => TEST_DIR,
      pullHistory: async () => ({ getSystemPrompt: () => "", toString: () => "Turn 1: can u finish the job?" }),
    };
    await resolveSessionStateFromHistory(seedCtl, true);
    await preprocessMessage("can u finish the job?", seedCtl);

    await bridge.implementation({ action: "start", prompt: "Keep going", interval: 5 });
    await new Promise((r) => setTimeout(r, 7000));
    await bridge.implementation({ action: "stop" });

    assert.ok(capturedChat, "model.act() should have been called with a chat");
    const serialized = typeof capturedChat.toString === "function" ? capturedChat.toString() : JSON.stringify(capturedChat);
    assert.match(serialized, /create_plan/, "a stepless plan must direct the tick to create one, not emit an empty directive");
    assert.match(serialized, /can u finish the job/, "the directive must reference the actual recorded goal");
  });

  it("vibe_bridge tick carries the current step's note and established facts forward instead of starting every round cold (live-testing regression: each tick built a brand-new isolated Chat with only a vague summary of the human's last chat messages — never anything a prior tick learned — because buildContextSpine already existed for exactly this but was only ever wired into the interactive preprocessMessage path)", async () => {
    let capturedChat: any = undefined;
    const capturingClient = {
      llm: {
        listLoaded: async () => [{
          act: async (chat: any) => { capturedChat = chat; },
          complete: async () => ({ content: "" }),
        }],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const { SessionLog } = await import("../src/sessionLog");
    const tools = await toolsProvider(makeCtl({ vibeBridgeEnabled: true }), capturingClient);
    const createPlan = tools.find((t: any) => t.name === "create_plan");
    const updateStep = tools.find((t: any) => t.name === "update_plan_step");
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await createPlan.implementation({
      goal: "Multi-step tick task",
      steps: ["First step: half-finished by a prior tick", "Second step: not started"],
      autoStart: false,
    });
    // Simulate a prior tick that got partway through step 0 and left a note for the next round.
    await updateStep.implementation({ index: 0, status: "in_progress", note: "found the config file, still need to update the port" });

    // Simulate an established fact a prior tick's tool call would have produced (mirrors what
    // wrapTool's distillToolFact already writes for real tool calls — session-log.jsonl is the same
    // file getSessionLog() reads inside the tick). Must be tagged with the CURRENT session id:
    // buildContextSpine's fact tier only falls back to session-agnostic facts when the exact-session
    // query comes back empty, and create_plan/update_plan_step above already logged their own
    // current-session facts, so a fact under an unrelated fake session id would be silently ignored.
    const currentSessionId = JSON.parse(readFileSync(resolve(CONFIG_DIR, "runtime-state.json"), "utf-8")).sessionId;
    const log = new SessionLog(resolve(CONFIG_DIR, "session-log.jsonl"));
    log.saveMemory(["fact:write_file:#tick-fact:ok", `session:${currentSessionId}`], "wrote config.yaml with port 9443", 1, currentSessionId, TEST_DIR, "workspace");

    await bridge.implementation({ action: "start", prompt: "Keep going", interval: 5 });
    await new Promise((r) => setTimeout(r, 7000));
    await bridge.implementation({ action: "stop" });

    assert.ok(capturedChat, "model.act() should have been called with a chat");
    const serialized = typeof capturedChat.toString === "function" ? capturedChat.toString() : JSON.stringify(capturedChat);
    assert.match(serialized, /still need to update the port/, "the current step's note from a prior tick must carry forward");
    assert.match(serialized, /port 9443/, "an established fact from a prior tick's tool call must be pinned into the next tick's context");
  });
});
