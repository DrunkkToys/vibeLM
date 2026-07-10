import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("stripModelArtifacts", () => {
  it("strips the exact leaked gpt-oss Harmony sample found in live session transcripts", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    const leaked = "<|channel|>final <|constrain|>amend<|message|>Got it! Your workspace is now set. How can I help you today?";
    const cleaned = stripModelArtifacts(leaked);
    assert.ok(!cleaned.includes("<|"), "no Harmony control tokens should remain");
    assert.equal(cleaned, "Got it! Your workspace is now set. How can I help you today?");
  });

  it("strips analysis/final channel pairs with an intermediate <|end|><|start|>assistant boundary", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    const leaked = "<|channel|>analysis<|message|>thinking about it<|end|><|start|>assistant<|channel|>final<|message|>Here is the answer";
    const cleaned = stripModelArtifacts(leaked);
    assert.ok(!cleaned.includes("<|"), "no Harmony control tokens should remain");
    assert.ok(cleaned.includes("Here is the answer"));
  });

  it("strips balanced <think>...</think> blocks", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    const cleaned = stripModelArtifacts("<think>reasoning here, several lines\nof internal monologue</think>Actual answer");
    assert.equal(cleaned, "Actual answer");
  });

  it("strips stray unclosed <think> tags without deleting real trailing content", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    const cleaned = stripModelArtifacts("<think>partial reasoning that never closes\nActual answer");
    assert.ok(!cleaned.includes("<think>"), "the stray tag itself should be removed");
    assert.ok(cleaned.includes("Actual answer"), "trailing real content must survive");
  });

  it("leaves clean text untouched, including legitimate use of '<' and the word 'think'", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    const clean = "I think 2 < 3 is true, and so is 5 > 4.";
    assert.equal(stripModelArtifacts(clean), clean);
  });

  it("is idempotent", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    const leaked = "<|channel|>final<|message|><think>nested</think>Clean answer";
    const once = stripModelArtifacts(leaked);
    const twice = stripModelArtifacts(once);
    assert.equal(once, twice);
  });

  it("handles empty and falsy input without throwing", async () => {
    const { stripModelArtifacts } = await import("../src/toolsProvider");
    assert.equal(stripModelArtifacts(""), "");
  });
});
