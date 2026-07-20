import { text, tool, Chat, LMStudioClient, type PromptPreprocessorController, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { writeFile, appendFile, unlink, mkdir, rm } from "fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, relative, extname } from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import * as math from "mathjs";
import { SessionLog, type MemoryEntry, type SearchMemoryResult, type TurnEntry } from "./sessionLog";
import { configSchematics, DEFAULT_VIBE_BRIDGE_PROMPT, DEFAULT_VIBE_BRIDGE_INTERVAL, DEFAULT_VIBE_BRIDGE_MAX_DURATION } from "./config";
import { DEFAULT_ENABLED_TOOL_NAMES, TOOL_TOGGLES } from "./toolSettings";

const LMSTUDIO_API_PORT = process.env.LMSTUDIO_API_PORT || "1234";
const API_BASE = `http://localhost:${LMSTUDIO_API_PORT}`;

// Persistent runtime data lives under extensions/data, NOT extensions/plugins — `lms dev --install`
// wipes the plugin install directory on every deploy, which would otherwise destroy this data.
// VIBE_LM_DATA_DIR lets tests point this at an isolated directory instead of the real user install.
const DATA_DIR = process.env.VIBE_LM_DATA_DIR || resolve(homedir(), ".lmstudio", "extensions", "data", "drunkktoys", "vibe-lm");
const CONFIG_PATH = resolve(DATA_DIR, "config.json");
const RUNTIME_STATE_PATH = resolve(DATA_DIR, "runtime-state.json");
const JSONL_CACHE_PATH = resolve(DATA_DIR, "session-log.jsonl");

const DEFAULT_CONTEXT_WINDOW = 8192;
const PROMPT_BUDGET_RATIO = 0.50;
const MAX_TOOL_RESULT_CHARS = 500;
const MAX_NON_CODE_RESULT_CHARS = 300;
// Importance tiers for how much of a tool result is kept verbatim on the turn log. Flat truncation
// treated a 2 KB file read the same as a one-line failed probe; tiering keeps more of what carries
// information (reads/searches) and less of the noise we already distil into a fact (failures).
const TOOL_RESULT_CHARS_HIGH = 1500;
const TOOL_RESULT_CHARS_LOW = 300;
const HIGH_VALUE_RESULT_TOOLS = new Set([
  "read_file", "search_files", "list_files", "explore_workspace", "web_search",
  "get_config", "get_plan", "list_memories", "search_memory",
]);
// Fraction of the context window reserved for the pinned head (goal/plan + established facts). The
// spine is assembled tier-by-tier to fit this budget instead of a fixed fact count.
const HEAD_BUDGET_RATIO = 0.20;
const COMPACT_CONTEXT_TRIGGER_TURNS = 5;
const COMPACT_CONTEXT_TRIGGER_RATIO = 0.30;
const COMPACT_CONTEXT_MIN_GAP_TURNS = 3;
const COMPACT_CONTEXT_MAX_RECENT_TURNS = 80;
const COMPACT_CONTEXT_DEFAULT_MAX_TOKENS = 500;
const COMPACT_CONTEXT_SAFETY_MARGIN = 256;
const DEFAULT_MAX_ORCHESTRATOR_TURNS = 50;
const DEFAULT_ROLLING_WINDOW_TRIGGER_TOKENS = 3000;
// Secondary safety net on top of reading the real loaded context length: an optional hard cap on the
// window vibeLM budgets against, for machines that can't sustain even the configured length. Default 0
// = trust the loaded window; users raise it via tools.maxEffectiveContextTokens when they need it.
const DEFAULT_MAX_EFFECTIVE_CONTEXT_TOKENS = 0;
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "off";
// vibe_bridge ticks are a standalone model.act() call outside the main orchestrator, so they
// don't inherit maxOrchestratorTurns. Without their own cap, a model stuck reasoning without
// calling any tool (e.g. looping on "Wait... Actually...") can run unbounded — confirmed live,
// one tick ran 43 minutes with zero tool calls after a set_workspace error it never recovered from.
// Exposed to users as the "Max Thinking Steps" setting (tools.maxThinkingSteps).
const DEFAULT_MAX_THINKING_STEPS = 8;
const VIBE_BRIDGE_TICK_TIMEOUT_MS = 180_000;
const LOOP_WINDOW = 5;
// Semantic (coarse) loop guard. The exact-signature guard only catches a model that repeats an
// identical call verbatim; it misses a model that probes the same shell program with a different
// argument every turn (observed live: 24 consecutive `ls <different node/npm path>` calls, each with
// a distinct signature, so the exact guard never fired). The coarse guard keys shell tools on the
// program name only, so `ls A`, `ls B`, `ls C`… collapse to one signature and trip after a few tries.
const COARSE_LOOP_WINDOW = 6;
const COARSE_LOOP_THRESHOLD = 5;
const SHELL_TOOLS = new Set(["bash_terminal", "ssh_exec"]);
const CHECKPOINT_INTERVAL_MAX = 10;
const CHECKPOINT_INTERVAL_EARLY = 4;
const CONTINUATION_PATTERN = /(?:keep\s+(?:going|working|doing)|continue|go\s+(?:on|ahead)|proceed|carry\s+on|resume|move\s+on|what(?:'s|\sis)\s+next|next\s+step|finish\s+(?:it|the\s+task|the\s+rest)|complete\s+(?:it|the\s+task)|do\s+the\s+rest|pick\s+up\s+where|as\s+you\s+were|same\s+(?:as\s+before|thing)|and\s+then|go\s+ahead|yeah|yes|ok|okay|sure|right)/i;
const readOnlyTools = ["list_files", "read_file", "search_files", "get_current_datetime", "get_config", "list_memories", "search_memory", "get_plan"];
const MANAGED_CONTEXT_MARKER = "[vibeLM:managed-context]";
// Thresholds for telling a real mid-conversation restart/roll apart from a genuinely new/different
// chat on a historyFingerprint mismatch (see bootstrapSessionState). Only treat it as a new
// conversation — and skip carrying over the old plan — when the *previous* history was substantial
// (not just a short placeholder/first turn) AND the new history is dramatically shorter than it.
// Floor below which a previous session is too small to draw any conclusion from. This only guards
// against a noisy baseline — the actual new-chat discriminators are the shrink RATIO below and the
// absence of a managed-context block (see looksLikeDifferentConversation).
//
// Recalibrated from 500 once chatToText started returning real conversation text. While history was
// being read via Chat.toString(), this measured a constant 19-char debug string, so `> 500` was never
// once true and the new-conversation detection never fired in production in any code path. Measured
// live afterwards: a complete single tool-using exchange (user turn + assistant answer) is ~414
// chars, and a fresh chat's first message is ~20. 150 sits clearly between them, so one real exchange
// counts as substantial while a trivial "hi"/"hello" chat still does not.
const MIN_SUBSTANTIAL_HISTORY_CHARS = 150;
const NEW_CONVERSATION_LENGTH_RATIO = 0.3;
// Denylist, not allowlist: bash_terminal is a general-purpose dev tool (git, npm, build scripts,
// etc.), so an allowlist would block too much legitimate use. This blocks clearly destructive or
// privilege-escalating patterns rather than trying to enumerate every safe command.
const BASH_DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+(-\w*[rf]\w*[rf]?\w*|--recursive|--force)\s+(-\w*\s+)*(\/|~|\$HOME|\*)(\s|$)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  />\s*\/dev\/(sd|nvme|disk|hd)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bchmod\s+(-R\s+)?(777|a\+rwx)\s+\//i,
  /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
  /\bsudo\b/i,
];

function checkBashCommandSafety(command: string): string | null {
  for (const pattern of BASH_DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked: it matches a denylisted destructive/privilege-escalating pattern. If this was a false positive, rephrase the command or run it manually outside vibeLM.`;
    }
  }
  return null;
}
type MemoryScope = "session" | "workspace" | "research" | "all";
let activeMaxOrchestratorTurns = DEFAULT_MAX_ORCHESTRATOR_TURNS;
let activeRollingWindowTriggerTokens = DEFAULT_ROLLING_WINDOW_TRIGGER_TOKENS;

type ContextWindowCacheEntry = {
  modelKey: string;
  contextWindow: number;
  ts: number;
};

let cachedContextWindow: ContextWindowCacheEntry | null = null;

type ReasoningEffort = "off" | "low" | "medium" | "high";

// Info about the currently loaded model, read from LM Studio's native REST API. `loadedContextLength`
// is the context the user ACTUALLY configured for this load (LM Studio also exposes a larger
// `max_context_length` — the model's ceiling — which is NOT what the session runs at). `arch` picks the
// thinking-control directive. Cached with a short TTL so we don't hit the API on every message.
const LOADED_MODEL_CACHE_TTL_MS = 30_000;
type LoadedModelInfo = { arch: string; loadedContextLength: number | null };
let cachedLoadedModelInfo: { info: LoadedModelInfo; ts: number } | null = null;

// Test-only: force the next fetchLoadedModelInfo() call to hit the network again instead of serving
// a stale cached arch from an earlier test in the same process.
export function __resetLoadedModelInfoCacheForTests(): void {
  cachedLoadedModelInfo = null;
}

let _bridgeActive = false;
let _bridgePrompt = "";
let _bridgeInterval = 0;
let _bridgeIteration = 0;
let _bridgeMaxIterations = 0;
let _bridgeMaxDuration = 0;
let _bridgeStartedAt = 0;
let _bridgeTimer: ReturnType<typeof setTimeout> | null = null;
let _bridgeHandover: string[] = [];
let _bridgePredictionRunning = false;
let _bridgeConsecutiveFailures = 0;
const BRIDGE_MAX_CONSECUTIVE_FAILURES = 3;
let _bridgeClient: LMStudioClient | null = null;

function makeModelCacheKey(model: { identifier?: string; modelKey?: string; path?: string } | null | undefined): string {
  return [model?.identifier, model?.modelKey, model?.path].filter((part) => typeof part === "string" && part.trim().length > 0).join("::");
}

async function resolveLoadedContextWindow(ctl?: any): Promise<ContextWindowCacheEntry | null> {
  try {
    const loadedModels = await ctl?.client?.llm?.listLoaded?.();
    if (!Array.isArray(loadedModels) || loadedModels.length === 0) {
      return null;
    }
    const config = readConfigSync();
    const preferred = (config as any).preferredModel;
    const selected = pickBestLoadedModel(loadedModels, preferred) || loadedModels[0];
    if (!selected) {
      return null;
    }
    const contextWindow = await readLoadedModelContextWindow(selected);
    if (typeof contextWindow === "number" && contextWindow > 0) {
      return {
        modelKey: makeModelCacheKey(selected),
        contextWindow,
        ts: Date.now(),
      };
    }
  } catch (err) {
    console.error("[AgenticTools] resolveLoadedContextWindow failed, falling back to default context window:", err);
  }
  return null;
}

function pickBestLoadedModel(models: Array<{ identifier?: string; modelKey?: string; path?: string }>, preferred?: string) {
  if (!models.length) return null;
  if (preferred) {
    const match = models.find((m) => [m.identifier, m.modelKey, m.path].some((value) => typeof value === "string" && value.includes(preferred)));
    if (match) return match;
  }
  return models[0];
}

async function readLoadedModelContextWindow(model: any): Promise<number | null> {
  const direct = model?.contextLength ?? model?.max_context_length;
  if (typeof direct === "number" && direct > 0) {
    return direct;
  }
  try {
    const info = await model?.getModelInfo?.();
    const ctx = info?.contextLength ?? info?.max_context_length;
    if (typeof ctx === "number" && ctx > 0) {
      return ctx;
    }
  } catch (err) {
    console.error("[AgenticTools] readLoadedModelContextWindow failed, falling back to default context window:", err);
  }
  return null;
}

// The window the loaded model runs at, before applying the effective-context cap. Prefers the REST
// API's `loaded_context_length` (what the user configured) and only falls back to the SDK path — which
// reports the model's max ceiling — when the REST value is unavailable.
async function getReportedContextWindow(ctl?: any): Promise<number> {
  const loadedContextLength = (await fetchLoadedModelInfo()).loadedContextLength;
  if (typeof loadedContextLength === "number" && loadedContextLength > 0) {
    return loadedContextLength;
  }

  const now = Date.now();
  const resolved = await resolveLoadedContextWindow(ctl);
  if (resolved) {
    if (!cachedContextWindow || cachedContextWindow.modelKey !== resolved.modelKey || cachedContextWindow.contextWindow !== resolved.contextWindow) {
      cachedContextWindow = resolved;
    } else {
      cachedContextWindow.ts = now;
    }
    return resolved.contextWindow;
  }

  if (cachedContextWindow) {
    return cachedContextWindow.contextWindow;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

// Clamp the reported window to the token budget the machine can actually sustain. cap <= 0 disables.
export function effectiveContextWindow(reported: number, cap: number): number {
  if (typeof cap === "number" && cap > 0) {
    return Math.min(reported, cap);
  }
  return reported;
}

// Every budgeting/compaction decision routes through here, so capping here makes the whole guardrail
// (hardPromptBudgetLimit, rolling window, shouldAutoCompactSession) fire against the effective window.
async function getContextWindow(ctl?: any): Promise<number> {
  const reported = await getReportedContextWindow(ctl);
  return effectiveContextWindow(reported, resolveMaxEffectiveContextTokens(ctl));
}

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".exe", ".dll", ".so", ".dylib", ".wasm",
  ".o", ".obj", ".pyc", ".class",
  ".ttf", ".otf", ".woff", ".woff2",
]);

function binaryExtCheck(p: string): boolean {
  return BINARY_EXTS.has(extname(p).toLowerCase());
}

const VLM_PATTERNS = /vlm|vision|video|multimodal|image|\d+(?:\.\d+)?v(?:\b|-)/i;

function pickBestModel(models: Array<{ id: string }>, preferred?: string): string | null {
  if (!models.length) return null;
  if (preferred) {
    const match = models.find(m => m.id === preferred || m.id.includes(preferred));
    if (match) return match.id;
  }
  const textModels = models.filter(m => !VLM_PATTERNS.test(m.id));
  if (textModels.length) return textModels[0].id;
  return models[0].id;
}

async function getModel(): Promise<string | null> {
  try {
    const resp = await fetch(`${API_BASE}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.error(`[AgenticTools] LM Studio API returned HTTP ${resp.status} at ${API_BASE}/v1/models`);
      return null;
    }
    const data = await resp.json() as { data?: Array<{ id: string }> };
    if (!data?.data?.length) {
      console.warn(`[AgenticTools] No models loaded via API. Load a model in LM Studio first.`);
      return null;
    }
    const config = readConfigSync();
    const model = pickBestModel(data.data, (config as any).preferredModel);
    console.log(`[AgenticTools] Using model: ${model}`);
    return model;
  } catch (e) {
    console.error(`[AgenticTools] Cannot reach LM Studio API at ${API_BASE}. Run 'lms server start'`);
    return null;
  }
}

function defaultConfig() {
  return { workspacePath: homedir() };
}

function readConfigSync(): { workspacePath: string; preferredModel?: string; searchEndpoint?: string; vibeBridgePrompt?: string; vibeBridgeInterval?: number; vibeBridgeMaxDuration?: number } {
  try {
    const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : {};
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "enabledTools" in raw) {
      const { enabledTools, ...cleaned } = raw as Record<string, unknown>;
      writeConfigSync(cleaned);
      return { ...defaultConfig(), ...cleaned };
    }
    return { ...defaultConfig(), ...raw };
  } catch { return defaultConfig(); }
}

function readPluginConfigValue(ctl: any, keys: string[]): unknown {
  try {
    const pluginConfig = ctl?.getPluginConfig?.(configSchematics);
    for (const key of keys) {
      const rawValue = pluginConfig?.get(key);
      if (rawValue !== undefined) {
        return rawValue;
      }
    }
  } catch (err) {
    console.error(`[AgenticTools] readPluginConfigValue failed for keys [${keys.join(", ")}], falling back to hardcoded defaults:`, err);
  }
  return undefined;
}

function resolveMaxOrchestratorTurns(ctl?: any): number {
  const rawValue = readPluginConfigValue(ctl, ["tools.maxOrchestratorTurns", "maxOrchestratorTurns"]);
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return Math.max(0, Math.min(100, Math.floor(rawValue)));
  }
  return DEFAULT_MAX_ORCHESTRATOR_TURNS;
}

function resolveMaxEffectiveContextTokens(ctl?: any): number {
  const rawValue = readPluginConfigValue(ctl, ["tools.maxEffectiveContextTokens", "maxEffectiveContextTokens"]);
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return Math.max(0, Math.floor(rawValue));
  }
  return DEFAULT_MAX_EFFECTIVE_CONTEXT_TOKENS;
}

// The auto-compaction trigger, as a fraction of the context window. Exposed as a percentage
// (tools.compactionTriggerPercent) and clamped to a sane 10–90% band.
export function resolveCompactionTriggerRatio(ctl?: any): number {
  const rawValue = readPluginConfigValue(ctl, ["tools.compactionTriggerPercent", "compactionTriggerPercent"]);
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return Math.max(10, Math.min(90, Math.floor(rawValue))) / 100;
  }
  return COMPACT_CONTEXT_TRIGGER_RATIO;
}

function resolveMaxThinkingSteps(ctl?: any): number {
  const rawValue = readPluginConfigValue(ctl, ["tools.maxThinkingSteps", "maxThinkingSteps"]);
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return Math.max(1, Math.min(50, Math.floor(rawValue)));
  }
  return DEFAULT_MAX_THINKING_STEPS;
}

function resolveReasoningEffort(ctl?: any): ReasoningEffort {
  const rawValue = readPluginConfigValue(ctl, ["tools.reasoningEffort", "reasoningEffort"]);
  if (rawValue === "off" || rawValue === "low" || rawValue === "medium" || rawValue === "high") {
    return rawValue;
  }
  return DEFAULT_REASONING_EFFORT;
}

// Read the loaded model's arch + configured (loaded) context length from LM Studio's native REST API,
// which reports `arch`, per-model `state`, and `loaded_context_length`. Cached with a short TTL.
// Pure parse of the /api/v0/models payload: pick the loaded model (or first entry) and read its arch +
// configured context length. Deliberately reads `loaded_context_length`, never `max_context_length`.
export function parseLoadedModelInfo(data: { data?: Array<{ arch?: string; state?: string; loaded_context_length?: number }> } | null | undefined): LoadedModelInfo {
  const loaded = data?.data?.find((m) => m.state === "loaded") ?? data?.data?.[0];
  return {
    arch: typeof loaded?.arch === "string" ? loaded.arch : "",
    loadedContextLength: typeof loaded?.loaded_context_length === "number" && loaded.loaded_context_length > 0
      ? loaded.loaded_context_length
      : null,
  };
}

// Test seam. toolsProvider() has to know the loaded model's architecture (Harmony families must not
// be offered `amend` — see the tool assembly below), which would otherwise make the tool list depend
// on whichever model the developer happens to have loaded in LM Studio while running the suite.
// Tests pin this instead of reaching the network; production never sets it.
let loadedModelInfoOverride: LoadedModelInfo | null = null;
export function setLoadedModelInfoOverride(info: LoadedModelInfo | null): void {
  loadedModelInfoOverride = info;
}

