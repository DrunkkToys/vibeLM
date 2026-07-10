import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = resolve(tmpdir(), `vibelm-vibe-bridge-test-${Date.now()}`);
const CONFIG_DIR = resolve(tmpdir(), `vibelm-vibe-bridge-data-${Date.now()}`);
process.env.VIBE_LM_DATA_DIR = CONFIG_DIR;

function makeConfig() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(resolve(CONFIG_DIR, "config.json"), JSON.stringify({
    workspacePath: TEST_DIR,
    vibeBridgePrompt: "Custom configured prompt",
    vibeBridgeInterval: 120,
    vibeBridgeMaxDuration: 3600,
  }, null, 2));
}

function makeCtl() {
  return {
    getWorkingDirectory: () => TEST_DIR,
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "tools.vibe_bridge") return true;
        if (key === "tools.vibe_bridge_prompt" || key === "vibe_bridge_prompt") return "Custom configured prompt";
        if (key === "tools.vibe_bridge_interval" || key === "vibe_bridge_interval") return 120;
        if (key === "tools.vibe_bridge_maxDuration" || key === "vibe_bridge_maxDuration") return 3600;
        return undefined;
      },
    }),
  } as any;
}

describe("vibe_bridge Cascade", () => {
  before(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    makeConfig();
  });

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true });
  });

  it("should expose vibe_bridge tool from toolsProvider", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");
    assert.ok(bridge, "vibe_bridge must be present");
    assert.ok(bridge.implementation, "vibe_bridge must have implementation");
  });

  it("status action should return inactive by default", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");
    const result = await bridge.implementation({ action: "status" });
    assert.ok(result?.ok, "status should succeed");
    assert.equal(result.data.active, false, "bridge should be inactive by default");
  });

  it("stop action should succeed even when not active", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");
    const result = await bridge.implementation({ action: "stop" });
    assert.ok(result?.ok, "stop should succeed");
    assert.equal(result.data.stopped, true);
  });

  it("start action without prompt should use configured default", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");
    const result = await bridge.implementation({ action: "start" }, makeCtl());
    assert.ok(result?.ok, "start without prompt should succeed (uses default)");
    assert.equal(result.data.active, true);
    assert.ok(result.data.prompt.includes("Custom configured prompt"));
    assert.equal(result.data.interval, 120);
    assert.equal(result.data.maxDuration, 3600);

    await bridge.implementation({ action: "stop" });
  });

  it("start action with valid params should succeed", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");
    const result = await bridge.implementation({
      action: "start",
      prompt: "Continue working on the feature",
      interval: 60,
      maxDuration: 1800,
      maxIterations: 10,
    });
    assert.ok(result?.ok, "start should succeed");
    assert.equal(result.data.active, true);
    assert.equal(result.data.interval, 60);
    assert.equal(result.data.maxDuration, 1800);
    assert.equal(result.data.maxIterations, 10);

    await bridge.implementation({ action: "stop" });
  });

  it("status should reflect active state after start", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");
    await bridge.implementation({
      action: "start",
      prompt: "Status check test",
      interval: 120,
      maxDuration: 3600,
    });
    const status = await bridge.implementation({ action: "status" });
    assert.equal(status.data.active, true);
    assert.equal(status.data.interval, 120);
    assert.equal(status.data.maxDuration, 3600);
    assert.ok(status.data.prompt.includes("Status check test"));
    assert.ok(typeof status.data.elapsed === "number");
    assert.ok(typeof status.data.remaining === "number");

    await bridge.implementation({ action: "stop" });
  });

  it("starting a new bridge should replace the previous one", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await bridge.implementation({ action: "start", prompt: "First bridge", interval: 30, maxDuration: 600 });
    const result = await bridge.implementation({ action: "start", prompt: "Second bridge", interval: 60, maxDuration: 1200 });
    assert.ok(result?.ok, "second start should succeed");

    const status = await bridge.implementation({ action: "status" });
    assert.ok(status.data.prompt.includes("Second bridge"), "should reflect the new bridge");
    assert.equal(status.data.interval, 60);
    assert.equal(status.data.maxDuration, 1200);

    await bridge.implementation({ action: "stop" });
  });

  it("should be toggleable via plugin config", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const toolNames = tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("vibe_bridge"), "vibe_bridge should be in exposed tools when enabled via config");
  });

  it("should auto-stop after 3 consecutive tick failures instead of retrying forever", async () => {
    const failingClient = {
      llm: {
        listLoaded: async () => [{
          act: async () => { throw new Error("simulated tick failure"); },
          complete: async () => ({ content: "" }),
        }],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl(), failingClient);
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await bridge.implementation({ action: "start", prompt: "Will keep failing", interval: 5 });

    // 3 consecutive failures at the minimum 5s interval, plus margin for scheduling jitter.
    await new Promise((r) => setTimeout(r, 17000));

    const status = await bridge.implementation({ action: "status" });
    assert.equal(status.data.active, false, "bridge should have auto-stopped");
    assert.equal(status.data.consecutiveFailures, 3, "should have recorded 3 consecutive failures");
    assert.equal(status.data.stoppedAfterFailures, true, "status should indicate it stopped due to failures");
  });

  it("should cap model.act() rounds and set a timeout signal on each tick", async () => {
    let capturedOpts: any = undefined;
    const capturingClient = {
      llm: {
        listLoaded: async () => [{
          act: async (_chat: any, _tools: any, opts: any) => { capturedOpts = opts; },
          complete: async () => ({ content: "" }),
        }],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl(), capturingClient);
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await bridge.implementation({ action: "start", prompt: "Capture opts test", interval: 5 });

    // Wait for at least one tick to fire at the minimum 5s interval, plus margin for scheduling jitter.
    await new Promise((r) => setTimeout(r, 7000));

    await bridge.implementation({ action: "stop" });

    assert.ok(capturedOpts, "model.act() should have been called with an opts argument");
    assert.equal(capturedOpts.maxPredictionRounds, 8, "tick should cap prediction rounds so a stuck non-tool-calling loop can't run unbounded");
    assert.ok(capturedOpts.signal instanceof AbortSignal, "tick should pass an AbortSignal so a stuck tick can't block subsequent ticks");
  });

  it("should auto-start when enabled in plugin settings, without an explicit start call", async () => {
    const idleClient = {
      llm: {
        listLoaded: async () => [],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl(), idleClient);
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    // No "start" action called here — enabling the tool via config should be enough.
    const status = await bridge.implementation({ action: "status" });
    assert.equal(status.data.active, true, "bridge should auto-start when tools.vibe_bridge is enabled");
    assert.equal(status.data.interval, 120, "should use the configured default interval");
    assert.equal(status.data.maxDuration, 3600, "should use the configured default maxDuration");

    await bridge.implementation({ action: "stop" });
  });

  it("should not double-start (and reset state) when toolsProvider is invoked again while already active", async () => {
    const idleClient = {
      llm: {
        listLoaded: async () => [],
      },
    } as any;

    const { toolsProvider } = await import("../src/toolsProvider");
    let tools = await toolsProvider(makeCtl(), idleClient);
    let bridge = tools.find((t: any) => t.name === "vibe_bridge");
    const first = await bridge.implementation({ action: "status" });
    assert.equal(first.data.active, true);
    const firstIteration = first.data.iteration;

    // Simulate a second session/request reusing the same running plugin process.
    tools = await toolsProvider(makeCtl(), idleClient);
    bridge = tools.find((t: any) => t.name === "vibe_bridge");
    const second = await bridge.implementation({ action: "status" });
    assert.equal(second.data.active, true, "should still be active, not restarted from scratch");
    assert.equal(second.data.iteration, firstIteration, "already-active bridge should be left alone, not reset");

    await bridge.implementation({ action: "stop" });
  });
});
