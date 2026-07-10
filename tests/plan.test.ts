import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
});