async function fetchLoadedModelInfo(): Promise<LoadedModelInfo> {
  if (loadedModelInfoOverride) return loadedModelInfoOverride;
  const now = Date.now();
  if (cachedLoadedModelInfo && now - cachedLoadedModelInfo.ts < LOADED_MODEL_CACHE_TTL_MS) {
    return cachedLoadedModelInfo.info;
  }
  try {
    const resp = await fetch(`${API_BASE}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const info = parseLoadedModelInfo(await resp.json());
      cachedLoadedModelInfo = { info, ts: now };
      return info;
    }
  } catch (err) {
    console.error("[AgenticTools] fetchLoadedModelInfo failed, falling back to SDK context/arch resolution:", err);
  }
  return { arch: "", loadedContextLength: null };
}

async function getLoadedModelArch(): Promise<string> {
  return (await fetchLoadedModelInfo()).arch;
}

// Pure mapping from (effort, arch) to a thinking-control directive appended to the outgoing prompt.
// Each family gets its native control where one exists, and every level (off/low/medium/high) must
// produce a distinct, non-empty directive — a collapsed/empty mapping is a silent no-op setting:
//  - gpt-oss: Harmony "Reasoning: low/medium/high" — deterministic tiers. Harmony has no "off" tier,
//    so off intentionally collapses to its floor, "low" (not a bug — there's nothing lower to map to).
//  - Qwen: chat template only exposes a binary /think–/no_think switch, no native 3-tier control.
//    Keep that switch as the real lever and append a graduated natural-language qualifier so
//    low/medium/high are at least textually distinct in the prompt.
//  - everything else (Llama/Mistral/Gemma/DeepSeek/GLM/Phi/etc.): graduated natural-language nudges.
// Harmony-format architectures express a finished turn natively via the `final` channel, so an
// `amend`-style "return your final answer" tool duplicates a capability they already have and makes
// them emit `<|channel|>final <|constrain|>amend<|message|>` as visible text. Same detection as the
// reasoning-directive mapping below, kept as one predicate so both stay in sync.
export function usesHarmonyFinalChannel(arch: string): boolean {
  return /gpt.?oss/i.test(arch);
}

export function reasoningDirectiveFor(effort: ReasoningEffort, arch: string): string {
  if (/gpt.?oss/i.test(arch)) {
    switch (effort) {
      case "off": return "Reasoning: low";
      case "low": return "Reasoning: low";
      case "medium": return "Reasoning: medium";
      case "high": return "Reasoning: high";
    }
  }
  if (/qwen/i.test(arch)) {
    switch (effort) {
      case "off": return "/no_think";
      case "low": return "/think Keep your reasoning brief — a few short steps at most.";
      case "medium": return "/think Reason through this at a moderate depth before answering.";
      case "high": return "/think Reason thoroughly and check your work before answering; take as many steps as needed.";
    }
  }
  switch (effort) {
    case "off": return "Answer directly and concisely; do not produce extended step-by-step reasoning.";
    case "low": return "Keep any reasoning brief — a sentence or two at most before answering.";
    case "medium": return "Think through the problem in a few clear steps before answering; balance thoroughness with brevity.";
    case "high": return "Reason carefully and thoroughly step by step, consider edge cases and alternatives, and double-check your conclusion before answering.";
  }
}

// Resolve the directive for the current session (effort from config + arch from the loaded model).
export async function reasoningDirectiveForSession(ctl?: any): Promise<string> {
  const effort = currentPlanStepThinking() ?? resolveReasoningEffort(ctl);
  const arch = await getLoadedModelArch();
  return reasoningDirectiveFor(effort, arch);
}

// Architectures with reasoning baked into a separate channel that no prompt-text directive can turn
// off — confirmed live against real loaded models: LM Studio's own native `reasoning` REST setting
// (which authoritatively reports per-model support) accepted "off" for gemma4 but the model still
// verbalized its full reasoning inline anyway, and outright REJECTED "off" for Phi-3/Phi-4-reasoning
// with "Supported settings: 'on'" — i.e. LM Studio itself confirms there is no off-switch. Nemotron's
// hybrid (Nemotron-H) architecture showed the same behavior against both vibeLM's own directive and
// NVIDIA's documented "detailed thinking off" convention. For these, a tight token budget is actively
// dangerous rather than just wasteful: reasoning can consume the entire budget before the model ever
// reaches its answer, returning empty content (reproduced live on phi-4-mini-reasoning). Give them a
// generous explicit floor instead of whatever ambient per-model limit might otherwise apply.
const ALWAYS_REASONING_ARCH_PATTERN = /gemma.?4|phi.?[34]|nemotron/i;
const ALWAYS_REASONING_TICK_MAX_TOKENS = 6000;

export function resolveBridgeTickMaxTokens(arch: string): number | undefined {
  return ALWAYS_REASONING_ARCH_PATTERN.test(arch) ? ALWAYS_REASONING_TICK_MAX_TOKENS : undefined;
}

function resolveConfiguredRollingWindowTriggerTokens(ctl?: any): number {
  const rawValue = readPluginConfigValue(ctl, ["tools.rollingWindowTriggerTokens", "rollingWindowTriggerTokens", "contextOverflowHeadroomTokens"]);
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return Math.max(0, Math.min(16384, Math.floor(rawValue)));
  }
  return DEFAULT_ROLLING_WINDOW_TRIGGER_TOKENS;
}

function resolveRollingWindowTriggerTokens(contextWindow: number, configuredTokens: number): number {
  const hardLimitTokens = hardPromptBudgetLimit(contextWindow);
  if (configuredTokens <= 0) {
    return hardLimitTokens;
  }
  return Math.max(1, Math.min(configuredTokens, hardLimitTokens));
}

function resolveEnabledToolNames(ctl?: any): string[] {
  const pluginEnabledTools: string[] = [];
  let sawPluginToggle = false;

  for (const tool of TOOL_TOGGLES) {
    const rawValue = readPluginConfigValue(ctl, [`tools.${tool.name}`, tool.name]);
    if (typeof rawValue === "boolean") {
      sawPluginToggle = true;
      if (rawValue) {
        pluginEnabledTools.push(tool.name);
      }
    }
  }

  if (sawPluginToggle) {
    return dedupeTags([...pluginEnabledTools, "amend"]);
  }

  return dedupeTags([...DEFAULT_ENABLED_TOOL_NAMES, "amend"]);
}

function writeConfigSync(config: Record<string, unknown>): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) require("fs").mkdirSync(dir, { recursive: true });
  require("fs").writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function getWorkspace(sessionDir?: string): string {
  const config = readConfigSync();
  const ws = config.workspacePath?.trim();
  if (ws) {
    return existsSync(ws) && statSync(ws).isDirectory() ? ws : "";
  }
  if (sessionDir) {
    const trimmed = sessionDir.trim();
    if (trimmed && existsSync(trimmed) && statSync(trimmed).isDirectory()) return trimmed;
  }
  return "";
}

function formatWorkspaceSetupError(sessionDir?: string): string {
  const config = readConfigSync();
  const workspace = config.workspacePath?.trim();
  if (workspace) {
    if (!existsSync(workspace)) {
      return `Workspace path not found: ${workspace}. Call set_workspace({ path: "/absolute/path" }) with an existing folder.`;
    }
    if (!statSync(workspace).isDirectory()) {
      return `Workspace path is not a directory: ${workspace}. Call set_workspace({ path: "/absolute/path" }) with a folder.`;
    }
  }
  if (sessionDir) {
    const trimmed = sessionDir.trim();
    if (trimmed && existsSync(trimmed) && !statSync(trimmed).isDirectory()) {
      return `LM Studio working directory is not a directory: ${trimmed}. Call set_workspace({ path: "/absolute/path" }) with a folder.`;
    }
  }
  return `No workspace set. Call set_workspace({ path: "/absolute/path" }) first.`;
}

function requireWorkspace(ctl: any): string {
  const ws = getWorkspace(ctl.getWorkingDirectory());
  if (!ws) throw new Error(formatWorkspaceSetupError(ctl.getWorkingDirectory()));
  return ws;
}

function sandboxPath(workspace: string, requestedPath: string): string {
  const expandedPath =
    requestedPath === "~" || requestedPath.startsWith("~/")
      ? resolve(homedir(), requestedPath.slice(2))
      : requestedPath;
  const resolved = resolve(workspace, expandedPath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || resolve(rel) === rel) {
    throw new Error(`Path "${requestedPath}" is outside the workspace "${workspace}"`);
  }
  return resolved;
}

let globalSessionLog: SessionLog | null = null;

function getSessionLog(): SessionLog {
  if (!globalSessionLog) {
    globalSessionLog = new SessionLog(JSONL_CACHE_PATH);
  }
  return globalSessionLog;
}

type PlanStepStatus = "pending" | "in_progress" | "done" | "blocked";
type PlanStep = { index: number; description: string; status: PlanStepStatus; note?: string; thinking?: ReasoningEffort };
type Plan = { goal: string; steps: PlanStep[]; createdAt: string; updatedAt: string };

const REASONING_EFFORT_VALUES = ["off", "low", "medium", "high"] as const;

// The step a bridge tick or agentic loop is currently working on: the first in_progress step, or
// failing that the first pending one. Its `thinking` override (if any) takes precedence over the
// session-wide reasoningEffort config, letting a plan mark individual steps as needing more/less
// reasoning than the rest (e.g. "off" for a mechanical file write, "high" for a tricky refactor step).
function currentPlanStepThinking(): ReasoningEffort | undefined {
  const steps = activeSessionState.plan?.steps ?? [];
  const step = steps.find((s) => s.status === "in_progress") ?? steps.find((s) => s.status === "pending");
  return step?.thinking;
}

type SessionState = {
  sessionId: string;
  turnCounter: number;
  toolCallHistory: Array<{ name: string; signature: string; coarse: string; ts: number; outcome?: "ok" | "fail" | "info" }>;
  lastCompactionTurn: number;
  historyFingerprint: string;
  historyTextLength: number;
  // Length of the system prompt inside historyTextLength. Tracked separately because the
  // new-conversation heuristic in bootstrapSessionState compares CONVERSATION size, and vibeLM's
  // system prompt (26 tool descriptions) is a multi-thousand-char constant present in every chat,
  // new or old. Comparing composed lengths let that constant swamp the signal entirely.
  systemPromptLength: number;
  // Size of the CONVERSATION alone, as last seen by readHistoryParts. Deliberately separate from
  // historyTextLength, which recordProcessedPrompt also folds vibeLM's own injected directive into —
  // comparing that against a raw history read is apples-to-oranges and inflates the "previous" side,
  // which makes the new-chat check fire spuriously mid-conversation.
  lastSeenConversationChars: number;
  resumedFromPersistedState: boolean;
  managedContextBlocks: string[];
  lastHandoffSummary: string;
  lastHandoffTurn: number;
  plan: Plan | null;
};

function createSessionState(): SessionState {
  return {
    sessionId: randomUUID(),
    turnCounter: 0,
    toolCallHistory: [],
    lastCompactionTurn: 0,
    historyFingerprint: "",
    historyTextLength: 0,
    systemPromptLength: 0,
    lastSeenConversationChars: 0,
    resumedFromPersistedState: false,
    managedContextBlocks: [],
    lastHandoffSummary: "",
    lastHandoffTurn: 0,
    plan: null,
  };
}

let activeSessionState = createSessionState();
let activeSessionInitialized = false;
let activeSessionBootstrapPromise: Promise<SessionState> | null = null;
function currentSessionId(state: SessionState = activeSessionState): string {
  return state.sessionId;
}

function compactSessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

function compactWorkspaceTag(workspace: string): string {
  return `workspace:${workspace}`;
}

function compactScopeTag(scope: Exclude<MemoryScope, "all">): string {
  return `scope:${scope}`;
}

type PersistedSessionState = {
  version: 1;
  sessionId: string;
  turnCounter: number;
  lastCompactionTurn: number;
  historyFingerprint: string;
  historyTextLength?: number;
  systemPromptLength?: number;
  lastSeenConversationChars?: number;
  resumedFromPersistedState: boolean;
  updatedAt: string;
  managedContextBlocks?: string[];
  lastHandoffSummary?: string;
  lastHandoffTurn?: number;
  plan?: Plan | null;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHistoryText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function composeHistoryText(systemPrompt: string, historyText: string): string {
  const normalizedSystemPrompt = normalizeHistoryText(systemPrompt);
  const normalizedHistoryText = normalizeHistoryText(historyText);
  if (!normalizedSystemPrompt) return normalizedHistoryText;
  if (!normalizedHistoryText) return normalizedSystemPrompt;
  if (normalizedSystemPrompt === normalizedHistoryText) return normalizedSystemPrompt;
  if (normalizedHistoryText.includes(normalizedSystemPrompt)) return normalizedHistoryText;
  if (normalizedSystemPrompt.includes(normalizedHistoryText)) return normalizedSystemPrompt;
  return `${normalizedSystemPrompt}\n${normalizedHistoryText}`.trim();
}

function stripManagedContextBlocks(historyText: string): string {
  const normalized = normalizeHistoryText(historyText);
  if (!normalized.includes(MANAGED_CONTEXT_MARKER)) {
    return normalized;
  }
  const managedBlock = new RegExp(`${escapeRegExp(MANAGED_CONTEXT_MARKER)}[\\s\\S]*?(?=\\n{2,}|$)`, "g");
  return normalized.replace(managedBlock, "").replace(/\n{3,}/g, "\n\n").trim();
}

function fingerprintHistoryText(historyText: string): string {
  return createHash("sha256").update(stripManagedContextBlocks(historyText), "utf-8").digest("hex");
}

function parsePersistedPlan(value: unknown): Plan | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Plan>;
  if (typeof candidate.goal !== "string" || candidate.goal.trim().length === 0 || !Array.isArray(candidate.steps)) return null;
  const steps: PlanStep[] = (candidate.steps as unknown[])
    .filter((s): s is Partial<PlanStep> => !!s && typeof s === "object")
    .map((s, i) => ({
      index: Number.isFinite(s.index) ? Math.max(0, Math.floor(s.index as number)) : i,
      description: typeof s.description === "string" ? s.description : "",
      status: (["pending", "in_progress", "done", "blocked"] as const).includes(s.status as PlanStepStatus)
        ? (s.status as PlanStepStatus)
        : "pending",
      note: typeof s.note === "string" ? s.note : undefined,
      thinking: REASONING_EFFORT_VALUES.includes(s.thinking as ReasoningEffort) ? (s.thinking as ReasoningEffort) : undefined,
    }))
    .filter((s) => s.description.length > 0);
  // A goal-only plan (no steps yet) is valid: the auto-seeded session goal must survive persistence so
  // the pinned head can anchor to it even before the model calls create_plan. Only a missing/empty
  // goal makes a plan meaningless.
  return {
    goal: candidate.goal,
    steps,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function isCompletedPlan(plan: Plan | null | undefined): boolean {
  return !!plan && plan.steps.length > 0 && plan.steps.every((step) => step.status === "done");
}

// Goal-only and completed plans have nothing left to route. The former was never expanded into
// executable work; the latter remains visible in ordinary LM Studio history but must not be restored
// into active runtime state, where its goal/directives would compete with the next user request.
function planWorthCarryingForward(plan: Plan | null | undefined): boolean {
  return !!plan && plan.steps.length > 0 && !isCompletedPlan(plan);
}

function readRuntimeStateSync(): PersistedSessionState | null {
  try {
    if (!existsSync(RUNTIME_STATE_PATH)) return null;
    const parsed = JSON.parse(readFileSync(RUNTIME_STATE_PATH, "utf-8")) as Partial<PersistedSessionState> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.sessionId !== "string" || typeof parsed.historyFingerprint !== "string") return null;
    return {
      version: 1,
      sessionId: parsed.sessionId,
      turnCounter: Number.isFinite(parsed.turnCounter) ? Math.max(0, Math.floor(parsed.turnCounter ?? 0)) : 0,
      lastCompactionTurn: Number.isFinite(parsed.lastCompactionTurn) ? Math.max(0, Math.floor(parsed.lastCompactionTurn ?? 0)) : 0,
      historyFingerprint: parsed.historyFingerprint,
      historyTextLength: Number.isFinite(parsed.historyTextLength) ? Math.max(0, Math.floor(parsed.historyTextLength ?? 0)) : 0,
      systemPromptLength: Number.isFinite(parsed.systemPromptLength) ? Math.max(0, Math.floor(parsed.systemPromptLength ?? 0)) : 0,
      lastSeenConversationChars: Number.isFinite(parsed.lastSeenConversationChars) ? Math.max(0, Math.floor(parsed.lastSeenConversationChars ?? 0)) : 0,
      resumedFromPersistedState: Boolean(parsed.resumedFromPersistedState),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      managedContextBlocks: Array.isArray(parsed.managedContextBlocks) ? parsed.managedContextBlocks.filter((b: unknown) => typeof b === "string") : [],
      lastHandoffSummary: typeof parsed.lastHandoffSummary === "string" ? parsed.lastHandoffSummary : "",
      lastHandoffTurn: typeof parsed.lastHandoffTurn === "number" ? parsed.lastHandoffTurn : 0,
      plan: parsePersistedPlan(parsed.plan),
    };
  } catch {
    return null;
  }
}

function writeRuntimeStateSync(state: SessionState): void {
  try {
    const dir = dirname(RUNTIME_STATE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: PersistedSessionState = {
      version: 1,
      sessionId: state.sessionId,
      turnCounter: state.turnCounter,
      lastCompactionTurn: state.lastCompactionTurn,
      historyFingerprint: state.historyFingerprint,
      historyTextLength: state.historyTextLength,
      systemPromptLength: state.systemPromptLength,
      lastSeenConversationChars: state.lastSeenConversationChars,
      resumedFromPersistedState: state.resumedFromPersistedState,
      updatedAt: new Date().toISOString(),
      managedContextBlocks: state.managedContextBlocks,
      plan: state.plan,
      lastHandoffSummary: state.lastHandoffSummary,
      lastHandoffTurn: state.lastHandoffTurn,
    };
    writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("[AgenticTools] writeRuntimeStateSync failed, session state was not persisted:", err);
  }
}

// Conversation size = composed history minus the system prompt. Exported for the cascade test:
// this subtraction is the whole fix for new chats inheriting a previous session's plan.
export function conversationLength(composedLength: number, systemPromptLength: number): number {
  return Math.max(0, composedLength - systemPromptLength);
}

// Render an @lmstudio/sdk Chat as conversation text.
//
// This exists because `Chat` has NO content-returning toString(). Calling it yields the object's
// debug representation — literally `"Chat {\n  system: \n}"` — so every consumer of history text in
// this file was measuring, fingerprinting and budgeting against a ~19-character constant that never
// changed no matter how long the conversation got. Confirmed live by logging the value in the
// running plugin. That silently disabled the new-conversation detection (every chat looked identical
// in size), and any compaction/budget logic keyed off history length.
//
// The real API is getLength() / at(i) plus ChatMessage's text, role, tool-request and tool-result
// accessors. Tool payloads are part of LM Studio's real prompt budget even when getText() is empty.
//
// The toString() fallback is deliberate and is NOT the old bug: it only runs for objects that do not
// expose getLength, which in practice means this file's test doubles (`{ toString: () => "..." }`).
// The real SDK object always takes the iteration path.
export function chatToText(history: any): string {
  if (!history) return "";
  try {
    if (typeof history.getLength === "function" && typeof history.at === "function") {
      const lines: string[] = [];
      const length = history.getLength();
      for (let i = 0; i < length; i++) {
        const message = history.at(i);
        const body = typeof message?.getText === "function" ? message.getText() : "";
        const toolCallRequests = typeof message?.getToolCallRequests === "function"
          ? message.getToolCallRequests()
          : [];
        const toolCallResults = typeof message?.getToolCallResults === "function"
          ? message.getToolCallResults()
          : [];
        const parts = [
          body,
          toolCallRequests.length > 0 ? `tool-call-requests: ${JSON.stringify(toolCallRequests)}` : "",
          toolCallResults.length > 0 ? `tool-call-results: ${JSON.stringify(toolCallResults)}` : "",
        ].filter(Boolean);
        if (parts.length === 0) continue;
        const role = typeof message?.getRole === "function" ? message.getRole() : "";
        const rendered = parts.join("\n");
        lines.push(role ? `${role}: ${rendered}` : rendered);
      }
      return lines.join("\n");
    }
    return typeof history.toString === "function" ? history.toString() : "";
  } catch {
    return "";
  }
}

async function readHistoryParts(
  ctl?: PromptPreprocessorController | ToolsProviderController,
): Promise<{ text: string; systemPromptLength: number } | null> {
  try {
    const history = await (ctl as any)?.pullHistory?.();
    if (!history) return null;
    const systemPrompt = history.getSystemPrompt?.() ?? "";
    return {
      text: composeHistoryText(systemPrompt, chatToText(history)),
      systemPromptLength: normalizeHistoryText(systemPrompt).length,
    };
  } catch {
    return null;
  }
}

// Does this turn's history belong to a different conversation than the one the in-memory session is
// tracking? Only ever answers true for a DRAMATIC shrink with no vibeLM-managed block present.
//
// Both conditions are load-bearing:
//  - Shrink alone is not enough: auto-compaction and the rolling window legitimately shrink history
//    mid-conversation, and wiping a plan there is exactly the bug 0.2.6 fixed.
//  - vibeLM re-injects its own managed-context block whenever it compacts/rolls, so that marker
//    surviving in history means "same conversation, just rolled". A brand new chat has no marker.
//
// Erring toward "same conversation" (a false negative) is what produced the live bug this guards:
// a fresh chat asking "what is 2+2?" answered with the previous chat's echo results. Erring the
// other way costs a re-plan, which the model recovers from on the next turn.
export function looksLikeDifferentConversation(
  previousConversationChars: number,
  incomingConversationChars: number,
  incomingHistoryText: string,
): boolean {
  if (previousConversationChars <= MIN_SUBSTANTIAL_HISTORY_CHARS) return false;
  if (incomingConversationChars >= previousConversationChars * NEW_CONVERSATION_LENGTH_RATIO) return false;
  return !hasManagedContext(incomingHistoryText);
}

async function bootstrapSessionState(ctl?: PromptPreprocessorController | ToolsProviderController, force = false): Promise<SessionState> {
  if (activeSessionInitialized && !force) {
    // The plugin process outlives individual chats: opening a new chat in LM Studio does NOT restart
    // it, so this early return used to hand every new chat the PREVIOUS chat's in-memory state —
    // plan, managed-context blocks and all — and the new-conversation detection below never ran even
    // once. Reproduced live: a brand new chat asking "what is 2+2?" replied with the prior session's
    // `echo one/two/three` results and was auto-titled "Running Echo Commands".
    //
    // Detection has to run per-turn, not once per process. It stays inside this early-return branch
    // (rather than falling through to the full bootstrap) so an ongoing conversation keeps its
    // session identity, turn counter and dedup history exactly as before — nothing changes unless
    // the history genuinely belongs to a different chat.
    const parts = await readHistoryParts(ctl);
    if (parts) {
      const previous = activeSessionState.lastSeenConversationChars;
      const incoming = conversationLength(parts.text.length, parts.systemPromptLength);
      if (looksLikeDifferentConversation(previous, incoming, parts.text)) {
        activeSessionState = createSessionState();
        activeSessionState.historyFingerprint = fingerprintHistoryText(parts.text);
        activeSessionState.historyTextLength = parts.text.length;
        activeSessionState.systemPromptLength = parts.systemPromptLength;
      }
      // Track the largest conversation size seen for this session. Using the max rather than the
      // latest keeps a host-side history roll (which shrinks the visible conversation without
      // starting a new chat) from quietly lowering the bar for the next comparison.
      activeSessionState.lastSeenConversationChars = Math.max(activeSessionState.lastSeenConversationChars, incoming);
      writeRuntimeStateSync(activeSessionState);
    }
    return activeSessionState;
  }

  if (force) {
    activeSessionInitialized = false;
    activeSessionBootstrapPromise = null;
    activeSessionState = createSessionState();
  }

  if (!activeSessionBootstrapPromise) {
    activeSessionBootstrapPromise = (async () => {
      const historyParts = await readHistoryParts(ctl);
      const historyText = historyParts?.text ?? null;
      const systemPromptLength = historyParts?.systemPromptLength ?? 0;
      if (!historyText) {
        // No history available at all (e.g. a vibe_bridge tick's internal ctl right after a hot
        // reload/process restart wiped module state, before any real preprocessMessage call has run
        // again). Session identity/counters can't be trusted, but — same as the fingerprint-mismatch
        // branch below — the last-known plan/managed-context is still worth re-asserting instead of
        // silently discarding it. Caught live: a mid-conversation `lms dev` rebuild dropped an
        // in-progress plan entirely because this branch had no such fallback while the sibling one did.
        activeSessionState = createSessionState();
        const persisted = readRuntimeStateSync();
        const completedPersistedPlan = isCompletedPlan(persisted?.plan);
        if (persisted && !completedPersistedPlan && ((persisted.managedContextBlocks?.length ?? 0) > 0 || planWorthCarryingForward(persisted.plan))) {
          activeSessionState.managedContextBlocks = persisted.managedContextBlocks ?? [];
          activeSessionState.plan = planWorthCarryingForward(persisted.plan) ? persisted.plan ?? null : null;
          activeSessionState.resumedFromPersistedState = true;
          // Carry the persisted SIZE forward too, not just the contents. This branch runs with no
          // history to check against, so the carryover above is provisional — it has no way to tell a
          // hot-reload mid-conversation from the first tool-enumeration of a brand new chat. It is
          // reached in production because LM Studio calls toolsProvider() (whose controller has no
          // pullHistory) before the prompt preprocessor, and it sets activeSessionInitialized, so the
          // NEXT call — preprocessMessage, which does have history — validates it via the early-return
          // check at the top of this function.
          //
          // Leaving these at createSessionState()'s 0 broke exactly that handoff: the validating check
          // compares against `previous` and bails out when previous <= MIN_SUBSTANTIAL_HISTORY_CHARS,
          // so a zero here made it decline to act and the plan survived into the new chat anyway.
          // Reproduced live: a fresh chat asking "what is 2+2?" answered with the previous chat's
          // echo results and was auto-titled "Sequential Echo Commands".
          activeSessionState.historyTextLength = persisted.historyTextLength ?? 0;
          activeSessionState.systemPromptLength = persisted.systemPromptLength ?? 0;
          // Fall back to the older historyTextLength for state files written before
          // lastSeenConversationChars existed. Without this, everyone upgrading would have the
          // new-chat check silently disabled (previous = 0 fails the MIN_SUBSTANTIAL floor) until
          // their first turn happened to repopulate it.
          // `||`, not `??`: readRuntimeStateSync normalizes a missing field to 0, so `??` would never
          // reach the fallback. 0 carries no information here, which makes `||` the correct choice.
          activeSessionState.lastSeenConversationChars = persisted.lastSeenConversationChars
            || conversationLength(persisted.historyTextLength ?? 0, persisted.systemPromptLength ?? 0);
        }
      } else {
        const historyFingerprint = fingerprintHistoryText(historyText);
        const persisted = readRuntimeStateSync();
        if (persisted && persisted.historyFingerprint === historyFingerprint) {
          const completedPersistedPlan = isCompletedPlan(persisted.plan);
          const carriedPlan = planWorthCarryingForward(persisted.plan) ? persisted.plan ?? null : null;
          const carriedBlocks = completedPersistedPlan ? [] : persisted.managedContextBlocks ?? [];
          activeSessionState = {
            sessionId: persisted.sessionId,
            turnCounter: persisted.turnCounter,
            toolCallHistory: [],
            lastCompactionTurn: persisted.lastCompactionTurn,
            historyFingerprint,
            historyTextLength: historyText.length,
            systemPromptLength,
            lastSeenConversationChars: conversationLength(historyText.length, systemPromptLength),
            resumedFromPersistedState: !completedPersistedPlan,
            managedContextBlocks: carriedBlocks,
            lastHandoffSummary: persisted.lastHandoffSummary ?? "",
            lastHandoffTurn: persisted.lastHandoffTurn ?? 0,
            plan: carriedPlan,
          };
        } else {
          activeSessionState = createSessionState();
          activeSessionState.historyFingerprint = historyFingerprint;
          activeSessionState.historyTextLength = historyText.length;
          activeSessionState.systemPromptLength = systemPromptLength;
          activeSessionState.lastSeenConversationChars = conversationLength(historyText.length, systemPromptLength);
          // A fingerprint mismatch is ambiguous: it's either (a) the process restarted mid-conversation
          // or the host rolled/truncated history — same conversation, still worth re-asserting the plan
          // — or (b) this is a genuinely new/different chat that happens to reuse the same persisted
          // state file. Conversation size distinguishes them: a restart/roll of an ongoing conversation
          // still carries a comparable (or larger) amount of text, while a brand new chat starts from
          // just the first message. Caught live: a fresh chat asking for an unrelated weather CLI
          // resurrected a many-turn REST-API-backend plan from a previous, unrelated session.
          //
          // This MUST compare conversation size, not composed history size. vibeLM's system prompt
          // (26 tool descriptions) is a multi-thousand-char constant present in every chat, and
          // composeHistoryText prepends it to both sides of the comparison. Measuring composed
          // lengths let that constant dominate: a brand new chat came out as systemPrompt + ~20 chars,
          // which is nowhere near 30% below an older chat's systemPrompt + conversation, so the guard
          // never fired and every new chat inherited the previous session's plan and managed-context
          // blocks. Reproduced live: a fresh chat was retitled "[vibeLM:managed-cont" because
          // preprocessMessage prepended a rehydration block ahead of the user's actual first message.
          const oldConversation = conversationLength(
            persisted?.historyTextLength ?? 0,
            persisted?.systemPromptLength ?? 0,
          );
          const newConversation = conversationLength(historyText.length, systemPromptLength);
          const looksLikeGenuinelyNewConversation = oldConversation > MIN_SUBSTANTIAL_HISTORY_CHARS
            && newConversation < oldConversation * NEW_CONVERSATION_LENGTH_RATIO;
          const completedPersistedPlan = isCompletedPlan(persisted?.plan);
          if (persisted && !completedPersistedPlan && !looksLikeGenuinelyNewConversation && ((persisted.managedContextBlocks?.length ?? 0) > 0 || planWorthCarryingForward(persisted.plan))) {
            // The raw history no longer matches what we last saw — either the process restarted
            // mid-conversation or the host rolled/truncated history. Session identity/counters can't
            // be trusted to still line up, but the last-known directive/plan is still worth
            // re-asserting rather than silently starting over with nothing.
            activeSessionState.managedContextBlocks = persisted.managedContextBlocks ?? [];
            activeSessionState.plan = planWorthCarryingForward(persisted.plan) ? persisted.plan ?? null : null;
            activeSessionState.resumedFromPersistedState = true;
          }
        }
      }

      activeSessionInitialized = true;
      writeRuntimeStateSync(activeSessionState);
      return activeSessionState;
    })().finally(() => {
      activeSessionBootstrapPromise = null;
    });
  }

  return activeSessionBootstrapPromise;
}

function syncRuntimeState(historyText?: string | null, state: SessionState = activeSessionState): void {
  if (typeof historyText === "string" && historyText.trim().length > 0) {
    state.historyFingerprint = fingerprintHistoryText(historyText);
    state.historyTextLength = historyText.length;
  }
  writeRuntimeStateSync(state);
}

function recordProcessedPrompt(historyText: string, processed: string, state: SessionState = activeSessionState): string {
  // Capture vibeLM's own emitted directive at the point it's sent, so it can be re-asserted if the
  // host rolls/truncates raw history before the model ever echoes it back. Bounded to the most
  // recent directive — no unbounded growth.
  if (processed.includes(MANAGED_CONTEXT_MARKER)) {
    state.managedContextBlocks = [processed];
  }
  syncRuntimeState([historyText, processed].filter(Boolean).join("\n"), state);
  return processed;
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.trim().length > 0))];
}

function currentWorkspacePath(ctl?: { getWorkingDirectory?: () => string }): string | null {
  const workspace = getWorkspace(ctl?.getWorkingDirectory?.());
  return workspace || null;
}

function buildMemoryTags(baseTags: string[], sessionId: string, workspace: string, scope: Exclude<MemoryScope, "all">): string[] {
  return dedupeTags([
    ...baseTags,
    compactSessionTag(sessionId),
    ...(workspace ? [compactWorkspaceTag(workspace)] : []),
    compactScopeTag(scope),
  ]);
}

function memoryFilterForScope(scope: MemoryScope, workspace: string, sessionId: string): { workspace?: string; sessionId?: string; scope?: "session" | "workspace" | "research" | "all" } {
  if (scope === "all") return { scope: "all" };
  if (scope === "session") return { workspace, sessionId, scope: "session" };
  if (scope === "research") return { workspace, scope: "research" };
  return { workspace, scope: "workspace" };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCharsFromTokens(tokens: number): number {
  return Math.max(1, tokens * 4);
}

function hardPromptBudgetLimit(contextWindow: number): number {
  return Math.max(512, Math.floor(contextWindow * PROMPT_BUDGET_RATIO));
}

// How to tell the model to deliver a final answer. Harmony families are not offered the `amend`
// tool (it collides with their native `final` channel — see the tool assembly in toolsProvider), so
// naming it in a directive would point them at a tool that is not in their toolset. They finish a
// turn by simply answering.
export function finishInstruction(harmony: boolean): string {
  return harmony
    ? "reply directly with the best available handoff"
    : "call amend with the best available handoff";
}

function formatPromptBudgetHandoff(
  contextWindow: number,
  estimatedTokens: number,
  mode: "workspace" | "multi-step" | "general",
  harmony = false,
  userMessage = "",
): string {
  // The returned string REPLACES the user's message (see recordProcessedPrompt's callers), so it has
  // to carry that message forward. Without this the user's turn is silently dropped: reproduced live
  // by lowering the trigger to 300 tokens and asking "now also tell me what day of the week it is" —
  // the model answered with a summary of the previous echo commands and never addressed the question.
  // That path was unreachable while history was read via Chat.toString() (it measured a ~19-char
  // constant, so the budget was never approached), and became reachable the moment history was read
  // correctly, which would have started eating user messages in long sessions.
  const request = userMessage.trim();
  const carried = request
    ? `\n[The user's latest message still needs an answer. Address it as part of that handoff:]\n${request}`
    : "";
  return `${MANAGED_CONTEXT_MARKER}
[Budget warning: estimated ${estimatedTokens}/${contextWindow} tokens with a ${COMPACT_CONTEXT_SAFETY_MARGIN}-token safety margin.]
[Action: preserve code verbatim, summarize only the actionable state, and ${finishInstruction(harmony)}.]${carried}
[If the user wants a clean slate, tell them to start a new chat and paste the summary.]`;
}

export function buildPromptBudgetReport(
  historyText: string,
  rewrittenText: string,
  contextWindow: number,
  rollingWindowTriggerTokens: number = hardPromptBudgetLimit(contextWindow),
): {
  estimatedTokens: number;
  hardLimitTokens: number;
  safetyMargin: number;
  rollingWindowTriggerTokens: number;
  rollingWindowTriggerCharsApprox: number;
  overflow: boolean;
  nearLimit: boolean;
} {
  const stripped = stripManagedContextBlocks(historyText);
  const combined = rewrittenText && stripped.includes(rewrittenText)
    ? stripped
    : [stripped, rewrittenText].filter(Boolean).join("\n");
  const estimatedTokens = estimateTokens(combined);
  const hardLimitTokens = hardPromptBudgetLimit(contextWindow);
  return {
    estimatedTokens,
    hardLimitTokens,
    safetyMargin: COMPACT_CONTEXT_SAFETY_MARGIN,
    rollingWindowTriggerTokens,
    rollingWindowTriggerCharsApprox: estimateCharsFromTokens(rollingWindowTriggerTokens),
    overflow: estimatedTokens > hardLimitTokens,
    nearLimit: estimatedTokens >= rollingWindowTriggerTokens,
  };
}

function estimateRecentSessionPromptTokens(session: SessionLog, state: SessionState): number {
  const recentTurns = session.readRecentTurns(COMPACT_CONTEXT_MAX_RECENT_TURNS, currentSessionId(state));
  const text = recentTurns.map((entry) => {
    const payload = extractToolPayload(entry);
    return [
      entry.role || "",
      entry.content || "",
      payload?.name || "",
      typeof payload?.args === "string" ? payload.args : JSON.stringify(payload?.args ?? ""),
      payload?.rawResult || "",
    ].join("\n");
  }).join("\n");
  return estimateTokens(text);
}

function compactTaskReminder(stepCount: number, latestRequest: string, harmony = false): string {
  const finish = harmony
    ? "Reply with your final answer when the task is done"
    : "Call amend when the task is done";
  return `${MANAGED_CONTEXT_MARKER}
[Latest user request — execute this exact request and prioritize it over recapping earlier work:]
${latestRequest}

[Task mode: follow all ${stepCount} listed steps in order. Use one tool call at a time. ${finish}, blocked, or you have the best available handoff and cannot safely continue.]`;
}

function compactContinueInstruction(latestRequest: string): string {
  return `${MANAGED_CONTEXT_MARKER}
[Latest user request — execute this exact request and prioritize it over recapping earlier work:]
${latestRequest}

[Continue from the last completed step. Do NOT restart. Read the history and proceed with the next uncompleted step.]`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

function toolSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

// A deliberately lossy signature: for shell tools it keys on the program name only (the first token of
// the command), so probing the same program with different arguments every turn collapses to a single
// signature the semantic loop guard can count. For every other tool it falls back to the exact
// signature, so non-shell behaviour — where different args usually mean genuinely different work
// (reading distinct files, etc.) — is left untouched and no new false positives are introduced.
export function coarseToolSignature(name: string, args: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(name)) {
    const command = typeof args.command === "string" ? args.command : "";
    const tokens = command.trim().split(/\s+/).filter(Boolean);
    // Skip common no-op prefixes so `sudo ls` and `ls` share a family.
    let i = 0;
    while (i < tokens.length && (tokens[i] === "sudo" || tokens[i] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i++;
    const program = tokens[i] || "";
    return `${name}:${program}`;
  }
  return `${name}:${stableStringify(args)}`;
}

function detectRepeatedToolSignature(state: SessionState, name: string, signature: string, coarse: string): string | null {
  state.toolCallHistory.push({ name, signature, coarse, ts: Date.now() });
  const keep = Math.max(LOOP_WINDOW, COARSE_LOOP_WINDOW);
  if (state.toolCallHistory.length > keep) {
    state.toolCallHistory = state.toolCallHistory.slice(-keep);
  }
  // Exact-signature guard: identical call repeated verbatim.
  const exactWindow = state.toolCallHistory.slice(-LOOP_WINDOW);
  if (exactWindow.length >= 4) {
    const last4 = exactWindow.slice(-4).map((t) => t.signature);
    if (last4.every((sig) => sig === last4[0])) {
      return exactWindow[exactWindow.length - 1].name;
    }
  }
  // A prior repeated call must not poison a different current tool. Only the signature being
  // attempted now can trip this non-consecutive guard.
  if (exactWindow.filter((entry) => entry.signature === signature).length >= 4) return name;
  // Semantic guard: only stop the CURRENT shell family after consecutive failed probes. Counting
  // successful calls caused legitimate workflows such as `node todo.js add/list/complete/clear` to
  // be rejected, while scanning every coarse family let an old bash loop block an unrelated tool.
  const coarseWindow = state.toolCallHistory.slice(-COARSE_LOOP_WINDOW);
  let consecutiveFailedProbes = 1; // the current call has not executed yet
  for (let i = coarseWindow.length - 2; i >= 0; i--) {
    const prior = coarseWindow[i];
    if (prior.coarse !== coarse || prior.outcome !== "fail") break;
    consecutiveFailedProbes++;
  }
  if (SHELL_TOOLS.has(name) && consecutiveFailedProbes >= COARSE_LOOP_THRESHOLD) return name;
  return null;
}

function shouldSaveCheckpoint(state: SessionState): boolean {
  if (state.turnCounter >= CHECKPOINT_INTERVAL_MAX) return true;
  if (state.turnCounter >= CHECKPOINT_INTERVAL_EARLY) {
    const lastCalls = state.toolCallHistory.slice(-3);
    if (lastCalls.length >= 3 && new Set(lastCalls.map((t: any) => t.name)).size === 1) return true;
  }
  return false;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

const HARMONY_CHANNEL_PREFIX = /<\|channel\|>[\s\S]*?<\|message\|>/gi;
const HARMONY_CONTROL_TOKEN = /<\|[a-z_]+\|>/gi;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const STRAY_THINK_TAG = /<\/?think>/gi;

// Strips model-side leakage (gpt-oss/Harmony channel tokens, GLM/Qwen <think> blocks) out of raw
// model-generated text before vibeLM persists or replays it into a future prompt. This does not,
// and cannot, fix the leak in LM Studio's own chat-bubble rendering (out of this plugin's reach) —
// it only stops vibeLM's own stored/reused data (tick handover, memory, handoff summaries) from
// getting polluted by it.
export function stripModelArtifacts(text: string): string {
  if (!text) return text;
  return text
    .replace(THINK_BLOCK, "")
    .replace(HARMONY_CHANNEL_PREFIX, "")
    .replace(HARMONY_CONTROL_TOKEN, "")
    .replace(STRAY_THINK_TAG, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

async function getHistoryText(ctl?: PromptPreprocessorController): Promise<string> {
  if (!ctl) return "";
  const parts = await readHistoryParts(ctl);
  if (!parts) return "";
  // Keep the system-prompt length current for every turn, not just at bootstrap. syncRuntimeState
  // persists historyTextLength on each turn, and the next chat's new-conversation check subtracts
  // this from it — a stale value would skew that comparison.
  activeSessionState.systemPromptLength = parts.systemPromptLength;
  return parts.text;
}

function hasManagedContext(historyText: string): boolean {
  return historyText.includes(MANAGED_CONTEXT_MARKER);
}

function extractWorkspaceFromMemory(entry: MemoryEntry): string | null {
  if (typeof entry.workspace === "string" && entry.workspace.trim()) {
    return entry.workspace.trim();
  }

  const content = entry.content?.trim();
  if (!content) return null;

  const workspaceLine = content.match(/^(?:workspace|Workspace):\s*(.+)$/m);
  if (workspaceLine?.[1]?.trim()) {
    return workspaceLine[1].trim();
  }

  const absolutePathMatch = content.match(/\/(?:[^/\s]+\/)*[^/\s]+/);
  return absolutePathMatch?.[0]?.trim() || null;
}

function resolveWorkspaceFromLatestMemory(session: SessionLog): string | null {
  const recentEntries = session.readRecentEntries(3);
  for (let i = recentEntries.length - 1; i >= 0; i--) {
    const entry = recentEntries[i];
    if (entry?.type !== "mem") continue;
    return extractWorkspaceFromMemory(entry as MemoryEntry);
  }
  return null;
}

export function normalizeManagedContextHistory(historyText: string): string {
  return stripManagedContextBlocks(historyText);
}

export function fingerprintManagedContextHistory(historyText: string): string {
  return fingerprintHistoryText(historyText);
}

export function getLatestWorkspaceMemory(session: SessionLog): string | null {
  return resolveWorkspaceFromLatestMemory(session);
}

export async function resolveSessionStateFromHistory(
  ctl?: PromptPreprocessorController | ToolsProviderController,
  force = false,
): Promise<SessionState> {
  return await bootstrapSessionState(ctl, force);
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unwrapToolResult(result: any): any {
  if (!result || typeof result !== "object") return result;
  if ("data" in result) return result.data;
  return result;
}

// Importance-tiered budget for how many chars of a result to keep verbatim. Information-bearing reads
// and searches get the high tier; failures get the low tier (already distilled into a fact); everything
// else gets the default. Replaces the old flat MAX_TOOL_RESULT_CHARS applied to every tool alike.
export function resultCharBudget(name: string | undefined, result: unknown): number {
  if (classifyToolOutcome(name ?? "", result).outcome === "fail") return TOOL_RESULT_CHARS_LOW;
  if (name && HIGH_VALUE_RESULT_TOOLS.has(name)) return TOOL_RESULT_CHARS_HIGH;
  return MAX_TOOL_RESULT_CHARS;
}

function stringifyToolResult(result: unknown, name?: string): string {
  const cap = resultCharBudget(name, result);
  try {
    return truncateText(JSON.stringify(result), cap);
  } catch {
    return truncateText(String(result), cap);
  }
}

const FACT_DETAIL_CHARS = 160;
const FACT_ARG_CHARS = 120;
// How many recent log entries to scan when deduping a distilled fact. ~3 entries are written per turn
// (turn + memory + occasional checkpoint), so this covers roughly the last ~20 turns — enough for a
// consecutive probing loop to collapse to a single fact.
const FACT_DEDUP_SCAN = 60;

// Classify a tool result into a coarse outcome plus a short human-readable detail. Shell tools report
// success/failure through the command's exitCode (a failed command still returns ok:true at the tool
// layer), so they're inspected specially; everything else keys off the tool's own ok flag.
function classifyToolOutcome(name: string, result: unknown): { outcome: "ok" | "fail" | "info"; detail: string } {
  const data = unwrapToolResult(result);
  if (SHELL_TOOLS.has(name) && data && typeof data === "object" && typeof (data as any).exitCode === "number") {
    const d = data as { exitCode: number; stdout?: string; stderr?: string; error?: string };
    if (d.exitCode === 0) return { outcome: "ok", detail: truncateText((d.stdout || "").trim(), FACT_DETAIL_CHARS) };
    return { outcome: "fail", detail: truncateText((d.stderr || d.error || `exit ${d.exitCode}`).trim(), FACT_DETAIL_CHARS) };
  }
  if (result && typeof result === "object" && "ok" in result) {
    if ((result as any).ok === false) {
      return { outcome: "fail", detail: truncateText(String((result as any).error || "").trim(), FACT_DETAIL_CHARS) };
    }
    return { outcome: "ok", detail: "" };
  }
  return { outcome: "info", detail: "" };
}

// Turn a tool call + result into a compact, deduplicable fact instead of dumping the raw (truncated)
// result blob into memory. `key` groups equivalent calls — for shell tools it's the program name and
// outcome, so 24 failing `ls <different path>` probes all share `bash_terminal:ls:fail` and collapse
// to one memory instead of 24 near-identical blobs.
export function distillToolFact(name: string, args: Record<string, unknown>, result: unknown): { key: string; fact: string } {
  const { outcome, detail } = classifyToolOutcome(name, result);
  // A successful call usually carries distinct information worth keeping on its own (e.g. `cat a.txt`
  // vs `cat b.txt` return different content), so key those on the exact signature — only true
  // duplicates collapse. Failures and info are the noise we want to fold together: a probing storm
  // (24 failing `ls <different path>`) shares one coarse `program:fail` key and dedupes to a single
  // fact. Keying successes coarsely too would silently drop every distinct successful result but the
  // first — a real data-loss bug caught in live testing.
  //
  // The success key is a HASH of the exact signature, never the raw signature: args can contain
  // secrets (e.g. ssh_exec's `password`), and this key is persisted as a `fact:` memory tag, so
  // embedding the raw args would leak credentials into stored/replayed context.
  const dedupeBasis = outcome === "ok"
    ? `${name}:#${createHash("sha256").update(toolSignature(name, args)).digest("hex").slice(0, 12)}`
    : coarseToolSignature(name, args);
  const key = `${dedupeBasis}:${outcome}`;
  const argHint = SHELL_TOOLS.has(name) && typeof args.command === "string"
    ? truncateText(args.command.trim(), FACT_ARG_CHARS)
    : typeof args.path === "string" ? args.path
    : typeof args.file === "string" ? args.file
    : typeof args.query === "string" ? truncateText(args.query.trim(), FACT_ARG_CHARS)
    : "";
  const verb = outcome === "ok" ? "ok" : outcome === "fail" ? "failed" : "done";
  const fact = `${name}${argHint ? ` \`${argHint}\`` : ""} → ${verb}${detail ? `: ${detail}` : ""}`;
  return { key, fact };
}

type CompactCodeSnippet = {
  source: string;
  path?: string;
  language?: string;
  content: string;
  referenceOnly?: boolean;
};

type CompactContextResult = {
  sessionId: string;
  turnCount: number;
  tokenEstimate: number;
  budget: {
    maxTokens: number;
    safetyMargin: number;
    triggerThreshold: number;
  };
  goal: string;
  nextActions: string[];
  openIssues: string[];
  completedSteps: string[];
  importantPaths: string[];
  codeSnippets: CompactCodeSnippet[];
  recentCommands: string[];
  sourceTurns: number[];
  savedToMemory: boolean;
  needsMoreContext: boolean;
  reason: string;
  reflection: string;
  handoff: string;
};

function extractPathLikeStrings(text: string): string[] {
  const paths = new Set<string>();
  const pathRe = /(?:^|[\s("'`])((?:\.{1,2}\/|\/)[^"'`\s]+|(?:[A-Za-z]:\\)[^"'`\s]+|(?:[\w.-]+\/)+[\w.-]+)(?=$|[\s)"'`.,:;!?])/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(text)) !== null) {
    const candidate = match[1].replace(/[),.;:!?]+$/, "");
    if (candidate.length > 1) paths.add(candidate);
  }
  return [...paths];
}

function inferLanguageFromPath(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".py":
      return "python";
    case ".sh":
      return "bash";
    case ".css":
      return "css";
    case ".html":
      return "html";
    default:
      return undefined;
  }
}

function extractGoalHint(
  session: SessionLog,
  sessionId: string,
  goalHint?: string,
): string {
  if (goalHint?.trim()) return goalHint.trim();

  const memories = session.readRecentMemories(100, sessionId);
  for (const entry of memories) {
    if (entry.tags.some((tag) => /goal|objective|task|plan/i.test(tag)) && entry.content.trim()) {
      return truncateText(entry.content.trim(), 400);
    }
  }

  const checkpoints = session.readRecentCheckpoints(50, sessionId);
  const lastCheckpoint = checkpoints[checkpoints.length - 1];
  if (lastCheckpoint?.summary?.trim()) return truncateText(lastCheckpoint.summary.trim(), 400);

  return "Need more context to determine the active goal.";
}

function extractToolPayload(entry: TurnEntry): { name: string; args: any; result: any; rawResult: string } | null {
  const call = entry.toolCalls?.[0];
  if (!call) return null;
  return {
    name: call.name,
    args: safeJsonParse(call.args),
    result: safeJsonParse(call.result ?? ""),
    rawResult: call.result ?? "",
  };
}

function extractCodeSnippetsFromTurn(entry: TurnEntry): CompactCodeSnippet[] {
  const payload = extractToolPayload(entry);
  if (!payload) return [];
  const snippets: CompactCodeSnippet[] = [];
  const { name, args, result, rawResult } = payload;
  const data = unwrapToolResult(result);

  if (name === "read_file" && typeof args?.filePath === "string") {
    snippets.push({
      source: `turn:${entry.turn}:${name}`,
      path: args.filePath,
      language: inferLanguageFromPath(args.filePath),
      content: "",
      referenceOnly: true,
    });
  }

  if ((name === "write_file" || name === "append_file") && typeof args?.content === "string") {
    snippets.push({
      source: `turn:${entry.turn}:${name}`,
      path: typeof args?.filePath === "string" ? args.filePath : undefined,
      language: inferLanguageFromPath(typeof args?.filePath === "string" ? args.filePath : undefined),
      content: "",
      referenceOnly: true,
    });
  }

  return snippets;
}

function buildCompactContextState(
  session: SessionLog,
  state: SessionState,
  options: {
    maxTokens: number;
    goalHint?: string;
    includeCode: boolean;
  },
): CompactContextResult {
  const sessionId = currentSessionId(state);
  const recentTurns = session.readRecentTurns(COMPACT_CONTEXT_MAX_RECENT_TURNS, sessionId);
  const recentMemories = session.readRecentMemories(100, sessionId);
  const recentCheckpoints = session.readRecentCheckpoints(100, sessionId);
  const sourceTurns = recentTurns.map((turn) => turn.turn);
  const interestingTurns = recentTurns.slice(-24);

  const completedSteps = new Set<string>();
  const openIssues = new Set<string>();
  const importantPaths = new Set<string>();
  const recentCommands = new Set<string>();
  const codeSnippets: CompactCodeSnippet[] = [];

  for (const entry of interestingTurns) {
    const payload = extractToolPayload(entry);
    if (!payload) continue;

    const { name, args, result, rawResult } = payload;
    const data = unwrapToolResult(result);
    const ok = result && typeof result === "object" ? result.ok !== false : !/error/i.test(rawResult);
    const errorText = typeof result?.error === "string" ? result.error : typeof result?.message === "string" ? result.message : rawResult;

    if (ok) {
      if (name === "read_file" && typeof args?.filePath === "string") {
        completedSteps.add(`Read ${args.filePath}`);
        importantPaths.add(args.filePath);
      } else if (name === "list_files" && typeof args?.path === "string") {
        completedSteps.add(`Listed ${args.path}`);
        importantPaths.add(args.path);
      } else if (name === "search_files" && typeof args?.path === "string") {
        completedSteps.add(`Searched ${args.path}`);
        importantPaths.add(args.path);
      } else if (name === "write_file" && typeof args?.filePath === "string") {
        completedSteps.add(`Wrote ${args.filePath}`);
        importantPaths.add(args.filePath);
      } else if (name === "append_file" && typeof args?.filePath === "string") {
        completedSteps.add(`Appended ${args.filePath}`);
        importantPaths.add(args.filePath);
      } else if (name === "rename_file" && typeof args?.sourcePath === "string" && typeof args?.destPath === "string") {
        completedSteps.add(`Renamed ${args.sourcePath} → ${args.destPath}`);
        importantPaths.add(args.sourcePath);
        importantPaths.add(args.destPath);
      } else if (name === "bash_terminal" && typeof args?.command === "string") {
        completedSteps.add(`Ran shell command: ${truncateText(args.command, 120)}`);
        recentCommands.add(args.command);
      } else {
        completedSteps.add(name);
      }
    } else {
      const issue = `${name}: ${truncateText(String(errorText || "failed"), 200)}`;
      openIssues.add(issue);
    }

    for (const path of extractPathLikeStrings(JSON.stringify(args ?? {}))) {
      importantPaths.add(path);
    }
    for (const path of extractPathLikeStrings(rawResult)) {
      importantPaths.add(path);
    }

    if (options.includeCode) {
      for (const snippet of extractCodeSnippetsFromTurn(entry)) {
        if (snippet.referenceOnly || snippet.content.trim()) codeSnippets.push(snippet);
      }
    }
  }

  const latestCompactMemory = [...recentMemories].reverse().find((entry) => entry.tags.some((tag) => /compact_context/i.test(tag)));

  if (latestCompactMemory?.content) {
    const existing = latestCompactMemory.content;
    for (const path of extractPathLikeStrings(existing)) importantPaths.add(path);
    for (const line of splitLines(existing)) {
      if (/^-\s+/.test(line) || /^\*\s+/.test(line)) {
        if (/open issue/i.test(line)) openIssues.add(line.replace(/^[-*]\s+/, ""));
        if (/next action/i.test(line)) completedSteps.add(line.replace(/^[-*]\s+/, ""));
      }
    }
  }

  const goal = extractGoalHint(session, sessionId, options.goalHint);
  const budgetText = [
    `Goal: ${goal}`,
    `Completed steps: ${[...completedSteps].join("; ")}`,
    `Open issues: ${[...openIssues].join("; ")}`,
    `Important paths: ${[...importantPaths].join("; ")}`,
    `Recent commands: ${[...recentCommands].join("; ")}`,
    `Code snippets: ${codeSnippets.map((snippet) => snippet.content).join("\n")}`,
  ].join("\n");

  const tokenEstimate = estimateTokens(budgetText);
  const reason = recentTurns.length === 0
    ? "No recent turns available."
    : tokenEstimate > options.maxTokens
      ? "Compacted state exceeds the configured budget."
      : "Compacted recent turns into reusable state.";

  const reflectionParts = [
    goal && goal !== "Need more context to determine the active goal." ? `Goal: ${goal}` : "Goal is still being established.",
    completedSteps.size > 0 ? `Progress: ${[...completedSteps].slice(-3).join("; ")}` : "Progress: no durable steps yet.",
    openIssues.size > 0 ? `Blockers: ${[...openIssues].slice(-3).join("; ")}` : "Blockers: none captured.",
  ];
  const reflection = reflectionParts.join(" ");

  const nextActions: string[] = [];
  if (openIssues.size > 0) {
    nextActions.push("Resolve the open issues before continuing.");
  }
  if (completedSteps.size === 0) {
    nextActions.push("Collect more signal from the session before taking action.");
  } else {
    nextActions.push("Continue from the latest completed step.");
  }
  if (recentCommands.size > 0) {
    nextActions.push("Reuse the most recent shell commands only if they still apply.");
  }

  const snippets = options.includeCode
    ? codeSnippets
        .slice(0, 5)
        .map((snippet) => ({
          ...snippet,
          content: truncateText(snippet.content, 800),
        }))
    : [];

  const compact: CompactContextResult = {
    sessionId,
    turnCount: state.turnCounter,
    tokenEstimate,
    budget: {
      maxTokens: options.maxTokens,
      safetyMargin: COMPACT_CONTEXT_SAFETY_MARGIN,
      triggerThreshold: Math.floor(options.maxTokens * COMPACT_CONTEXT_TRIGGER_RATIO),
    },
    goal,
    nextActions,
    openIssues: [...openIssues].slice(0, 10),
    completedSteps: [...completedSteps].slice(0, 20),
    importantPaths: [...importantPaths].slice(0, 20),
    codeSnippets: snippets,
    recentCommands: [...recentCommands].slice(0, 10),
    sourceTurns,
    savedToMemory: false,
    needsMoreContext: recentTurns.length < 2 || (completedSteps.size === 0 && openIssues.size === 0 && snippets.length === 0),
    reason,
    reflection,
    handoff: formatCompactHandoff({
      sessionId,
      turnCount: state.turnCounter,
      tokenEstimate,
      budget: {
        maxTokens: options.maxTokens,
        safetyMargin: COMPACT_CONTEXT_SAFETY_MARGIN,
        triggerThreshold: Math.floor(options.maxTokens * COMPACT_CONTEXT_TRIGGER_RATIO),
      },
      goal,
      nextActions,
      openIssues: [...openIssues].slice(0, 10),
      completedSteps: [...completedSteps].slice(0, 20),
      importantPaths: [...importantPaths].slice(0, 20),
      codeSnippets: snippets,
      recentCommands: [...recentCommands].slice(0, 10),
      sourceTurns,
      savedToMemory: false,
      needsMoreContext: recentTurns.length < 2 || (completedSteps.size === 0 && openIssues.size === 0 && snippets.length === 0),
      reason,
      reflection,
      handoff: "",
    }, options.goalHint?.trim() || currentWorkspacePath() || readConfigSync().workspacePath?.trim() || undefined),
  };

  return compact;
}

function compactContextText(state: CompactContextResult): string {
  const lines = [
    `sessionId: ${state.sessionId}`,
    `turnCount: ${state.turnCount}`,
    `goal: ${state.goal}`,
  ];

  if (state.reflection) {
    lines.push(`reflection: ${state.reflection}`);
  }

  if (state.codeSnippets.length > 0) {
    lines.push(`verbatimCodeSnippets:`);
    for (const snippet of state.codeSnippets) {
      lines.push(`- source: ${snippet.source}`);
      if (snippet.path) lines.push(`  path: ${snippet.path}`);
      if (snippet.language) lines.push(`  language: ${snippet.language}`);
      if (snippet.referenceOnly) {
        lines.push(`  content: [omitted; local source should be re-read on demand]`);
      } else {
        lines.push(`  content: |`);
        lines.push(...snippet.content.split(/\r?\n/).map((line) => `    ${line}`));
      }
    }
  }

  lines.push(`nextActions:`);
  lines.push(...state.nextActions.map((item) => `- ${item}`));
  lines.push(`completedSteps:`);
  lines.push(...state.completedSteps.map((item) => `- ${item}`));
  lines.push(`openIssues:`);
  lines.push(...state.openIssues.map((item) => `- ${item}`));
  lines.push(`importantPaths:`);
  lines.push(...state.importantPaths.map((item) => `- ${item}`));
  lines.push(`recentCommands:`);
  lines.push(...state.recentCommands.map((item) => `- ${item}`));

  lines.push(`sourceTurns: ${state.sourceTurns.join(", ")}`);
  lines.push(`reason: ${state.reason}`);
  lines.push(`needsMoreContext: ${state.needsMoreContext}`);
  if (state.handoff) {
    lines.push(`handoff: |`);
    lines.push(...state.handoff.split(/\r?\n/).map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

function formatCompactHandoff(state: CompactContextResult, workspace?: string): string {
  const lines = [
    "Start a new chat and paste this summary.",
    `Scope: session ${state.sessionId}`,
    `Workspace: ${workspace?.trim() || "(unset)"}`,
    `Goal: ${state.goal}`,
    `Reflection: ${state.reflection}`,
    `Next actions:`,
    ...state.nextActions.map((item) => `- ${item}`),
    `Open issues:`,
    ...state.openIssues.map((item) => `- ${item}`),
  ];
  return lines.join("\n");
}

function shouldAutoCompactSession(
  session: SessionLog,
  state: SessionState,
  contextWindow: number,
  triggerRatio: number = COMPACT_CONTEXT_TRIGGER_RATIO,
): boolean {
  if (state.turnCounter < COMPACT_CONTEXT_TRIGGER_TURNS) return false;
  if (state.turnCounter - state.lastCompactionTurn < COMPACT_CONTEXT_MIN_GAP_TURNS) return false;
  const recentTurns = session.readRecentTurns(COMPACT_CONTEXT_MAX_RECENT_TURNS, currentSessionId(state));
  if (recentTurns.length === 0) return false;
  const text = recentTurns.map((entry) => {
    const payload = extractToolPayload(entry);
    return [
      entry.content || "",
      payload?.rawResult || "",
      payload?.name || "",
    ].join("\n");
  }).join("\n");
  const tokenEstimate = estimateTokens(text);
  return tokenEstimate >= Math.floor(contextWindow * triggerRatio);
}

function saveCompactContext(
  session: SessionLog,
  state: SessionState,
  compact: CompactContextResult,
  workspace?: string,
): CompactContextResult {
  const content = compactContextText(compact);
  const resolvedWorkspace = workspace?.trim() || currentWorkspacePath() || "";
  session.saveMemory(
    buildMemoryTags(["compact_context", `turn:${compact.turnCount}`], compact.sessionId, resolvedWorkspace, "session"),
    content,
    compact.turnCount,
    compact.sessionId,
    resolvedWorkspace || undefined,
    "session",
  );
  session.saveCheckpoint(
    `compact_context saved at turn ${compact.turnCount}`,
    ["compact_context", compactSessionTag(compact.sessionId)],
    compact.turnCount,
    compact.sessionId,
  );
  state.lastCompactionTurn = compact.turnCount;
  return { ...compact, savedToMemory: true };
}

async function compactSessionContext(
  session: SessionLog,
  state: SessionState,
  options: {
    maxTokens?: number;
    goalHint?: string;
    includeCode?: boolean;
    saveToMemory?: boolean;
    force?: boolean;
    workspace?: string;
  } = {},
): Promise<{ ok: true; data: CompactContextResult } | { ok: false; error: string }> {
  const maxTokens = Math.max(
    200,
    Math.min(
      options.maxTokens ?? COMPACT_CONTEXT_DEFAULT_MAX_TOKENS,
      Math.max(COMPACT_CONTEXT_DEFAULT_MAX_TOKENS, options.maxTokens ?? COMPACT_CONTEXT_DEFAULT_MAX_TOKENS),
    ),
  );
  const compact = buildCompactContextState(session, state, {
    maxTokens,
    goalHint: options.goalHint,
    includeCode: options.includeCode !== false,
  });

  if (!options.force && compact.needsMoreContext) {
    return {
      ok: true,
      data: {
        ...compact,
        reason: `${compact.reason} Need more context before a stable compaction is possible.`,
      },
    };
  }

  if (compact.tokenEstimate > maxTokens) {
    const trimmed = {
      ...compact,
      codeSnippets: compact.codeSnippets.slice(0, 2).map((snippet) => ({
        ...snippet,
        content: truncateText(snippet.content, 300),
      })),
      openIssues: compact.openIssues.slice(0, 5),
      completedSteps: compact.completedSteps.slice(0, 8),
      importantPaths: compact.importantPaths.slice(0, 8),
      recentCommands: compact.recentCommands.slice(0, 5),
      nextActions: compact.nextActions.slice(0, 4),
      reason: "Compacted output was trimmed to fit the configured budget.",
    };
    if ((trimmed.codeSnippets.length > 0 || trimmed.completedSteps.length > 0 || trimmed.openIssues.length > 0) && options.saveToMemory !== false) {
      return { ok: true, data: saveCompactContext(session, state, trimmed, options.workspace) };
    }
    return { ok: true, data: trimmed };
  }

  if (options.saveToMemory !== false) {
    return { ok: true, data: saveCompactContext(session, state, compact, options.workspace) };
  }
  return { ok: true, data: compact };
}

function wrapTool(toolDef: any, name: string, sessionState: SessionState = activeSessionState): any {
  const origImpl = toolDef.implementation;
  const state = sessionState;
  return {
    ...toolDef,
    implementation: async (args: Record<string, unknown>, ctx: any) => {
      const maxTurns = activeMaxOrchestratorTurns;
      state.turnCounter++;
      if (state.resumedFromPersistedState) {
        state.resumedFromPersistedState = false;
      }

      if (maxTurns > 0 && name !== "amend" && state.turnCounter > maxTurns) {
        const harmony = usesHarmonyFinalChannel(await getLoadedModelArch());
        return {
          ok: false,
          error: `Max turns (${maxTurns}) exceeded. ${finishInstruction(harmony)}.`,
        };
      }

      const looped = detectRepeatedToolSignature(state, name, toolSignature(name, args), coarseToolSignature(name, args));
      if (looped) {
        const harmony = usesHarmonyFinalChannel(await getLoadedModelArch());
        return {
          ok: false,
          error: `Loop detected: tool "${looped}" has been called repeatedly without making progress (same call or same command probed with different arguments). Stop retrying the same approach — the earlier results already tell you what you need. Change strategy, or ${finishInstruction(harmony)}.`,
        };
      }

      console.log(`[AgenticTools] [turn ${state.turnCounter}] Tool: ${name}`);

      let result: any;
      try {
        result = await origImpl(args, ctx);
      } catch (e: any) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      // Feed the semantic guard real progress information. Exact duplicate calls are still guarded
      // before execution, but distinct successful commands reset the coarse no-progress streak.
      const currentHistoryEntry = [...state.toolCallHistory].reverse().find((entry) => entry.signature === toolSignature(name, args) && entry.outcome === undefined);
      if (currentHistoryEntry) currentHistoryEntry.outcome = classifyToolOutcome(name, result).outcome;

      const log = getSessionLog();
      const serializedResult = stringifyToolResult(result, name);
      const workspace = currentWorkspacePath(ctx) || undefined;
      const turnEntry: TurnEntry = {
        type: "turn",
        sessionId: currentSessionId(state),
        ts: new Date().toISOString(),
        turn: state.turnCounter,
        role: "tool",
        content: name,
        toolCalls: [{ name, args: JSON.stringify(args), result: serializedResult }],
      };
      log.startTurn(turnEntry);
      // Distil the call into a compact, deduplicable fact rather than dumping the raw result blob.
      // Equivalent calls (same shell program + outcome) share a `fact:` key, so a probing loop
      // collapses to one memory instead of dozens of near-identical entries that only add retrieval
      // noise. Computed once and reused for the checkpoint summary below.
      const distilled = distillToolFact(name, args, result);
      if (!readOnlyTools.includes(name) && !["save_memory","compact_context","search_memory","list_memories","clear_memories","delete_memory","update_memory"].includes(name)) {
        const factTag = `fact:${distilled.key}`;
        const recentMems = log.readRecentMemories(FACT_DEDUP_SCAN, currentSessionId(state));
        const alreadyKnown = recentMems.some((m) => Array.isArray(m.tags) && m.tags.includes(factTag));
        if (!alreadyKnown) {
          const tags = buildMemoryTags([`turn:${state.turnCounter}`, `tool:${name}`, factTag], currentSessionId(state), workspace || "", "workspace");
          log.saveMemory(tags, distilled.fact, state.turnCounter, currentSessionId(state), workspace || undefined, "workspace");
        }
      }

      if (shouldSaveCheckpoint(state)) {
        log.saveCheckpoint(
          `Turn ${state.turnCounter}: ${distilled.fact}`,
          ["checkpoint", `turn:${state.turnCounter}`],
          state.turnCounter,
          currentSessionId(state),
        );
      }

      if (name !== "compact_context" && shouldAutoCompactSession(log, state, await getContextWindow(ctx), resolveCompactionTriggerRatio(ctx))) {
        const compact = await compactSessionContext(log, state, {
          saveToMemory: true,
          includeCode: true,
          force: true,
          workspace,
        });
        if (compact.ok) {
          console.log(`[AgenticTools] Auto-compacted session ${currentSessionId(state)} at turn ${state.turnCounter}`);
        }
      }

      syncRuntimeState(undefined, state);
      return result;
    },
  };
}

async function webSearch(query: string, maxResults: number = 5): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const config = readConfigSync();
  const endpoint = (config as any).searchEndpoint || process.env.AGENTIC_SEARCH_ENDPOINT || "http://localhost:8394/search";
  const url = `${endpoint}?q=${encodeURIComponent(query)}&format=json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "AgenticTools/1.0" } });
  } catch { clearTimeout(t); return []; }
  clearTimeout(t);
  if (!resp.ok) return [];
  const data = await resp.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
  return (data.results || []).slice(0, maxResults);
}

function ok(data: unknown) {
  return { ok: true, data };
}

function fail(msg: string) {
  return { ok: false, error: msg };
}

export { webSearch, binaryExtCheck, pickBestModel, VLM_PATTERNS, checkBashCommandSafety };

export async function toolsProvider(ctl: ToolsProviderController, client?: LMStudioClient | null) {
  _bridgeClient = client ?? null;
  // No force here: ToolsProviderController has no pullHistory() (unlike PromptPreprocessorController),
  // so a forced bootstrap can never read real history and always falls back to a fresh session — wiping
  // sessionId/turnCounter on every single call. toolsProvider() runs once per turn, so that discarded
  // the session state preprocessMessage() had just correctly established moments earlier, every turn
  // (caught live: sessionId regenerated and turnCounter stayed 0 across an entire multi-turn chat).
  // The un-forced call reuses that state; the one legitimate resume-from-restart check still happens
  // via whichever of preprocessMessage/toolsProvider runs first after a process restart.
  const sessionState = await bootstrapSessionState(ctl);
  activeSessionState = sessionState;
  activeMaxOrchestratorTurns = resolveMaxOrchestratorTurns(ctl);
  activeRollingWindowTriggerTokens = DEFAULT_ROLLING_WINDOW_TRIGGER_TOKENS;

  const setWorkspaceTool = wrapTool(tool({
    name: "set_workspace",
    description: text`Changes the workspace root for all file and bash operations. The workspace is persisted across sessions.
USE WHEN: you need to change where file operations run. Always call this first if the user hasn't set a workspace.
EXAMPLE: set_workspace({ path: "/Users/name/project" })`,
    parameters: {
      path: z.string().min(1).describe("Absolute path to the workspace folder"),
    },
    implementation: async ({ path }) => {
      const resolved = resolve(path);
      if (!existsSync(resolved)) return fail(`Workspace path not found: ${resolved}. Call set_workspace({ path: "/absolute/path" }) with an existing folder.`);
      if (!statSync(resolved).isDirectory()) return fail(`Workspace path is not a directory: ${resolved}. Call set_workspace({ path: "/absolute/path" }) with a folder.`);
      const config = readConfigSync();
      const prev = config.workspacePath;
      config.workspacePath = resolved;
      writeConfigSync(config);
      return ok({ previous: prev, workspace: resolved });
    },
  }), "set_workspace");

  const exploreWorkspaceTool = wrapTool(tool({
    name: "explore_workspace",
    description: text`Produces a shallow inventory of the workspace or a subdirectory.
USE WHEN: you want to inspect the current workspace structure without recursive content search.
EXAMPLE: explore_workspace({ path: "." }) returns the top-level entries in the workspace.
NOTE: This does not search file contents; it only lists the requested directory and summarizes what is there.`,
    parameters: {
      path: z.string().optional().default(".").describe("Directory relative to workspace"),
      maxEntries: z.number().int().min(1).max(200).optional().default(50).describe("Maximum entries to return"),
    },
    implementation: async ({ path, maxEntries }) => {
      try {
        const ws = requireWorkspace(ctl);
        const dir = sandboxPath(ws, path);
        if (!existsSync(dir)) return fail(`Path not found: ${dir}`);
        const st = statSync(dir);
        if (!st.isDirectory()) return fail(`Is not a directory: ${dir}`);
        const entries = readdirSync(dir, { withFileTypes: true });
        const limited = entries.slice(0, maxEntries);
        return ok({
          workspace: ws,
          path: dir,
          summary: {
            totalEntries: entries.length,
            directories: entries.filter((entry) => entry.isDirectory()).length,
            files: entries.filter((entry) => entry.isFile()).length,
            truncated: entries.length > limited.length,
          },
          entries: limited.map((entry) => {
            const full = resolve(dir, entry.name);
            let size: number | null = null;
            try { if (entry.isFile()) size = statSync(full).size; } catch {}
            return { name: entry.name, type: entry.isDirectory() ? "directory" : "file", size };
          }),
        });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "explore_workspace");

  const getConfigTool = wrapTool(tool({
    name: "get_config",
    description: text`Returns current configuration: workspace path, memory stats, config file info.
USE WHEN: you need to check where the workspace is or how many memories are stored.
EXAMPLE: get_config()`,
    parameters: {},
    implementation: async () => {
      const config = readConfigSync();
      const session = getSessionLog();
      const workspace = requireWorkspace(ctl);
      const promptEstimate = estimateRecentSessionPromptTokens(session, sessionState);
      const contextWindow = await getContextWindow(ctl);
      const configuredRollingWindowTriggerTokens = resolveConfiguredRollingWindowTriggerTokens(ctl);
      const effectiveRollingWindowTriggerTokens = resolveRollingWindowTriggerTokens(contextWindow, configuredRollingWindowTriggerTokens);
      activeRollingWindowTriggerTokens = effectiveRollingWindowTriggerTokens;
      return ok({
        workspace,
        sessionId: currentSessionId(sessionState),
        configFile: CONFIG_PATH,
        configFileExists: existsSync(CONFIG_PATH),
        config,
        totalMemories: session.countEntriesByType("mem"),
        totalCheckpoints: session.countEntriesByType("checkpoint"),
        totalTurnsLogged: session.totalTurnsLogged(),
        sessionWorkingDirectory: ctl.getWorkingDirectory(),
        maxOrchestratorTurns: activeMaxOrchestratorTurns,
        rollingWindowTriggerTokensConfigured: configuredRollingWindowTriggerTokens,
        rollingWindowTriggerTokens: effectiveRollingWindowTriggerTokens,
        rollingWindowTriggerCharsApprox: estimateCharsFromTokens(effectiveRollingWindowTriggerTokens),
        promptBudget: {
          contextWindow,
          hardLimitTokens: hardPromptBudgetLimit(contextWindow),
          estimatedTokens: promptEstimate,
          safetyMargin: COMPACT_CONTEXT_SAFETY_MARGIN,
          rollingWindowTriggerTokensConfigured: configuredRollingWindowTriggerTokens,
          rollingWindowTriggerTokens: effectiveRollingWindowTriggerTokens,
          rollingWindowTriggerCharsApprox: estimateCharsFromTokens(effectiveRollingWindowTriggerTokens),
          risk: promptEstimate >= hardPromptBudgetLimit(contextWindow) ? "high" : promptEstimate >= Math.floor(hardPromptBudgetLimit(contextWindow) * 0.85) ? "medium" : "low",
          recommendedOverflowPolicy: promptEstimate >= hardPromptBudgetLimit(contextWindow)
            ? "compact_context"
            : promptEstimate >= effectiveRollingWindowTriggerTokens
              ? "rollingWindow"
              : "stopAtLimit",
        },
      });
    },
  }), "get_config");

  const webFetchTool = wrapTool(tool({
    name: "web_fetch",
    description: text`Fetches a URL and returns text content (max 500KB).
USE WHEN: you need to read the actual content of a webpage. Call web_search first to find the URL.
EXAMPLE: web_fetch({ url: "https://example.com", maxChars: 50000 })
NOTE: Only returns text content. JavaScript-rendered content may not be captured.`,
    parameters: {
      url: z.string().url().describe("The URL to fetch"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars (default 50000)"),
    },
    implementation: async ({ url, maxChars }) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        const resp = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "LMStudio-AgenticTools/1.0" } });
        clearTimeout(t);
        if (!resp.ok) return fail(`HTTP ${resp.status}`);
        const text = await resp.text();
        if (text.length > maxChars) return ok({ content: text.slice(0, maxChars), truncated: true, originalLength: text.length });
        return ok({ content: text });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "web_fetch");

  const calculateTool = wrapTool(tool({
    name: "calculate",
    description: text`Evaluates a math expression: arithmetic, trig, log, stats, units.
USE WHEN: you need to compute something numerical. Supports +, -, *, /, sin, cos, log, sqrt, etc.
EXAMPLE: calculate({ expression: "sin(45 deg) + sqrt(144)" })
NOTE: For complex expressions, keep them under 500 chars.`,
    parameters: {
      expression: z.string().min(1).max(500).describe("Math expression to evaluate"),
    },
    implementation: async ({ expression }) => {
      try {
        const result = math.evaluate(expression);
        if (typeof result === "object" && result?.toString) return ok({ result: result.toString() });
        return ok({ result });
      } catch (e) { return fail(`Evaluation error: ${e instanceof Error ? e.message : String(e)}`); }
    },
  }), "calculate");

  const currentDateTimeTool = wrapTool(tool({
    name: "get_current_datetime",
    description: text`Returns current date, time, timezone, and unix timestamp.
USE WHEN: you need to know the current time, date, or timezone for context.
EXAMPLE: get_current_datetime()
NOTE: Call with exactly an empty object: {}. Do not add an empty-string key or placeholder property. This uses the system clock. Timezone reflects local machine settings.`,
    parameters: {},
    implementation: async () => {
      const now = new Date();
      return ok({
        iso: now.toISOString(),
        date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short" }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        unixTimestamp: Math.floor(now.getTime() / 1000),
        components: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(), dayOfWeek: now.getDay(), hours: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds() },
      });
    },
  }), "get_current_datetime");

  const amendTool = tool({
    name: "amend",
    description: text`Return the best available answer, progress update, or handoff summary to the user.
USE WHEN: the task is complete, blocked, out of budget, or you need to hand off partial progress clearly.
NOTE: If the session is already at the turn cap, this tool should still be allowed to return the current state even if the task is not fully complete.
EXAMPLE: amend({ text: "Here is the current status and the next blocker..." })`,
    parameters: {
      text: z.string().min(1).max(100000).describe("Your complete final response to the user"),
    },
    implementation: async ({ text }) => {
      activeSessionState.turnCounter++;
      const atTurnCap = activeMaxOrchestratorTurns > 0 && activeSessionState.turnCounter >= activeMaxOrchestratorTurns;
      if (!atTurnCap && /let me know|what next|how can i assist|would you like|tell me what|happy to help|if you'd like|let me know if/i.test(text)) {
        return {
          ok: false,
          error: "This response looks like a passive handoff. Return concrete progress, blockers, or the final answer instead.",
        };
      }
      if (!atTurnCap) {
        const plan = activeSessionState.plan;
        const untouched = plan?.steps.filter((s) => s.status === "pending") ?? [];
        if (untouched.length > 0) {
          return {
            ok: false,
            error: `Plan "${plan!.goal}" still has ${untouched.length} untouched step(s), starting with "${untouched[0].description}". Execute it with your available tools (bash_terminal, file tools, etc.) and call update_plan_step, or call update_plan_step with status "blocked" and a note explaining why before calling amend.`,
          };
        }
      }
      // Sanitize before persisting/reusing — raw model output can carry leaked Harmony/<think> tags
      // (see stripModelArtifacts) that would otherwise get replayed into a future prompt via
      // managedContextBlocks or lastHandoffSummary.
      const sanitizedText = stripModelArtifacts(text);
      activeSessionState.lastHandoffSummary = sanitizedText;
      activeSessionState.lastHandoffTurn = activeSessionState.turnCounter;
      const managedBlock = new RegExp(`${escapeRegExp(MANAGED_CONTEXT_MARKER)}[\\s\\S]*?(?=\\n{2,}|$)`, "g");
      const blocks: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = managedBlock.exec(sanitizedText)) !== null) {
        blocks.push(match[0]);
      }
      if (blocks.length > 0) {
        activeSessionState.managedContextBlocks = blocks;
      }
      writeRuntimeStateSync(activeSessionState);
      return {
        ok: true,
        data: { text: sanitizedText },
      };
    },
  });

  const createPlanTool = wrapTool(tool({
    name: "create_plan",
    description: text`Creates or replaces the session's execution plan — an ordered list of concrete steps toward a goal.
USE WHEN: a request needs more than one action to complete. Create the plan, THEN execute each step yourself with your other tools (bash_terminal, file tools, etc.) — do not just describe the plan to the user and stop. Before claiming a capability (node, npm, docker, cron, etc.) is missing, check it yourself with bash_terminal rather than assuming a bare environment.
Each step can optionally set "thinking" ("off"|"low"|"medium"|"high") to override the session's reasoning-effort setting just for that step — mark mechanical steps "off" and tricky ones "high" instead of applying one uniform level everywhere.
The steps array contains ONLY step strings or { description, thinking } objects. Do not insert numeric list labels such as 1, 2, or 3 as array items; array order already defines numbering.
EXAMPLE: create_plan({ goal: "Set up a nightly backup of /data", steps: ["Check what's installed: which cron crontab", { description: "Design the backup retention policy", thinking: "high" }, "Write backup script to /data/backup.sh", "Register the crontab entry", "Verify with crontab -l"] })`,
    parameters: {
      goal: z.string().min(1).max(2000),
      steps: z.array(z.union([
        z.string().min(1).max(1000),
        z.object({
          description: z.string().min(1).max(1000),
          thinking: z.enum(REASONING_EFFORT_VALUES).optional(),
        }),
      ])).min(1).max(30),
      autoStart: z.boolean().optional().describe("Auto-start vibe_bridge (if enabled) so the plan keeps executing across ticks unattended. Defaults to true."),
    },
    implementation: async ({ goal, steps, autoStart }) => {
      const now = new Date().toISOString();
      activeSessionState.plan = {
        goal,
        createdAt: now,
        updatedAt: now,
        steps: steps.map((s, index) => typeof s === "string"
          ? { index, description: s, status: "pending" as const }
          : { index, description: s.description, status: "pending" as const, thinking: s.thinking }),
      };
      writeRuntimeStateSync(activeSessionState);
      const shouldAutoStart = autoStart !== false;
      let bridgeStarted = false;
      if (shouldAutoStart && !_bridgeActive && resolveEnabledToolNames(ctl).includes("vibe_bridge")) {
        startBridge({ prompt: `Continue executing the plan: "${goal}".` });
        bridgeStarted = true;
      }
      return ok({ plan: activeSessionState.plan, bridgeStarted });
    },
  }), "create_plan");

  const updatePlanStepTool = wrapTool(tool({
    name: "update_plan_step",
    description: text`Updates the status of one step in the current plan.
USE WHEN: you finish, start, or get blocked on a plan step. Call this immediately after acting on a step — don't batch updates.
EXAMPLE: update_plan_step({ index: 0, status: "done" })`,
    parameters: {
      index: z.number().int().min(0),
      status: z.enum(["pending", "in_progress", "done", "blocked"]),
      note: z.string().max(1000).optional().describe("Context for the status change, required in practice when marking a step blocked"),
      thinking: z.enum(REASONING_EFFORT_VALUES).optional().describe("Override the reasoning effort for this step (in place of the session-wide default) while it's current."),
    },
    implementation: async ({ index, status, note, thinking }) => {
      const plan = activeSessionState.plan;
      if (!plan) return fail("No active plan. Call create_plan first.");
      const step = plan.steps[index];
      if (!step) return fail(`No step at index ${index}; plan has ${plan.steps.length} steps.`);
      step.status = status;
      if (note) step.note = note;
      if (thinking) step.thinking = thinking;
      plan.updatedAt = new Date().toISOString();
      writeRuntimeStateSync(activeSessionState);
      return ok({ plan });
    },
  }), "update_plan_step");

  const getPlanTool = wrapTool(tool({
    name: "get_plan",
    description: "Returns the current plan and each step's status, or null if no plan is active. Call with exactly an empty object: {}. Do not pass goal, steps, or any other properties.",
    parameters: {},
    implementation: async () => ok({ plan: activeSessionState.plan }),
  }), "get_plan");

  const listFilesTool = wrapTool(tool({
    name: "list_files",
    description: text`Lists files and directories relative to the workspace root.
USE WHEN: you need to see what files exist in a directory before reading or searching.
EXAMPLE: list_files({ path: "src" }) lists files in the 'src' subdirectory.
NOTE: If path is omitted, lists the workspace root directory. Returns entry names, types, and file sizes.`,
    parameters: {
      path: z.string().optional().default(".").describe("Directory relative to workspace"),
    },
    implementation: async ({ path }) => {
      try {
        const ws = requireWorkspace(ctl);
        const dir = sandboxPath(ws, path);
        const entries = readdirSync(dir, { withFileTypes: true });
        return ok({
          workspace: ws,
          path: dir,
          entries: entries.map((e) => {
            const full = resolve(dir, e.name);
            let size: number | null = null;
            try { if (e.isFile()) size = statSync(full).size; } catch {}
            return { name: e.name, type: e.isDirectory() ? "directory" : "file", size };
          }),
          count: entries.length,
        });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "list_files");

  const readFileTool = wrapTool(tool({
    name: "read_file",
    description: text`Reads a text file from the workspace. Binary files (images, PDFs, etc.) are rejected.
USE WHEN: you need to examine source code, configuration files, logs, or any text file.
EXAMPLE: read_file({ filePath: "src/index.ts", maxChars: 50000, offset: 0 })
NOTE: For large files, use offset to paginate. Binary files must be handled via bash_terminal.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      maxChars: z.number().int().min(100).max(500000).optional().default(50000).describe("Max chars (default 50000)"),
      offset: z.number().int().min(0).optional().default(0).describe("Character offset to start reading from (for truncated files)"),
    },
    implementation: async ({ filePath, maxChars, offset }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        if (!existsSync(resolved)) return fail(`File not found: ${resolved}`);
        const st = statSync(resolved);
        if (st.isDirectory()) return fail(`Is a directory: ${resolved}`);
        if (binaryExtCheck(resolved)) return fail(`Cannot read binary file: ${filePath}. Use bash_terminal for binary files.`);
        const content = readFileSync(resolved, "utf-8");
        const sliced = content.slice(offset, offset + maxChars);
        if (offset + maxChars < content.length) return ok({ content: sliced, truncated: true, originalLength: content.length, offset });
        return ok({ content: sliced });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "read_file");

  const writeFileTool = wrapTool(tool({
    name: "write_file",
    description: text`Writes text content to a file. Creates parent directories if needed. Overwrites existing files.
USE WHEN: you need to create or replace a file with new content.
EXAMPLE: write_file({ filePath: "src/hello.ts", content: "console.log('hello')" })
NOTE: Path is relative to workspace. Use append_file to add to an existing file.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      content: z.string().describe("Text content to write"),
    },
    implementation: async ({ filePath, content }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        const parent = dirname(resolved);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
        await writeFile(resolved, content, "utf-8");
        return ok({ path: resolved, workspace: ws, size: Buffer.byteLength(content, "utf-8"), action: "written" });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "write_file");

  const appendFileTool = wrapTool(tool({
    name: "append_file",
    description: text`Appends text to the end of a file. Creates the file if it doesn't exist.
USE WHEN: you need to add content to an existing file without overwriting it.
EXAMPLE: append_file({ filePath: "logs/output.txt", content: "new log entry" })
NOTE: Does NOT add a newline automatically. Include \\n in content if needed.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
      content: z.string().describe("Text content to append"),
    },
    implementation: async ({ filePath, content }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        const parent = dirname(resolved);
        if (!existsSync(parent)) await mkdir(parent, { recursive: true });
        await appendFile(resolved, content, "utf-8");
        const size = statSync(resolved).size;
        return ok({ path: resolved, workspace: ws, size, action: "appended" });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "append_file");

  const renameFileTool = wrapTool(tool({
    name: "rename_file",
    description: text`Renames or moves a file or directory. Both paths are relative to workspace.
USE WHEN: you need to reorganize files or rename something.
EXAMPLE: rename_file({ sourcePath: "old_name.ts", destPath: "new_name.ts" })
NOTE: Parent directories for the destination are created automatically.`,
    parameters: {
      sourcePath: z.string().min(1).describe("Current path relative to workspace"),
      destPath: z.string().min(1).describe("New path relative to workspace"),
    },
    implementation: async ({ sourcePath, destPath }) => {
      try {
        const ws = requireWorkspace(ctl);
        const src = sandboxPath(ws, sourcePath);
        const dst = sandboxPath(ws, destPath);
        if (!existsSync(src)) return fail(`Source not found: ${sourcePath}`);
        const dstParent = dirname(dst);
        if (!existsSync(dstParent)) await mkdir(dstParent, { recursive: true });
        const { rename } = await import("fs/promises");
        await rename(src, dst);
        return ok({ from: src, to: dst, workspace: ws });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "rename_file");

  const searchFilesTool = wrapTool(tool({
    name: "search_files",
    description: text`Searches file contents recursively for a case-insensitive text pattern. Skips binary files, hidden dirs, and node_modules.
USE WHEN: you need to find files containing specific text or code patterns.
EXAMPLE: search_files({ pattern: "TODO", include: "*.ts", maxResults: 20 })
NOTE: This is a text-based search, not a regex search. The pattern is matched case-insensitively.`,
    parameters: {
      pattern: z.string().min(1).max(200).describe("Text pattern to search for (case-insensitive)"),
      path: z.string().optional().default(".").describe("Starting directory relative to workspace"),
      include: z.string().optional().describe("File glob pattern (e.g. '*.ts', '*.{js,ts,md}')"),
      maxResults: z.number().int().min(1).max(200).optional().default(50).describe("Max matches (default 50)"),
    },
    implementation: async ({ pattern, path, include, maxResults }) => {
      try {
        const ws = requireWorkspace(ctl);
        const dir = sandboxPath(ws, path);
        const q = pattern.toLowerCase();
        const results: Array<{ file: string; line: number; content: string }> = [];
        function walkFn(current: string): void {
          if (results.length >= maxResults) return;
          try {
            const ents = readdirSync(current, { withFileTypes: true });
            for (const e of ents) {
              if (results.length >= maxResults) return;
              const full = resolve(current, e.name);
              if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walkFn(full); }
              else if (e.isFile()) {
                if (include) {
                  const re = new RegExp("^" + include.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
                  if (!re.test(e.name)) continue;
                }
                if (binaryExtCheck(full)) continue;
                try {
                  const lines = readFileSync(full, "utf-8").split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (results.length >= maxResults) break;
                    if (lines[i].toLowerCase().includes(q)) { results.push({ file: full, line: i + 1, content: lines[i].trim().slice(0, 200) }); }
                  }
                } catch {}
              }
            }
          } catch {}
        }
        walkFn(dir);
        return ok({ pattern, workspace: ws, path: dir, results, total: results.length });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "search_files");

  const deleteFileTool = wrapTool(tool({
    name: "delete_file",
    description: text`Deletes a file or empty directory. Path is relative to workspace.
USE WHEN: you need to remove a file or empty directory.
EXAMPLE: delete_file({ filePath: "temp/output.txt" })
NOTE: Will NOT delete non-empty directories. Use bash_terminal 'rm -rf' for that.`,
    parameters: {
      filePath: z.string().min(1).describe("File path relative to workspace"),
    },
    implementation: async ({ filePath }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, filePath);
        if (!existsSync(resolved)) return fail(`Not found: ${resolved}`);
        const st = statSync(resolved);
        if (st.isDirectory()) {
          const contents = readdirSync(resolved);
          if (contents.length > 0) return fail(`Directory is not empty (${contents.length} items). Use bash_terminal 'rm -rf' for non-empty directories.`);
          await rm(resolved, { recursive: true });
        } else { await unlink(resolved); }
        return ok({ path: resolved, workspace: ws, action: "deleted" });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "delete_file");

  const bashTerminalTool = wrapTool(tool({
    name: "bash_terminal",
    description: text`Runs a bash command in the workspace directory. Each call creates a fresh process.
USE WHEN: you need to run shell commands, scripts, or access binary files. Before telling the user a capability (node, npm, docker, cron, tmux, etc.) is missing, check it yourself here, e.g. bash_terminal({ command: "which node npm" }) — do not assume a bare environment.
EXAMPLE: bash_terminal({ command: "ls -la", timeout: 10000 })
NOTE: The working directory is the workspace root. Timeout defaults to 30s, max 120s. Output is capped at 10MB.`,
    parameters: {
      command: z.string().min(1).max(5000).describe("Bash command to execute"),
      timeout: z.number().int().min(1000).max(120000).optional().default(30000).describe("Timeout ms (default 30000, max 120000)"),
    },
    implementation: async ({ command, timeout }) => {
      const blockedReason = checkBashCommandSafety(command);
      if (blockedReason) return fail(blockedReason);
      try {
        const { execFile } = await import("child_process");
        // LM Studio.app is launched via Launch Services (Dock/Finder), not an interactive login
        // shell, so process.env.PATH never picks up nvm/Homebrew/asdf/volta — anything a version
        // manager adds by sourcing .zshrc/.zprofile. A bare exec() with process.env therefore reports
        // real, installed tools as "not found". Running through `${shell} -ilc` (interactive + login +
        // command-string) sources the same profile a real Terminal session would, generically, without
        // hardcoding any single tool's install path. `command` stays a single argv element passed to
        // -c, so the shell parses it exactly as before — pipes/redirects/&& all keep working unchanged.
        const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
        return await new Promise((res) => {
          execFile(shell, ["-ilc", command], { cwd: requireWorkspace(ctl), env: { ...process.env }, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            res(ok({ exitCode: err?.code ?? 0, stdout: stdout || "", stderr: stderr || "", killed: !!err?.killed, signal: err?.signal ?? null }));
          });
        });
      } catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "bash_terminal");

  const webSearchTool = wrapTool(tool({
    name: "web_search",
    description: text`Searches the web and returns results with titles, snippets, and URLs.
USE WHEN: you need to find information on the internet, look up documentation, or research a topic.
EXAMPLE: web_search({ query: "typescript decorators example", maxResults: 5 })
NOTE: Call this first, then use web_fetch on the most relevant URLs to get full content.`,
    parameters: {
      query: z.string().min(1).max(500).describe("Search query"),
      maxResults: z.number().int().min(1).max(10).optional().default(5).describe("Max results (default 5)"),
    },
    implementation: async ({ query, maxResults }) => {
      try { return ok(await webSearch(query, maxResults)); }
      catch (e: any) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "web_search");

  const saveMemoryTool = wrapTool(tool({
    name: "save_memory",
    description: text`Stores information in a persistent JSONL knowledge base that survives restarts.
USE WHEN: you learn something important about the user's project that should be remembered across sessions.
EXAMPLE: save_memory({ content: "Project uses React 18 with TypeScript", tags: ["project:myapp", "tech:react"] })
NOTE: Every saved memory is automatically tagged with the current workspace and session. You can also choose a semantic scope.`,
    parameters: {
      content: z.string().min(1).max(50000).describe("Information to store"),
      tags: z.array(z.string().max(50)).min(1).max(20).describe("Tags like ['project:myapp', 'language:python']"),
      scope: z.enum(["session", "workspace", "research"]).optional().default("workspace").describe("Semantic memory scope"),
    },
    implementation: async ({ content, tags, scope }) => {
      const workspace = requireWorkspace(ctl);
      getSessionLog().saveMemory(
        buildMemoryTags(tags, currentSessionId(sessionState), workspace, scope),
        stripModelArtifacts(content),
        undefined,
        currentSessionId(sessionState),
        workspace,
        scope,
      );
      return ok({ saved: true });
    },
  }), "save_memory");

  const compactContextTool = wrapTool(tool({
    name: "compact_context",
    description: text`Compacts the recent session into a reusable summary while preserving code verbatim.
USE WHEN: the session is getting long, repetitive, or you want a compact reusable state.
RULES: prose may be summarized; code must be preserved verbatim or referenced by path; code must never be paraphrased.
EXAMPLE: compact_context({ saveToMemory: true })
NOTE: This stores a compact snapshot in memory so later turns can reload it without replaying full history.`,
    parameters: {
      maxTokens: z.number().int().min(200).max(20000).optional().default(COMPACT_CONTEXT_DEFAULT_MAX_TOKENS).describe("Maximum token budget for the compact state"),
      includeCode: z.boolean().optional().default(true).describe("Whether to preserve verbatim code snippets when possible"),
      saveToMemory: z.boolean().optional().default(true).describe("Store the compacted state in persistent memory"),
      force: z.boolean().optional().default(false).describe("Return a compacted state even if the session signal is weak"),
      goalHint: z.string().min(1).max(2000).optional().describe("Optional goal hint when the session log does not have one"),
    },
    implementation: async ({ maxTokens, includeCode, saveToMemory, force, goalHint }) => {
      const session = getSessionLog();
      const workspace = requireWorkspace(ctl);
      return await compactSessionContext(session, sessionState, {
        maxTokens,
        includeCode,
        saveToMemory,
        force,
        goalHint,
        workspace,
      });
    },
  }), "compact_context");

  const searchMemoryTool = wrapTool(tool({
    name: "search_memory",
    description: text`Searches stored memories by tags and/or keyword. Results are newest-first.
USE WHEN: you need to recall information saved in previous sessions.
EXAMPLE: search_memory({ tags: ["project:myapp"], maxResults: 10 })
EXAMPLE: search_memory({ query: "deployment", maxResults: 5 })
NOTE: Provide either tags or query, not both. Scope defaults to workspace; set it to session or research when needed.`,
    parameters: {
      tags: z.array(z.string().max(50)).optional().describe("Filter by tags"),
      query: z.string().max(200).optional().describe("Keyword search"),
      maxResults: z.number().int().min(1).max(50).optional().default(10),
      scope: z.enum(["session", "workspace", "research", "all"]).optional().default("workspace").describe("Limit results to the selected memory scope"),
    },
    implementation: async ({ tags, query, maxResults, scope }) => {
      const session = getSessionLog();
      const workspace = requireWorkspace(ctl);
      const filter = memoryFilterForScope(scope ?? "workspace", workspace, currentSessionId(sessionState));
      let results: SearchMemoryResult[] = [];
      if (tags && tags.length > 0) {
        results = session.searchMemoriesByTags(tags, maxResults, filter);
      } else if (query) {
        results = session.searchMemoriesByContent(query, maxResults, filter);
      }
      return ok({
        results: results.map((e) => ({
          content: e.content.slice(0, 500),
          tags: e.tags,
          scope: e.scope ?? null,
          workspace: e.workspace ?? null,
          sessionId: e.sessionId ?? null,
          matchScore: e.matchScore,
          matchedTags: e.matchedTags,
          matchedContent: e.matchedContent,
          matchMode: e.matchMode,
          query: query ?? null,
        })),
        totalMatches: results.length,
        scope: scope ?? "workspace",
      });
    },
  }), "search_memory");

  const listMemoriesTool = wrapTool(tool({
    name: "list_memories",
    description: text`Shows total count of memory entries stored in the knowledge base.
USE WHEN: you want a quick count of how many memories exist, optionally scoped.
EXAMPLE: list_memories()
NOTE: Use search_memory to find specific entries. This can be limited by workspace/session/research scope.`,
    parameters: {
      scope: z.enum(["session", "workspace", "research", "all"]).optional().default("workspace").describe("Limit the count to a scope"),
    },
    implementation: async ({ scope }) => {
      const session = getSessionLog();
      const workspace = requireWorkspace(ctl);
      const filter = memoryFilterForScope(scope ?? "workspace", workspace, currentSessionId(sessionState));
      const total = session.countMemories(filter);
      return ok({
        totalEntries: total,
        message: "Use search_memory to find specific entries.",
        scope: scope ?? "workspace",
        scopeSummary: {
          workspace,
          sessionId: currentSessionId(sessionState),
        },
      });
    },
  }), "list_memories");

  const clearMemoriesTool = wrapTool(tool({
    name: "clear_memories",
    description: text`Deletes ALL memory entries. This is irreversible.
USE WHEN: you need to reset the memory knowledge base completely.
EXAMPLE: clear_memories()
NOTE: This deletes everything. There is no undo. Use save_memory to re-add important entries after.`,
    parameters: {
      tags: z.array(z.string().max(50)).optional().describe("If provided, only delete entries matching ANY of these tags"),
    },
    implementation: async ({ tags }) => {
      if (tags && tags.length > 0) {
        return fail("Tag-specific clear not supported with append-only JSONL. Omit tags to clear all.");
      }
      getSessionLog().clear();
      return ok({ deletedCount: -1, message: "Session log cleared." });
    },
  }), "clear_memories");

  const generateUuidTool = wrapTool(tool({
    name: "generate_uuid",
    description: text`Generates a random UUID v4 string.
USE WHEN: you need a unique identifier for something.
EXAMPLE: generate_uuid()
NOTE: No parameters needed. Uses crypto.randomUUID().`,
    parameters: {},
    implementation: async () => { const { randomUUID } = await import("crypto"); return ok({ uuid: randomUUID() }); },
  }), "generate_uuid");

  const generatePasswordTool = wrapTool(tool({
    name: "generate_password",
    description: text`Generates a cryptographically random password with configurable length and special character options.
USE WHEN: the user needs a secure random password.
EXAMPLE: generate_password({ length: 32, includeSpecialChars: true })
NOTE: Length range is 8-128. Default is 24 chars with special chars.`,
    parameters: {
      length: z.number().int().min(8).max(128).optional().default(24).describe("Password length (default 24)"),
      includeSpecialChars: z.boolean().optional().default(true).describe("Include special characters (default true)"),
    },
    implementation: async ({ length, includeSpecialChars }) => {
      const { randomInt } = await import("crypto");
      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const digits = "0123456789";
      const special = "!@#$%^&*()_+-=[]{}|;:,.<>?";
      const chars = upper + lower + digits + (includeSpecialChars ? special : "");
      let password = "";
      for (let i = 0; i < length; i++) password += chars[randomInt(0, chars.length)];
      return ok({ password, length, strength: length >= 32 ? "strong" : length >= 16 ? "good" : "adequate" });
    },
  }), "generate_password");

  const encodeBase64Tool = wrapTool(tool({
    name: "encode_base64",
    description: text`Encodes text to Base64 format.
USE WHEN: you need to encode data for transmission or storage in Base64.
EXAMPLE: encode_base64({ text: "hello world" })
NOTE: Returns both the encoded and original text.`,
    parameters: { text: z.string().min(1).describe("Text to encode") },
    implementation: async ({ text }) => ok({ encoded: Buffer.from(text).toString("base64"), original: text }),
  }), "encode_base64");

  const decodeBase64Tool = wrapTool(tool({
    name: "decode_base64",
    description: text`Decodes Base64 format back to text.
USE WHEN: you need to decode Base64 encoded data.
EXAMPLE: decode_base64({ base64: "aGVsbG8gd29ybGQ=" })
NOTE: Returns the decoded text. Throws if the input is not valid Base64.`,
    parameters: { base64: z.string().min(1).describe("Base64 string to decode") },
    implementation: async ({ base64 }) => {
      try { return ok({ decoded: Buffer.from(base64, "base64").toString("utf-8") }); }
      catch (e) { return fail(String(e instanceof Error ? e.message : e)); }
    },
  }), "decode_base64");

  const sshExecTool = wrapTool(tool({
    name: "ssh_exec",
    description: text`Executes a command on a remote machine via SSH with password authentication.
USE WHEN: you need to run commands on a remote server.
EXAMPLE: ssh_exec({ host: "192.168.1.100", user: "root", password: "...", command: "ls -la", port: 22, timeout: 30000 })
NOTE: Requires sshpass to be installed on the host machine. Password is sent via command line.`,
    parameters: {
      host: z.string().min(1).describe("Remote host"),
      user: z.string().min(1).describe("SSH username"),
      password: z.string().min(1).describe("SSH password"),
      command: z.string().min(1).max(5000).describe("Command to execute"),
      port: z.number().int().min(1).max(65535).optional().default(22).describe("SSH port (default 22)"),
      timeout: z.number().int().min(5000).max(120000).optional().default(30000).describe("Timeout ms (default 30000)"),
    },
    implementation: async ({ host, user, password, command, port, timeout }) => {
      try {
        const { execFileSync } = await import("child_process");
        // execFileSync (no local shell) instead of execSync on a concatenated string: host/user
        // were previously interpolated unescaped into a shell command, which was a local command
        // injection vector (e.g. host: "x; rm -rf ~"). Passing args as an array sidesteps that
        // entirely — none of these values are ever interpreted by a local shell.
        const result = execFileSync("sshpass", [
          "-p", password,
          "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
          "-p", String(port),
          `${user}@${host}`,
          command,
        ], { encoding: "utf-8", timeout, maxBuffer: 10 * 1024 * 1024 });
        return ok({ exitCode: 0, stdout: result.trim(), stderr: "" });
      } catch (e: unknown) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return ok({ exitCode: err.status ?? 1, stdout: (err.stdout || "").toString().trim(), stderr: (err.stderr || "").toString().trim(), error: String(e), killed: !!(err as any).killed });
      }
    },
  }), "ssh_exec");

  const checkServiceTool = wrapTool(tool({
    name: "check_service",
    description: text`Checks if a network service is reachable via TCP port check.
USE WHEN: you need to verify a service is running on a host/port.
EXAMPLE: check_service({ host: "localhost", port: 3000, timeout: 5000 })
EXAMPLE: check_service({ host: "example.com", port: 80, httpPath: "/status", timeout: 5000 })
NOTE: If httpPath is provided, also performs an HTTP GET and returns status code and body.`,
    parameters: {
      host: z.string().default("localhost").describe("Host or IP to check"),
      port: z.number().int().min(1).max(65535).describe("TCP port"),
      httpPath: z.string().optional().describe("HTTP path for status check"),
      timeout: z.number().int().min(1000).max(30000).optional().default(5000).describe("Timeout ms (default 5000)"),
    },
    implementation: async ({ host, port, httpPath, timeout }) => {
      const start = Date.now();
      const reachable = await new Promise<boolean>((res) => {
        const { Socket } = require("net");
        const s = new Socket();
        s.setTimeout(timeout);
        s.on("connect", () => { s.destroy(); res(true); });
        s.on("error", () => { s.destroy(); res(false); });
        s.on("timeout", () => { s.destroy(); res(false); });
        s.connect(port, host);
      });
      const latencyMs = Date.now() - start;
      let httpStatus: number | null = null;
      let httpBody: string | null = null;
      if (reachable && httpPath) {
        try {
          const resp = await fetch(`http://${host}:${port}${httpPath}`, { signal: AbortSignal.timeout(timeout) });
          httpStatus = resp.status;
          httpBody = (await resp.text()).slice(0, 2000);
        } catch {}
      }
      return ok({ host, port, reachable, latencyMs, httpStatus, httpBody });
    },
  }), "check_service");

  const deleteMemoryTool = wrapTool(tool({
    name: "delete_memory",
    description: text`Delete is not supported with append-only JSONL storage. Use clear_memories to reset, or save_memory with fresh content to overwrite.
USE WHEN: the user asks to delete a specific memory YOU CANNOT. Tell them to use clear_memories instead.`,
    parameters: { id: z.string().min(1).describe("Memory entry ID") },
    implementation: async () => {
      return fail("Delete not supported with append-only JSONL. Use clear_memories to reset, or save_memory with fresh content.");
    },
  }), "delete_memory");

  const updateMemoryTool = wrapTool(tool({
    name: "update_memory",
    description: text`Update is not supported with append-only JSONL storage. Use save_memory with new content and tags instead.
USE WHEN: the user asks to update a memory YOU CANNOT. Tell them to use save_memory instead.`,
    parameters: {
      id: z.string().min(1).describe("Memory entry ID to update"),
      content: z.string().max(50000).optional().describe("New content"),
      tags: z.array(z.string().max(50)).min(1).max(20).optional().describe("New tags"),
    },
    implementation: async () => {
      return fail("Update not supported with append-only JSONL. Use save_memory with new content and tags.");
    },
  }), "update_memory");

  function _scheduleNextBridgeIteration() {
    if (!_bridgeActive) return;
    _bridgeTimer = setTimeout(async () => {
      if (!_bridgeActive) return;
      _bridgeIteration++;
      if (_bridgeMaxIterations > 0 && _bridgeIteration > _bridgeMaxIterations) {
        _bridgeActive = false;
        _bridgeTimer = null;
        return;
      }
      if (_bridgeMaxDuration > 0 && (Date.now() - _bridgeStartedAt) / 1000 >= _bridgeMaxDuration) {
        _bridgeActive = false;
        _bridgeTimer = null;
        return;
      }

      // Guard: skip if prediction already running
      if (_bridgePredictionRunning) {
        if (_bridgeActive) _scheduleNextBridgeIteration();
        return;
      }

      _bridgePredictionRunning = true;
      try {
        if (!_bridgeClient) {
          console.log("[vibe_bridge] No LMStudio client, skipping tick");
          return;
        }

        const loadedModels = await _bridgeClient.llm.listLoaded();
        if (loadedModels.length === 0) {
          console.log("[vibe_bridge] No model loaded, skipping tick");
          return;
        }

        const model = loadedModels[0];

        // Step 1: Summarize handover context
        let handover = "";
        if (_bridgeHandover.length > 0) {
          const buffer = _bridgeHandover.join("\n\n");
          const summarizePrompt = `Summarize this conversation in 2-3 concise sentences, focusing on what the user was working on and any open questions:\n\n${buffer}`;
          const result = await model.complete(summarizePrompt, { maxTokens: 200 });
          handover = stripModelArtifacts(result.content.trim());
        }

        // Step 2: Build chat with handover + bridge prompt
        const chatMessages: Array<{ role: "system" | "user"; content: string }> = [];
        if (handover) {
          chatMessages.push({
            role: "system",
            content: `Context from the current session:\n${handover}`,
          });
        }
        // Each tick otherwise builds a brand-new, isolated Chat with no memory of what earlier ticks
        // actually did — buildContextSpine (goal + full plan + established facts) already exists for
        // exactly this purpose but was previously only wired into the interactive preprocessMessage
        // path, never here. Without it, ticks "forget" everything but the current step's one-line
        // description between rounds. Individual tool calls below already feed facts back into the
        // session log via wrapTool, so this spine picks up what prior ticks learned too.
        const spine = buildContextSpine(getSessionLog(), activeSessionState, headBudgetChars(await getContextWindow(ctl as any)));
        if (spine) {
          chatMessages.push({ role: "system", content: spine });
        }
        // If a plan is active, point the tick at the next unfinished step so unattended ticks make
        // real progress instead of drifting — this is what makes create_plan's autoStart useful.
        const plan = activeSessionState.plan;
        const nextStep = plan?.steps.find((s) => s.status === "pending" || s.status === "in_progress");
        const planDirective = plan && nextStep
          ? `${MANAGED_CONTEXT_MARKER}\n[Plan "${plan.goal}" — step ${nextStep.index + 1}/${plan.steps.length}: ${nextStep.description}${nextStep.note ? `\nNote from last attempt: ${nextStep.note}` : ""}\nExecute it now with your available tools. Call update_plan_step({ index: ${nextStep.index}, status: "done" }) when finished, or "blocked" with a note if you can't proceed.]`
          : plan && plan.steps.length === 0
            ? `${MANAGED_CONTEXT_MARKER}\n[Goal "${plan.goal}" has no steps yet. Call create_plan({ goal: "${plan.goal}", steps: [...] }) now to break it into concrete steps, then execute the first one.]`
            : "";
        // Apply the configured reasoning-effort directive to the tick prompt. Besides honoring the
        // user's setting, suppressing reasoning here curbs the unbounded "Wait... Actually..." loops
        // that the round/timeout caps above were added to bound.
        const tickDirective = await reasoningDirectiveForSession(ctl);
        chatMessages.push({
          role: "user",
          content: [planDirective, tickDirective ? `${_bridgePrompt}\n\n${tickDirective}` : _bridgePrompt].filter(Boolean).join("\n\n"),
        });

        const chat = Chat.from(chatMessages);
        // bash_terminal is intentionally excluded from unattended ticks until it has a command
        // allowlist — see NOTES.md. vibe_bridge/amend are excluded to avoid nested bridge starts
        // and orchestrator-specific finalize semantics that don't apply to this standalone act() call.
        // create_plan IS included (unlike before): a tick that finds an empty plan.steps had no way
        // to fix that itself, since plans were previously only ever created from the interactive
        // channel — leaving an unattended session permanently stuck with no steps to work from.
        const bridgeTickTools = [
          exploreWorkspaceTool, listFilesTool, readFileTool, writeFileTool, appendFileTool,
          searchFilesTool, saveMemoryTool, searchMemoryTool, webFetchTool, webSearchTool,
          createPlanTool, updatePlanStepTool, getPlanTool,
        ];
        const bridgeTickMaxTokens = resolveBridgeTickMaxTokens(await getLoadedModelArch());
        await model.act(chat, bridgeTickTools, {
          maxPredictionRounds: resolveMaxThinkingSteps(ctl),
          signal: AbortSignal.timeout(VIBE_BRIDGE_TICK_TIMEOUT_MS),
          ...(bridgeTickMaxTokens !== undefined ? { maxTokens: bridgeTickMaxTokens } : {}),
        });

        _bridgeConsecutiveFailures = 0;
        console.log(`[vibe_bridge] Tick ${_bridgeIteration} completed at ${new Date().toLocaleTimeString()}`);
      } catch (err) {
        _bridgeConsecutiveFailures++;
        console.error(`[vibe_bridge] Tick ${_bridgeIteration} failed (${_bridgeConsecutiveFailures}/${BRIDGE_MAX_CONSECUTIVE_FAILURES} consecutive failures):`, err);
        if (_bridgeConsecutiveFailures >= BRIDGE_MAX_CONSECUTIVE_FAILURES) {
          console.error(`[vibe_bridge] Stopping after ${_bridgeConsecutiveFailures} consecutive failures. Last error:`, err);
          _bridgeActive = false;
          _bridgeTimer = null;
        }
      } finally {
        _bridgePredictionRunning = false;
        if (_bridgeActive) _scheduleNextBridgeIteration();
      }
    }, _bridgeInterval * 1000);
  }

  const vibeBridgeTool = wrapTool(tool({
    name: "vibe_bridge",
    description: text`Self-recalling autonomous loop. Starts a timer that periodically injects a prompt into the chat to keep the session alive without user input.
USE WHEN: you need to work autonomously on a multi-step task without user interaction.
EXAMPLES:
  vibe_bridge({ action: "start", prompt: "Continue implementing the feature", interval: 30 })
  vibe_bridge({ action: "stop" })
  vibe_bridge({ action: "status" })
NOTE: Only one bridge can be active at a time. Starting a new bridge replaces the previous one.
The default prompt can be configured in tool settings.`,
    parameters: {
      action: z.enum(["start", "stop", "status"]).default("status").describe("Control the keep-alive loop"),
      prompt: z.string().min(1).max(10000).optional().describe("Prompt to inject on each cycle (uses configured default if omitted)"),
      interval: z.number().int().min(5).max(3600).optional().describe("Seconds between injections, e.g. 600 for every 10 minutes (5-3600)"),
      maxDuration: z.number().int().min(0).max(86400).optional().describe("Max total runtime in seconds, e.g. 21600 for 6 hours (0=unlimited)"),
      maxIterations: z.number().int().min(0).max(1000).optional().describe("Max cycles before auto-stop (0=unlimited)"),
    },
    implementation: async ({ action, prompt, interval, maxDuration, maxIterations }, ctx) => {
      if (action === "status") {
        const elapsed = _bridgeStartedAt ? Math.floor((Date.now() - _bridgeStartedAt) / 1000) : 0;
        const remaining = _bridgeMaxDuration > 0 ? Math.max(0, _bridgeMaxDuration - elapsed) : null;
        return ok({
          active: _bridgeActive,
          prompt: _bridgePrompt.slice(0, 100),
          interval: _bridgeInterval,
          iteration: _bridgeIteration,
          maxIterations: _bridgeMaxIterations,
          maxDuration: _bridgeMaxDuration,
          elapsed,
          remaining,
          nextIn: _bridgeActive && _bridgeTimer ? `${_bridgeInterval}s` : "n/a",
          consecutiveFailures: _bridgeConsecutiveFailures,
          stoppedAfterFailures: !_bridgeActive && _bridgeConsecutiveFailures >= BRIDGE_MAX_CONSECUTIVE_FAILURES,
        });
      }
      if (action === "stop") {
        if (_bridgeTimer) clearTimeout(_bridgeTimer);
        _bridgeActive = false;
        _bridgeTimer = null;
        ctx?.status?.("Bridge stopped");
        return ok({ stopped: true, iteration: _bridgeIteration });
      }
      const started = startBridge({ prompt, interval, maxDuration, maxIterations });
      ctx?.status?.(`Bridge started: ${started.interval}s interval, max ${started.maxDuration ? `${started.maxDuration}s` : "∞"}`);
      return ok({
        active: true,
        prompt: started.prompt.slice(0, 100),
        interval: started.interval,
        maxDuration: started.maxDuration,
        maxIterations: started.maxIterations || "unlimited",
      });
    },
  }), "vibe_bridge");

  // Shared by the vibe_bridge tool's "start" action and the auto-start-on-toggle path below —
  // both need identical resolve-defaults-then-arm-the-timer behavior.
  function startBridge(opts: { prompt?: string; interval?: number; maxDuration?: number; maxIterations?: number }) {
    const resolvedPrompt = opts.prompt || String(readPluginConfigValue(ctl, ["tools.vibe_bridge_prompt", "vibe_bridge_prompt"])
      || DEFAULT_VIBE_BRIDGE_PROMPT);
    const resolvedInterval = opts.interval ?? Number(readPluginConfigValue(ctl, ["tools.vibe_bridge_interval", "vibe_bridge_interval"])
      ?? DEFAULT_VIBE_BRIDGE_INTERVAL);
    const resolvedMaxDuration = opts.maxDuration ?? Number(readPluginConfigValue(ctl, ["tools.vibe_bridge_maxDuration", "vibe_bridge_maxDuration"])
      ?? DEFAULT_VIBE_BRIDGE_MAX_DURATION);
    if (_bridgeTimer) clearTimeout(_bridgeTimer);
    _bridgeActive = true;
    _bridgePrompt = resolvedPrompt;
    _bridgeInterval = resolvedInterval;
    _bridgeIteration = 0;
    _bridgeConsecutiveFailures = 0;
    _bridgeMaxIterations = opts.maxIterations ?? 0;
    _bridgeMaxDuration = resolvedMaxDuration;
    _bridgeStartedAt = Date.now();
    _scheduleNextBridgeIteration();
    return {
      prompt: _bridgePrompt,
      interval: _bridgeInterval,
      maxDuration: _bridgeMaxDuration,
      maxIterations: _bridgeMaxIterations,
    };
  }

  const ALL_TOOL_MAP: Record<string, any> = {
    set_workspace: setWorkspaceTool,
    explore_workspace: exploreWorkspaceTool,
    get_config: getConfigTool,
    save_memory: saveMemoryTool,
    compact_context: compactContextTool,
    search_memory: searchMemoryTool,
    list_memories: listMemoriesTool,
    update_memory: updateMemoryTool,
    delete_memory: deleteMemoryTool,
    clear_memories: clearMemoriesTool,
    ssh_exec: sshExecTool,
    check_service: checkServiceTool,
    web_fetch: webFetchTool,
    calculate: calculateTool,
    get_current_datetime: currentDateTimeTool,
    list_files: listFilesTool,
    read_file: readFileTool,
    write_file: writeFileTool,
    append_file: appendFileTool,
    rename_file: renameFileTool,
    search_files: searchFilesTool,
    delete_file: deleteFileTool,
    bash_terminal: bashTerminalTool,
    web_search: webSearchTool,
    generate_uuid: generateUuidTool,
    generate_password: generatePasswordTool,
    encode_base64: encodeBase64Tool,
    decode_base64: decodeBase64Tool,
    amend: amendTool,
    create_plan: createPlanTool,
    update_plan_step: updatePlanStepTool,
    get_plan: getPlanTool,
    vibe_bridge: vibeBridgeTool,
  };

  // `amend` exists so families with no native "I'm done" signal can hand a final answer back
  // explicitly. Harmony models already have one — the `final` channel — and exposing both makes them
  // emit a hybrid of the two as literal text. Reproduced live on gpt-oss-20b: every reply opened with
  // `<|channel|>final <|constrain|>amend<|message|>` in the visible chat bubble. Confirmed as vibeLM's
  // doing by running the identical prompt with the plugin disabled, which rendered cleanly.
  //
  // Dropping amend for Harmony costs nothing: the model ends its turn by closing the final channel,
  // which is what amend was emulating. Every other family keeps it (see MANDATORY_ENABLED below).
  const arch = await getLoadedModelArch();
  const amendConflictsWithNativeFinalChannel = usesHarmonyFinalChannel(arch);

  const MANDATORY_ENABLED = amendConflictsWithNativeFinalChannel ? [] : ["amend"];

  const enabledNames = dedupeTags([
    ...resolveEnabledToolNames(ctl),
    ...MANDATORY_ENABLED,
  ]).filter((name: string) => !(amendConflictsWithNativeFinalChannel && name === "amend"));
  const allTools = enabledNames
    .filter((name: string) => ALL_TOOL_MAP[name])
    .map((name: string) => ALL_TOOL_MAP[name]);

  const amendIdx = allTools.indexOf(amendTool);
  if (amendIdx >= 0) {
    const lastIdx = allTools.length - 1;
    if (amendIdx !== lastIdx) {
      allTools.splice(amendIdx, 1);
      allTools.push(amendTool);
    }
  }

  // The "Vibe Bridge" toggle in plugin settings is meant to directly control the keep-alive loop,
  // not just expose a tool the model has to remember to call. If it's on and nothing is running
  // yet, arm it here using configured defaults (same resolve path as the tool's "start" action) —
  // it still inherits the round/timeout caps on each tick, so this can't repeat the unbounded-hang
  // failure mode even though it now starts unattended.
  if (enabledNames.includes("vibe_bridge") && !_bridgeActive && _bridgeClient) {
    console.log("[vibe_bridge] Auto-starting: enabled in plugin settings.");
    startBridge({});
  }

  return allTools;
}

async function preprocessMessageCore(text: string, ctl?: PromptPreprocessorController): Promise<string | null> {
  const t = text.trim();
  await bootstrapSessionState(ctl as any);
  const contextWindow = await getContextWindow(ctl as any);
  // Harmony families don't get the `amend` tool, so directives below must not tell them to call it.
  const harmony = usesHarmonyFinalChannel(await getLoadedModelArch());
  const configuredRollingWindowTriggerTokens = resolveConfiguredRollingWindowTriggerTokens(ctl as any);
  const rollingWindowTriggerTokens = resolveRollingWindowTriggerTokens(contextWindow, configuredRollingWindowTriggerTokens);
  const historyText = await getHistoryText(ctl);
  syncRuntimeState(historyText, activeSessionState);
  const normalizedHistoryText = normalizeManagedContextHistory(historyText);
  const hasBlocksInHistory = hasManagedContext(historyText);
  const hasStoredBlocks = activeSessionState.resumedFromPersistedState && activeSessionState.managedContextBlocks.length > 0;
  const managedContextPresent = hasBlocksInHistory || hasStoredBlocks;

  // Capture user message for handover context (rolling window of last 5)
  if (t.length > 0) {
    _bridgeHandover.push(t);
    if (_bridgeHandover.length > 5) {
      _bridgeHandover = _bridgeHandover.slice(-5);
    }
  }

  // Populate the persisted plan's goal from the first substantive request so the pinned head always
  // has a goal to anchor to, even when the model never calls create_plan. A real create_plan later
  // overwrites this with concrete steps; here we only seed goal + empty steps (so amend's pending-step
  // guard stays satisfied). Skipped for commands/continuations, which aren't goals.
  if (!activeSessionState.plan && isGoalLikeMessage(t)) {
    const now = new Date().toISOString();
    activeSessionState.plan = { goal: truncateText(t, 300), steps: [], createdAt: now, updatedAt: now };
    writeRuntimeStateSync(activeSessionState);
  }

  const wsMatch = t.match(/^(?:set|pick|change|switch|go\s+to)\s+workspace(?:\s+(.+))?$/i) || t.match(/^workspace(?:\s+(.+))?$/i);
  if (wsMatch) {
    const requestedPath = wsMatch[1]?.trim().replace(/^["'`]|["'`]$/g, "") || "";
    if (!requestedPath) {
      return recordProcessedPrompt(historyText, `[Tool error: set_workspace → explicit path required. Call set_workspace({ path: "/absolute/path" }) with an existing folder.]`);
    }

    const resolved = resolve(requestedPath);
    if (existsSync(resolved)) {
      const cfg = readConfigSync();
      cfg.workspacePath = resolved;
      writeConfigSync(cfg);
      // Must be unambiguous: the preprocessor already performed the change and stripped the path from
      // the message, so a terse "[Tool executed: set_workspace]" left small models re-calling the tool
      // (now without a path) and asking the user for it again. State the outcome and forbid the retry.
      return recordProcessedPrompt(historyText, `[The workspace is already set to ${resolved}. This is done — do NOT call the set_workspace tool. Reply to the user with a one-line confirmation, e.g. "Workspace set to ${resolved}.", then wait for their next instruction.]`);
    }
    return recordProcessedPrompt(historyText, `[The workspace was NOT changed: the path "${resolved}" does not exist. Do NOT call set_workspace. Tell the user the path was not found and ask them for a valid absolute path to an existing folder.]`);
  }

  const exploreMatch = t.match(/^(?:explore|inspect|scan|survey)\s+workspace(?:\s+(.+))?$/i) || t.match(/^workspace(?:\s+explore|inspect|scan|survey)(?:\s+(.+))?$/i);
  if (exploreMatch) {
    return recordProcessedPrompt(historyText, `[Tool executed: explore_workspace]`);
  }

  // Inject step-completion reminder for multi-step requests
  const steps = t.match(/^\d+\.\s/gm);
  if (steps && steps.length > 0) {
    if (managedContextPresent) {
      const plainReport = buildPromptBudgetReport(normalizedHistoryText, t, contextWindow, rollingWindowTriggerTokens);
      if (plainReport.overflow) {
        return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, plainReport.estimatedTokens, "multi-step", harmony, t));
      }
      // Continuation: replace stale "follow all steps" instruction with a continue directive
      if (CONTINUATION_PATTERN.test(t)) {
        return recordProcessedPrompt(historyText, compactContinueInstruction(t));
      }
      return null;
    }
    const report = buildPromptBudgetReport(normalizedHistoryText, t, contextWindow, rollingWindowTriggerTokens);
    if (report.overflow) {
      return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, report.estimatedTokens, "multi-step", harmony, t));
    }
    return recordProcessedPrompt(historyText, compactTaskReminder(steps.length, t, harmony));
  }

  const explicitCalcMatch = t.match(/^(?:calculate|evaluate|solve|compute)\s+(.+)/i);
  const conversationalCalcMatch = t.match(/^what\s+is\s+(.+)/i);
  const rawCalcExpression = explicitCalcMatch?.[1] || conversationalCalcMatch?.[1] || "";
  const calcExpression = rawCalcExpression.replace(/\?\s*$/, "").trim();
  // "What is" is overwhelmingly conversational, so only intercept it when the remainder is visibly
  // arithmetic. Explicit calculator verbs retain mathjs's broader expression language.
  const expressionShaped = !!explicitCalcMatch || /^[\d\s+\-*/%^().,!]+$/.test(calcExpression);
  if (calcExpression && expressionShaped) {
    try {
      const calcResp = await import("mathjs").then(m => m.evaluate(calcExpression));
      if (typeof calcResp === "number" || typeof calcResp === "string") {
        const processed = `[Tool executed: calculate → ${calcResp}]`;
        const report = buildPromptBudgetReport(normalizedHistoryText, processed, contextWindow, rollingWindowTriggerTokens);
        if (report.overflow) {
          return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, report.estimatedTokens, "general", harmony, t));
        }
        return recordProcessedPrompt(historyText, processed);
      }
    } catch {}
  }

  // Bare "search" and "find" are usually local/contextual requests (workspace, sessions, files).
  // Only perform network I/O when the user explicitly names a web search surface.
  const searchMatch = t.match(/^(?:google|bing)\s+(?:for\s+)?(.+)/i)
    || t.match(/^(?:search|find|look\s+up|lookup)\s+(?:(?:the\s+)?(?:web|internet)|online)\s+(?:for\s+)?(.+)/i);
  if (searchMatch) {
    try {
      const results = await webSearch(searchMatch[1], 5);
      if (results.length > 0) {
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`);
        const processed = `[Tool executed: web_search →\n${lines.join("\n")}]\n\n${t}`;
        const report = buildPromptBudgetReport(normalizedHistoryText, processed, contextWindow, rollingWindowTriggerTokens);
        if (report.overflow) {
          return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, report.estimatedTokens, "general", harmony, t));
        }
        return recordProcessedPrompt(historyText, processed);
      }
      return recordProcessedPrompt(historyText, `[Tool executed: web_search → no results found]`);
    } catch (e: any) {
      return recordProcessedPrompt(historyText, `[Tool error: web_search → ${e.message}]`);
    }
  }

  const plainReport = buildPromptBudgetReport(normalizedHistoryText, t, contextWindow, rollingWindowTriggerTokens);
  if (plainReport.overflow) {
    return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, plainReport.estimatedTokens, "general", harmony, t));
  }
  // Continuation in managed-context session: prevent LLM from re-executing stale instructions.
  // (Rehydration of persisted managedContextBlocks after a context roll happens unconditionally,
  // one layer up in the preprocessMessage wrapper below — it no longer depends on CONTINUATION_PATTERN.)
  if (managedContextPresent && CONTINUATION_PATTERN.test(t)) {
    return recordProcessedPrompt(historyText, compactContinueInstruction(t));
  }
  // A plan with a goal but zero steps is a goal nobody ever expanded into executable work: the
  // auto-seed above only ever sets goal + empty steps, and only a real create_plan call adds steps.
  // Left alone, models reproducibly skip straight to bash_terminal/file tools without ever calling
  // create_plan (caught live across every real session in session-log.jsonl — none contained a
  // create_plan call). That leaves plan.steps permanently empty, which starves vibe_bridge's tick
  // loop (it keys off plan.steps to build its directive) of any guidance at all. Force the directive
  // on every goal-like turn until steps actually exist.
  if (activeSessionState.plan && activeSessionState.plan.steps.length === 0 && isGoalLikeMessage(t)) {
    const plan = activeSessionState.plan;
    return recordProcessedPrompt(
      historyText,
      `[Latest user request — prioritize this over recapping completed work: "${t}"]\n[Goal recorded: "${plan.goal}". Before using any other tool, call create_plan({ goal: "${plan.goal}", steps: [...] }) to break this request into concrete steps, THEN execute each step with your other tools. Do not skip straight to other tools without a plan.]`,
    );
  }
  return null;
}

// The pinned "head" of a cut-the-middle retention strategy. When the host rolls raw history it drops
// the oldest turns first — i.e. the goal and everything the agent has already established. This
// reassembles that head from durable state (the plan) plus the distilled facts (Layer 2), so it can be
// re-injected after a roll. The middle is deliberately NOT reproduced — only its distilled facts
// survive — and the recent tail is whatever the host still holds. Returns null when there's no head
// worth pinning yet.
// Whether a user message reads like a task goal worth pinning (vs. a command, continuation, or query
// handled by its own preprocessor branch). Deliberately conservative — a false negative just means no
// auto-goal, whereas a false positive would pin noise as the session's goal.
function isGoalLikeMessage(t: string): boolean {
  if (t.length < 15) return false;
  if (CONTINUATION_PATTERN.test(t)) return false;
  // Questions and conversational information requests should remain ordinary chat. Prefixes such as
  // "now" and "also" do not turn "tell me what..." into executable project work.
  const withoutConversationalPrefixes = t.replace(/^(?:(?:now|also|and|actually|please)\b[\s,]*)+/i, "");
  if (/^(?:tell\s+me\b|what\b|when\b|who\b|how\b|why\b|where\b|which\b)/i.test(withoutConversationalPrefixes)) return false;
  if (/^(?:set|pick|change|switch|go\s+to)\s+workspace\b/i.test(t) || /^workspace\b/i.test(t)) return false;
  if (/^(?:search|find|google|look\s+up|lookup|bing)\b/i.test(t)) return false;
  if (/^(?:calc|calculate|compute)\b/i.test(t) || /\d\s*[-+*/]\s*\d/.test(t)) return false;
  return true;
}

// Hard ceiling on pinned facts even if the char budget would allow more — keeps the head scannable.
const SPINE_MAX_FACTS = 15;
export function headBudgetChars(contextWindow: number): number {
  return estimateCharsFromTokens(Math.max(256, Math.floor(contextWindow * HEAD_BUDGET_RATIO)));
}
// Assemble the pinned head tier-by-tier under a char budget, highest priority first:
//   Tier 1 (pinned):  goal + plan step statuses — always included.
//   Tier 2 (fill):    established facts, newest-first, as many as the remaining budget allows.
// This replaces the fixed fact count with importance-tiered budgeting: the goal/plan is never dropped,
// and facts fill whatever head budget the context window affords.
export function buildContextSpine(session: SessionLog, state: SessionState, maxChars: number = 6000): string | null {
  const header = `${MANAGED_CONTEXT_MARKER}\n[Context spine — pinned so it survives history rolls; do not restate, just build on it]`;
  const tiers: string[] = [];
  let used = header.length;

  // Tier 1: goal + plan. Pinned — added even if it consumes most of the budget.
  if (state.plan && !isCompletedPlan(state.plan)) {
    const goalBlock = `[Goal] ${truncateText(state.plan.goal, 300)}`;
    tiers.push(goalBlock);
    used += goalBlock.length + 1;
    const steps = state.plan.steps
      .map((s) => `  ${s.index}. [${s.status}] ${truncateText(s.description, 120)}`)
      .join("\n");
    if (steps) {
      const planBlock = `[Plan]\n${steps}`;
      tiers.push(planBlock);
      used += planBlock.length + 1;
    }
  }

  // Tier 2: established facts — what the agent has learned, which would otherwise roll off the head.
  const isFact = (m: MemoryEntry) => Array.isArray(m.tags) && m.tags.some((t) => t.startsWith("fact:"));
  let facts = session.readRecentMemories(FACT_DEDUP_SCAN, currentSessionId(state)).filter(isFact);
  if (facts.length === 0) {
    // After a history roll, bootstrapSessionState regenerates the session id (it distrusts session
    // identity once raw history no longer fingerprints the same), so session-scoped retrieval misses
    // the very facts we need to pin. Fall back to the most recent facts regardless of session — right
    // after a roll those are still this session's, just recorded under the previous id.
    facts = session.readRecentMemories(FACT_DEDUP_SCAN).filter(isFact);
  }
  const factLines: string[] = [];
  for (let i = facts.length - 1; i >= 0 && factLines.length < SPINE_MAX_FACTS; i--) {
    const line = `  - ${truncateText(facts[i].content, FACT_DETAIL_CHARS)}`;
    if (used + line.length + 1 > maxChars) break;
    factLines.unshift(line);
    used += line.length + 1;
  }
  if (factLines.length) tiers.push(`[Established facts]\n${factLines.join("\n")}`);

  if (tiers.length === 0) return null;
  return `${header}\n${tiers.join("\n")}`;
}

export async function preprocessMessage(text: string, ctl?: PromptPreprocessorController): Promise<string | null> {
  await bootstrapSessionState(ctl as any);
  // Completion is a lifecycle boundary. Keep the completed work in LM Studio's normal conversation
  // history, but remove its runtime plan and captured directives before building a resumable spine or
  // classifying the next substantive turn. This prevents an all-done goal from hijacking follow-ups
  // in the same process and after a persisted-state rehydration.
  if (text.trim().length > 0 && isCompletedPlan(activeSessionState.plan)) {
    activeSessionState.plan = null;
    activeSessionState.turnCounter = 0;
    activeSessionState.toolCallHistory = [];
    activeSessionState.lastCompactionTurn = 0;
    activeSessionState.lastHandoffSummary = "";
    activeSessionState.lastHandoffTurn = 0;
    activeSessionState.managedContextBlocks = [];
    activeSessionState.resumedFromPersistedState = false;
    writeRuntimeStateSync(activeSessionState);
  }
  const rehydrationBlocks = (activeSessionState.resumedFromPersistedState && activeSessionState.managedContextBlocks.length > 0)
    ? activeSessionState.managedContextBlocks.slice()
    : null;
  // Rebuild the pinned head BEFORE consuming state below. It's built whenever we resumed from
  // persisted state (a detected roll/restart) — the exact moment the host has dropped the head.
  const spine = activeSessionState.resumedFromPersistedState
    ? buildContextSpine(getSessionLog(), activeSessionState, headBudgetChars(await getContextWindow(ctl as any)))
    : null;
  if (rehydrationBlocks || spine) {
    // Consume immediately so it only fires once, and so preprocessMessageCore's own
    // managedContextPresent/hasStoredBlocks checks don't see stale state.
    activeSessionState.managedContextBlocks = [];
    activeSessionState.resumedFromPersistedState = false;
    writeRuntimeStateSync(activeSessionState);
  }
  const result = await preprocessMessageCore(text, ctl);
  // The spine can fire even when there are no stored directive blocks (e.g. a plan exists but no
  // directive was captured), so inject it whenever it's non-null.
  if (!rehydrationBlocks && !spine) return result;
  const preserved = [spine, ...(rehydrationBlocks ?? [])].filter(Boolean).join("\n\n");
  const rehydrated = `${MANAGED_CONTEXT_MARKER}\n[Session resumed from saved state. Here is the previous context that was preserved:]\n\n${preserved}\n\n[If a step was in progress, continue it — do not restart. Otherwise proceed with the request below.]`;
  return result ? `${rehydrated}\n\n${result}` : rehydrated;
}
