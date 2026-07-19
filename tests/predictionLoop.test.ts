import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = resolve(tmpdir(), `vibelm-prediction-loop-test-${Date.now()}`);
const CONFIG_DIR = resolve(tmpdir(), `vibelm-prediction-loop-data-${Date.now()}`);
process.env.VIBE_LM_DATA_DIR = CONFIG_DIR;

function makeConfig() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(resolve(CONFIG_DIR, "config.json"), JSON.stringify({ workspacePath: TEST_DIR }, null, 2));
}

// Minimal fake ChatMessage-like object satisfying what predictionLoopHandler reads off of it.
function makeAssistantMessage() {
  return { getRole: () => "assistant", isUserMessage: () => false };
}

function makeFakeChat() {
  return [makeAssistantMessage()];
}

function makeCtl(overrides: { maxOrchestratorTurns?: number; enforceMainChatBounds?: boolean; act: (...args: any[]) => Promise<any> }) {
  const toolStatuses: any[] = [];
  const contentBlockCalls: { appendText: string[]; appendToolRequest: any[]; appendToolResult: any[] } = {
    appendText: [], appendToolRequest: [], appendToolResult: [],
  };
  const confirmCalls: any[] = [];
  const ctl = {
    abortSignal: new AbortController().signal,
    getWorkingDirectory: () => TEST_DIR,
    getPluginConfig: () => ({
      get: (key: string) => {
        if (key === "tools.maxOrchestratorTurns" || key === "maxOrchestratorTurns") return overrides.maxOrchestratorTurns;
        if (key === "tools.enforceMainChatBounds" || key === "enforceMainChatBounds") return overrides.enforceMainChatBounds;
        return undefined;
      },
    }),
    pullHistory: async () => makeFakeChat(),
    tokenSource: async () => ({ act: overrides.act }),
    createContentBlock: () => ({
      appendText: (t: string) => contentBlockCalls.appendText.push(t),
      appendToolRequest: (o: any) => contentBlockCalls.appendToolRequest.push(o),
      appendToolResult: (o: any) => contentBlockCalls.appendToolResult.push(o),
    }),
    createToolStatus: (_callId: number, initial: any) => {
      const status = { current: initial, setStatus: (s: any) => { status.current = s; } };
      toolStatuses.push(status);
      return status;
    },
    requestConfirmToolCall: async (opts: any) => {
      confirmCalls.push(opts);
      return { type: "allow" };
    },
  };
  return { ctl: ctl as any, contentBlockCalls, confirmCalls, toolStatuses };
}

describe("predictionLoopHandler Cascade", () => {
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

  it("passes a real maxPredictionRounds cap (from maxOrchestratorTurns) into .act() when bounds are enforced", async () => {
    const { predictionLoopHandler } = await import("../src/toolsProvider");
    let capturedOpts: any = null;
    const { ctl } = makeCtl({
      maxOrchestratorTurns: 5,
      act: async (_chat, _tools, opts) => { capturedOpts = opts; return {}; },
    });
    await predictionLoopHandler(ctl);
    assert.equal(capturedOpts.maxPredictionRounds, 5, "the round cap must actually reach .act(), not just be reported");
    assert.equal(capturedOpts.signal, ctl.abortSignal);
  });

  it("leaves maxPredictionRounds unset when tools.enforceMainChatBounds is false (escape hatch)", async () => {
    const { predictionLoopHandler } = await import("../src/toolsProvider");
    let capturedOpts: any = null;
    const { ctl } = makeCtl({
      maxOrchestratorTurns: 5,
      enforceMainChatBounds: false,
      act: async (_chat, _tools, opts) => { capturedOpts = opts; return {}; },
    });
    await predictionLoopHandler(ctl);
    assert.equal(capturedOpts.maxPredictionRounds, undefined);
  });

  it("streams prediction fragments into the assistant content block", async () => {
    const { predictionLoopHandler } = await import("../src/toolsProvider");
    const { ctl, contentBlockCalls } = makeCtl({
      maxOrchestratorTurns: 5,
      act: async (_chat, _tools, opts) => {
        opts.onPredictionFragment({ content: "hello ", roundIndex: 0 });
        opts.onPredictionFragment({ content: "world", roundIndex: 0 });
        return {};
      },
    });
    await predictionLoopHandler(ctl);
    assert.deepEqual(contentBlockCalls.appendText, ["hello ", "world"]);
  });

  it("routes guardToolCall through ctl.requestConfirmToolCall and allows on approval", async () => {
    const { predictionLoopHandler } = await import("../src/toolsProvider");
    const { ctl, confirmCalls } = makeCtl({
      maxOrchestratorTurns: 5,
      act: async (_chat, _tools, opts) => {
        let allowed = false;
        await opts.guardToolCall(0, 1, {
          tool: { name: "write_file" },
          toolCallRequest: { arguments: { path: "x" } },
          allow: () => { allowed = true; },
          deny: () => { throw new Error("should not deny"); },
        });
        assert.equal(allowed, true);
        return {};
      },
    });
    await predictionLoopHandler(ctl);
    assert.equal(confirmCalls.length, 1);
    assert.equal(confirmCalls[0].name, "write_file");
  });

  it("pairs a tool result message back to its callId via FIFO ordering and appends it to the block", async () => {
    const { predictionLoopHandler } = await import("../src/toolsProvider");
    const { ctl, contentBlockCalls } = makeCtl({
      maxOrchestratorTurns: 5,
      act: async (_chat, _tools, opts) => {
        opts.onToolCallRequestFinalized(0, 42, { toolCallRequest: { id: "abc", name: "read_file", arguments: {} } });
        opts.onMessage({
          getRole: () => "tool",
          getToolCallResults: () => [{ content: "file contents", toolCallId: "abc" }],
        });
        return {};
      },
    });
    await predictionLoopHandler(ctl);
    assert.equal(contentBlockCalls.appendToolRequest.length, 1);
    assert.equal(contentBlockCalls.appendToolRequest[0].callId, 42);
    assert.equal(contentBlockCalls.appendToolResult.length, 1);
    assert.equal(contentBlockCalls.appendToolResult[0].callId, 42);
    assert.equal(contentBlockCalls.appendToolResult[0].content, "file contents");
  });
});
