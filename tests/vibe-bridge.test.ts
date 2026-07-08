import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const TEST_DIR = resolve(tmpdir(), `vibelm-vibe-bridge-test-${Date.now()}`);
const CONFIG_DIR = resolve(homedir(), ".lmstudio", "extensions", "plugins", "drunkktoys", "vibe-lm");

function makeConfig() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(resolve(CONFIG_DIR, "config.json"), JSON.stringify({ workspacePath: TEST_DIR }, null, 2));
}

function makeCtl() {
  return {
    getWorkingDirectory: () => TEST_DIR,
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "tools.vibe_bridge") return true;
        if (key === "tools.vibe_bridge.prompt") return "Custom configured prompt";
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
    const result = await bridge.implementation({ action: "start" });
    assert.ok(result?.ok, "start without prompt should succeed (uses default)");
    assert.equal(result.data.active, true);
    assert.ok(result.data.prompt.includes("Custom configured prompt"));

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
      maxIterations: 10,
    });
    assert.ok(result?.ok, "start should succeed");
    assert.equal(result.data.active, true);
    assert.equal(result.data.interval, 60);
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
    });
    const status = await bridge.implementation({ action: "status" });
    assert.equal(status.data.active, true);
    assert.equal(status.data.interval, 120);
    assert.ok(status.data.prompt.includes("Status check test"));

    await bridge.implementation({ action: "stop" });
  });

  it("starting a new bridge should replace the previous one", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const bridge = tools.find((t: any) => t.name === "vibe_bridge");

    await bridge.implementation({ action: "start", prompt: "First bridge", interval: 30 });
    const result = await bridge.implementation({ action: "start", prompt: "Second bridge", interval: 60 });
    assert.ok(result?.ok, "second start should succeed");

    const status = await bridge.implementation({ action: "status" });
    assert.ok(status.data.prompt.includes("Second bridge"), "should reflect the new bridge");
    assert.equal(status.data.interval, 60);

    await bridge.implementation({ action: "stop" });
  });

  it("should be toggleable via plugin config", async () => {
    const { toolsProvider } = await import("../src/toolsProvider");
    const tools = await toolsProvider(makeCtl());
    const toolNames = tools.map((t: any) => t.name);
    assert.ok(toolNames.includes("vibe_bridge"), "vibe_bridge should be in exposed tools when enabled via config");
  });
});
