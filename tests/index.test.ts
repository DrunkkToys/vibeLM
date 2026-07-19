import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Regression guard for the v0.2.9–0.2.11 main-chat regression: registering a
// withPredictionLoopHandler takes ownership of the entire generation loop, including the parts
// LM Studio's default loop handles for free. The handler rendered every prediction fragment as
// visible assistant text without checking `fragment.reasoningType`, so reasoning prose and raw
// <think>/</think> tags leaked into the chat bubble on every thinking model. (The buffered-text
// regexes in stripModelArtifacts cannot fix that: THINK_BLOCK needs both tags in one string, and
// streaming delivers them in separate fragments.)
//
// Reverting to withToolsProvider hands rendering, reasoning-channel routing, and tool-call
// parsing back to LM Studio. The two registrations are mutually exclusive — the SDK throws
// "PredictionLoopHandler cannot be used with a tools provider" if both are present — so asserting
// both counts guards against either half being reintroduced.
function makePluginContextSpy() {
  const calls = {
    withToolsProvider: 0,
    withPredictionLoopHandler: 0,
    withPromptPreprocessor: 0,
    withConfigSchematics: 0,
  };
  const context: any = {
    withConfigSchematics: () => { calls.withConfigSchematics++; return context; },
    withGlobalConfigSchematics: () => context,
    withToolsProvider: () => { calls.withToolsProvider++; return context; },
    withPredictionLoopHandler: () => { calls.withPredictionLoopHandler++; return context; },
    withPromptPreprocessor: () => { calls.withPromptPreprocessor++; return context; },
    withGenerator: () => context,
  };
  return { context, calls };
}

describe("index.ts main() registration", () => {
  it("registers withToolsProvider exactly once, so LM Studio owns the generation loop", async () => {
    const { main } = await import("../src/index");
    const { context, calls } = makePluginContextSpy();
    await main(context);
    assert.equal(calls.withToolsProvider, 1);
  });

  it("never registers withPredictionLoopHandler, which leaks reasoning fragments into the chat", async () => {
    const { main } = await import("../src/index");
    const { context, calls } = makePluginContextSpy();
    await main(context);
    assert.equal(
      calls.withPredictionLoopHandler,
      0,
      "withPredictionLoopHandler must not be registered: it renders reasoningType fragments as visible chat text",
    );
  });

  it("registers config schematics and the prompt preprocessor", async () => {
    const { main } = await import("../src/index");
    const { context, calls } = makePluginContextSpy();
    await main(context);
    assert.equal(calls.withConfigSchematics, 1);
    assert.equal(calls.withPromptPreprocessor, 1);
  });
});
