import { randomBytes } from "node:crypto";

// Fixed, versioned prompt set. Every run uses exactly these prompts, in this order,
// so results are comparable model-to-model and run-to-run. Scoring is deterministic:
// exact/regex/substring checks only, never an LLM judge.

// Reasoning models (qwen3, etc.) emit a <think>...</think> block full of scratch digits
// and words before the real answer. Checking the raw text against those scratch digits
// produces false negatives (e.g. "408" never matches because the reasoning trace also
// contains 17, 24, 20, 340, 68, 400... concatenated). Strip any think block(s) and score
// only what's left, falling back to the raw text if no closing tag is present (either the
// model isn't a reasoning model, or it got cut off mid-thought and never reached an answer
// -- in which case the raw/leftover text correctly fails the check anyway).
export function stripThinking(text) {
  const withoutClosedBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (withoutClosedBlocks.trim().length > 0) return withoutClosedBlocks;
  const openIdx = text.search(/<think>/i);
  return openIdx === -1 ? text : "";
}

// Non-reasoning models still ramble past "reply with only the number" (scratch work,
// restating the problem, etc). Concatenating every digit in the response (the original
// approach) falsely fails a correct answer buried in prose -- e.g. "17, 24 ... 340 + 68 =
// 408" digit-strips to "1724340" not "408". Instead take the LAST standalone number in the
// response, which is where a rambling answer actually states its final result.
export function lastNumber(text) {
  const matches = text.match(/-?\d+(\.\d+)?/g);
  return matches ? matches[matches.length - 1] : null;
}

function needleHaystack() {
  // Deterministic per benchmark run-file, but fixed seed so the doc content itself
  // never changes between runs (only the run's timestamp differs) -> reproducible.
  const needle = "The reference code for the Halden vault is QK-77219-ALPHA.";
  // Sized to fit comfortably inside the shared STANDARD_LOAD_CONFIG.contextLength (4096
  // tokens, chosen so the heaviest remote model in the catalog can actually load locally)
  // with room left for the model's own answer. ~25 short paragraphs is well under 1k tokens.
  const filler = [];
  for (let i = 0; i < 25; i++) {
    filler.push(
      `Paragraph ${i}: The quarterly logistics report notes routine shipments, unremarkable weather, ` +
        `and no deviations from the standard inspection schedule at site ${i % 17}. Staff rotated as planned.`
    );
  }
  const insertAt = 14; // fixed position, not random -> deterministic across runs
  filler.splice(insertAt, 0, needle);
  return { doc: filler.join("\n"), needle };
}

const { doc: HAYSTACK_DOC, needle: HAYSTACK_NEEDLE } = needleHaystack();

export const PROMPTS = [
  {
    id: "arith-1",
    kind: "short",
    prompt: "What is 17 * 24? Reply with only the number, nothing else.",
    check: (text) => lastNumber(text) === "408",
  },
  {
    id: "arith-2",
    kind: "short",
    prompt:
      "A train leaves at 14:05 and arrives at 16:40 the same day. How many minutes did the trip take? Reply with only the number.",
    check: (text) => lastNumber(text) === "155",
  },
  {
    id: "logic-1",
    kind: "short",
    prompt:
      "Alice is taller than Bob. Bob is taller than Carol. Is Carol taller than Alice? Reply with only 'yes' or 'no'.",
    check: (text) => /\bno\b/i.test(text) && !/\byes\b/i.test(text),
  },
  {
    id: "needle-haystack",
    kind: "long",
    prompt: `Read the following report carefully, then answer the question after it.\n\n${HAYSTACK_DOC}\n\nQuestion: what is the reference code for the Halden vault? Reply with only the code.`,
    check: (text) => text.includes("QK-77219-ALPHA"),
    meta: { needle: HAYSTACK_NEEDLE, approxDocChars: HAYSTACK_DOC.length },
  },
];

// Agentic prompt is defined separately (benchmark/run.mjs) since it needs live tool
// wiring (model.act + a small fixed tool set), not just a plain text prompt/check pair.
export function makeAgenticTaskFileMarker() {
  return randomBytes(4).toString("hex");
}
