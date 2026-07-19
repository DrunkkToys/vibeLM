import { LMStudioClient, tool, Chat } from "@lmstudio/sdk";
import { z } from "zod";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPTS, makeAgenticTaskFileMarker, stripThinking } from "./prompts.mjs";

// Remote-catalog models (LM Studio's "Remote" tab, served via the exo distributed-compute
// mesh) can only be loaded reliably through the LM Studio UI -- client.llm.load() takes a
// purely-local loading path and rejects them on local memory guardrails regardless of
// contextLength, even though the UI's own load path succeeds (0 GB local memory consumption
// observed). So loading is driven manually through the UI, with the SAME manual settings
// applied every time (see benchmark/models.mjs STANDARD_LOAD_CONFIG for the values); this
// script only benchmarks whichever model is CURRENTLY LOADED at the moment it's invoked, via
// `client.llm.model()` (no key = the active loaded model).

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RESULTS_DIR = resolve(HERE, "results");
const WORKDIR = resolve(HERE, "agentic-workdir");
mkdirSync(RESULTS_DIR, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

const LONG_TIMEOUT_MS = 300_000;
const SHORT_TIMEOUT_MS = 120_000;
const JSONL_PATH = resolve(RESULTS_DIR, "run-remote.jsonl");
const LOG_PATH = resolve(RESULTS_DIR, "run-remote.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_PATH, line + "\n");
}
function appendResult(result) {
  appendFileSync(JSONL_PATH, JSON.stringify(result) + "\n");
}
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTextPrompt(model, promptDef) {
  const started = Date.now();
  const chat = Chat.empty();
  chat.append("user", promptDef.prompt);
  const prediction = model.respond(chat, { maxPredictedTokens: 512 });
  const result = await withTimeout(prediction, promptDef.kind === "long" ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS, promptDef.id);
  const wallMs = Date.now() - started;
  const finalAnswer = stripThinking(result.content ?? "");
  const passed = promptDef.check(finalAnswer);
  return {
    promptId: promptDef.id,
    kind: promptDef.kind,
    passed,
    wallMs,
    finalAnswer: finalAnswer.slice(0, 500),
    timeToFirstTokenSec: result.stats?.timeToFirstTokenSec ?? null,
    tokensPerSecond: result.stats?.tokensPerSecond ?? null,
    promptTokensCount: result.stats?.promptTokensCount ?? null,
    predictedTokensCount: result.stats?.predictedTokensCount ?? null,
    stopReason: result.stats?.stopReason ?? null,
  };
}

async function runAgenticPrompt(model) {
  const marker = makeAgenticTaskFileMarker();
  const fileName = `bench-${marker}.txt`;
  const filePath = resolve(WORKDIR, fileName);
  if (existsSync(filePath)) rmSync(filePath);

  let rounds = 0;
  const toolCalls = [];
  const writeFileTool = tool({
    name: "write_file",
    description: "Write text content to a file by name in the working directory.",
    parameters: { fileName: z.string(), content: z.string() },
    implementation: async ({ fileName: fn, content }) => {
      toolCalls.push("write_file");
      writeFileSync(resolve(WORKDIR, fn), content, "utf-8");
      return { ok: true };
    },
  });
  const readFileTool = tool({
    name: "read_file",
    description: "Read the text content of a file by name in the working directory.",
    parameters: { fileName: z.string() },
    implementation: async ({ fileName: fn }) => {
      toolCalls.push("read_file");
      const p = resolve(WORKDIR, fn);
      return { content: existsSync(p) ? readFileSync(p, "utf-8") : null };
    },
  });

  const started = Date.now();
  const prompt =
    `Use your tools to do this exactly: 1) call write_file with fileName "${fileName}" and content ` +
    `"MARKER:${marker}". 2) call read_file with fileName "${fileName}" to confirm it was written. ` +
    `3) reply with only the marker value you read back, nothing else.`;

  const chat = Chat.empty();
  chat.append("user", prompt);
  const act = model.act(chat, [writeFileTool, readFileTool], {
    maxPredictionRounds: 8,
    onRoundEnd: () => {
      rounds += 1;
    },
  });
  const result = await withTimeout(act, LONG_TIMEOUT_MS, "agentic");
  const wallMs = Date.now() - started;

  const fileContent = existsSync(filePath) ? readFileSync(filePath, "utf-8") : null;
  const fileCorrect = fileContent === `MARKER:${marker}`;
  const finalAnswer = stripThinking(result?.content ?? "");
  const finalTextHasMarker = finalAnswer.includes(marker);

  return {
    promptId: "agentic-file-roundtrip",
    kind: "agentic",
    passed: fileCorrect && finalTextHasMarker,
    wallMs,
    rounds,
    toolCallCount: toolCalls.length,
    toolCallSequence: toolCalls,
    fileCorrect,
    finalTextHasMarker,
  };
}

async function main() {
  const labelArg = process.argv[2];
  const client = new LMStudioClient();
  const model = await client.llm.model();
  const info = await model.getModelInfo();
  const label = labelArg || `remote:${info?.modelKey ?? "unknown"}`;
  log(`Benchmarking currently-loaded model: ${label} (modelKey=${info?.modelKey}, arch=${info?.architecture})`);

  for (const promptDef of PROMPTS) {
    log(`  running ${promptDef.id}...`);
    let outcome;
    try {
      outcome = await runTextPrompt(model, promptDef);
    } catch (err) {
      log(`  ${promptDef.id} error: ${err.message}`);
      outcome = { promptId: promptDef.id, kind: promptDef.kind, passed: false, error: String(err.message) };
    }
    appendResult({ label, modelKey: info?.modelKey, architecture: info?.architecture, ...outcome });
  }

  log(`  running agentic-file-roundtrip...`);
  let agenticOutcome;
  try {
    agenticOutcome = await runAgenticPrompt(model);
  } catch (err) {
    log(`  agentic error: ${err.message}`);
    agenticOutcome = { promptId: "agentic-file-roundtrip", kind: "agentic", passed: false, error: String(err.message) };
  }
  appendResult({ label, modelKey: info?.modelKey, architecture: info?.architecture, ...agenticOutcome });

  log(`Done with ${label}.`);
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exitCode = 1;
});
