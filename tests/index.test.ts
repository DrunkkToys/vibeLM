import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Regression guard for the exact bug caught only by live testing: @lmstudio/sdk throws
// "PredictionLoopHandler cannot be used with a tools provider" if a plugin registers both
// withToolsProvider and withPredictionLoopHandler — this crashed main() entirely and the plugin
// never initialized. Nothing in tests/predictionLoop.test.ts or tests/cascade.test.ts touches
// src/index.ts's registration wiring (they call toolsProvider()/predictionLoopHandler() directly
// as plain functions), so this was the one place a silent re-regression could ship unnoticed.
function makePluginContextSpy() {
  const calls: { withToolsProvider: number; withPredictionLoopHandler: number; withPromptPreprocessor: number; withConfigSchematics: number } = {
    withToolsProvider: 0, withPredictionLoopHandler: 0, withPromptPreprocessor: 0, withConfigSchematics: 0,
  };
  const context: any = {
    withConfigSchematics: (...args: any[]) => { calls.withConfigSchematics++; return context; },
    withGlobalConfigSchematics: (...args: any[]) => context,
    withToolsProvider: (...args: any[]) => { calls.withToolsProvider++; return context; },
    withPredictionLoopHandler: (...args: any[]) => { calls.withPredictionLoopHandler++; return context; },
    withPromptPreprocessor: (...args: any[]) => { calls.withPromptPreprocessor++; return context; },
    withGenerator: (...args: any[]) => context,
  };
  return { context, calls };
}

describe("index.ts main() registration", () => {
  it("never calls withToolsProvider, since it is mutually exclusive with withPredictionLoopHandler and crashes plugin init if both are registered", async () => {
    const { main } = await import("../src/index");
    const { context, calls } = makePluginContextSpy();
    await main(context);
    assert.equal(calls.withToolsProvider, 0, "withToolsProvider must never be registered alongside withPredictionLoopHandler");
  });

  it("registers withPredictionLoopHandler exactly once", async () => {
    const { main } = await import("../src/index");
    const { context, calls } = makePluginContextSpy();
    await main(context);
    assert.equal(calls.withPredictionLoopHandler, 1);
  });

  it("registers config schematics and the prompt preprocessor", async () => {
    const { main } = await import("../src/index");
    const { context, calls } = makePluginContextSpy();
    await main(context);
    assert.equal(calls.withConfigSchematics, 1);
    assert.equal(calls.withPromptPreprocessor, 1);
  });
});
