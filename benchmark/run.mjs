import { tool, Chat } from "@lmstudio/sdk";
import { z } from "zod";
import { mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverModels, clientForEntry } from "./models.mjs";
import { PROMPTS, makeAgenticTaskFileMarker, stripThinking } from "./prompts.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RESULTS_DIR = resolve(HERE, "results");
const WORKDIR = resolve(HERE, "agentic-workdir");
mkdirSync(RESULTS_DIR, { recursive: true });
mkdirSync(WORKDIR, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const JSONL_PATH = resolve(RESULTS_DIR, `run-${RUN_ID}.jsonl`);
const LOG_PATH = resolve(RESULTS_DIR, "run.log");

const SHORT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 300_000;

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

// Runs one plain text prompt/check pair via model.respond(), capturing the SDK's own
// prediction stats (TTFT, tokens/sec) instead of hand-rolled timing.
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
    rawLength: (result.content ?? "").length,
    finalAnswerLength: finalAnswer.length,
    finalAnswer: finalAnswer.slice(0, 500),
    timeToFirstTokenSec: result.stats?.timeToFirstTokenSec ?? null,
    tokensPerSecond: result.stats?.tokensPerSecond ?? null,
    promptTokensCount: result.stats?.promptTokensCount ?? null,
    predictedTokensCount: result.stats?.predictedTokensCount ?? null,
    stopReason: result.stats?.stopReason ?? null,
  };
}

// Agentic/tool-use prompt: model must call write_file then read_file to move a unique
// marker from instructions into a file, then report it back. Deterministic scoring:
// did the exact expected file+content show up on disk. Round count comes straight from
// the SDK's onRoundEnd callback (BFCL/tau-Bench-style trajectory metric).
async function runAgenticPrompt(model, modelLabel) {
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
      toolCalls.push({ tool: "write_file", args: { fileName: fn } });
      writeFileSync(resolve(WORKDIR, fn), content, "utf-8");
      return { ok: true };
    },
  });
  const readFileTool = tool({
    name: "read_file",
    description: "Read the text content of a file by name in the working directory.",
    parameters: { fileName: z.string() },
    implementation: async ({ fileName: fn }) => {
      toolCalls.push({ tool: "read_file", args: { fileName: fn } });
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
    toolCallSequence: toolCalls.map((c) => c.tool),
    fileCorrect,
    finalTextHasMarker,
  };
}

async function benchmarkOneModel(entry) {
  const client = clientForEntry(entry);
  log(`Loading ${entry.label} (${entry.modelKey})...`);
  let model;
  try {
    model = await withTimeout(client.llm.load(entry.modelKey), LONG_TIMEOUT_MS, `load ${entry.label}`);
  } catch (err) {
    log(`FAILED to load ${entry.label}: ${err.message}`);
    appendResult({ label: entry.label, modelKey: entry.modelKey, promptId: "__load__", passed: false, error: String(err.message) });
    return;
  }

  try {
    for (const promptDef of PROMPTS) {
      log(`  [${entry.label}] running ${promptDef.id}...`);
      let attempt = 0;
      let outcome;
      while (attempt < 2) {
        attempt += 1;
        try {
          outcome = await runTextPrompt(model, promptDef);
          break;
        } catch (err) {
          log(`  [${entry.label}] ${promptDef.id} attempt ${attempt} error: ${err.message}`);
          outcome = { promptId: promptDef.id, kind: promptDef.kind, passed: false, error: String(err.message) };
        }
      }
      appendResult({ label: entry.label, modelKey: entry.modelKey, architecture: entry.architecture, ...outcome });
    }

    log(`  [${entry.label}] running agentic-file-roundtrip...`);
    let agenticOutcome;
    try {
      agenticOutcome = await runAgenticPrompt(model, entry.label);
    } catch (err) {
      log(`  [${entry.label}] agentic attempt error: ${err.message}`);
      agenticOutcome = { promptId: "agentic-file-roundtrip", kind: "agentic", passed: false, error: String(err.message) };
    }
    appendResult({ label: entry.label, modelKey: entry.modelKey, architecture: entry.architecture, ...agenticOutcome });
  } finally {
    log(`Unloading ${entry.label}...`);
    await model.unload().catch((err) => log(`  unload warning for ${entry.label}: ${err.message}`));
  }
}

async function main() {
  log(`Starting benchmark run ${RUN_ID}`);
  const models = await discoverModels();
  writeFileSync(resolve(RESULTS_DIR, `models-discovered-${RUN_ID}.json`), JSON.stringify(models, null, 2));
  log(`Discovered ${models.length} model(s): ${models.map((m) => m.label).join(", ")}`);

  for (const entry of models) {
    await benchmarkOneModel(entry);
  }

  log(`Run ${RUN_ID} complete. Results: ${JSONL_PATH}`);
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exitCode = 1;
});
