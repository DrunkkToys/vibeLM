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
const COMPACT_CONTEXT_TRIGGER_TURNS = 5;
const COMPACT_CONTEXT_TRIGGER_RATIO = 0.30;
const COMPACT_CONTEXT_MIN_GAP_TURNS = 3;
const COMPACT_CONTEXT_MAX_RECENT_TURNS = 80;
const COMPACT_CONTEXT_DEFAULT_MAX_TOKENS = 500;
const COMPACT_CONTEXT_SAFETY_MARGIN = 256;
const DEFAULT_MAX_ORCHESTRATOR_TURNS = 50;
const DEFAULT_ROLLING_WINDOW_TRIGGER_TOKENS = 3000;
// vibe_bridge ticks are a standalone model.act() call outside the main orchestrator, so they
// don't inherit maxOrchestratorTurns. Without their own cap, a model stuck reasoning without
// calling any tool (e.g. looping on "Wait... Actually...") can run unbounded — confirmed live,
// one tick ran 43 minutes with zero tool calls after a set_workspace error it never recovered from.
const VIBE_BRIDGE_TICK_MAX_ROUNDS = 8;
const VIBE_BRIDGE_TICK_TIMEOUT_MS = 180_000;
const LOOP_WINDOW = 5;
const CHECKPOINT_INTERVAL_MAX = 10;
const CHECKPOINT_INTERVAL_EARLY = 4;
const CONTINUATION_PATTERN = /(?:keep\s+(?:going|working|doing)|continue|go\s+(?:on|ahead)|proceed|carry\s+on|resume|move\s+on|what(?:'s|\sis)\s+next|next\s+step|finish\s+(?:it|the\s+task|the\s+rest)|complete\s+(?:it|the\s+task)|do\s+the\s+rest|pick\s+up\s+where|as\s+you\s+were|same\s+(?:as\s+before|thing)|and\s+then|go\s+ahead|yeah|yes|ok|okay|sure|right)/i;
const readOnlyTools = ["list_files", "read_file", "search_files", "get_current_datetime", "get_config", "list_memories", "search_memory"];
const MANAGED_CONTEXT_MARKER = "[vibeLM:managed-context]";
// Denylist, not allowlist: bash_terminal is a general-purpose dev tool (git, npm, build scripts,
// etc.), so an allowlist would block too much legitimate use. This blocks clearly destructive or
// privilege-escalating patterns rather than trying to enumerate every safe command.
const BASH_DANGEROUS_PATTERNS: RegExp[] = [
  /rm\s+(-\w*[rf]\w*[rf]?\w*|--recursive|--force)\s+(-\w*\s+)*(\/|~|\$HOME|\*)(\s|$)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  />\s*\/dev\/(sd|nvme|disk|hd|null\s*;)/i,
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

async function getContextWindow(ctl?: any): Promise<number> {
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
  const resolved = resolve(workspace, requestedPath);
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

type SessionState = {
  sessionId: string;
  turnCounter: number;
  toolCallHistory: Array<{ name: string; signature: string; ts: number }>;
  lastCompactionTurn: number;
  historyFingerprint: string;
  resumedFromPersistedState: boolean;
  managedContextBlocks: string[];
  lastHandoffSummary: string;
  lastHandoffTurn: number;
};

function createSessionState(): SessionState {
  return {
    sessionId: randomUUID(),
    turnCounter: 0,
    toolCallHistory: [],
    lastCompactionTurn: 0,
    historyFingerprint: "",
    resumedFromPersistedState: false,
    managedContextBlocks: [],
    lastHandoffSummary: "",
    lastHandoffTurn: 0,
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
  resumedFromPersistedState: boolean;
  updatedAt: string;
  managedContextBlocks?: string[];
  lastHandoffSummary?: string;
  lastHandoffTurn?: number;
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
      resumedFromPersistedState: Boolean(parsed.resumedFromPersistedState),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      managedContextBlocks: Array.isArray(parsed.managedContextBlocks) ? parsed.managedContextBlocks.filter((b: unknown) => typeof b === "string") : [],
      lastHandoffSummary: typeof parsed.lastHandoffSummary === "string" ? parsed.lastHandoffSummary : "",
      lastHandoffTurn: typeof parsed.lastHandoffTurn === "number" ? parsed.lastHandoffTurn : 0,
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
      resumedFromPersistedState: state.resumedFromPersistedState,
      updatedAt: new Date().toISOString(),
      managedContextBlocks: state.managedContextBlocks,
      lastHandoffSummary: state.lastHandoffSummary,
      lastHandoffTurn: state.lastHandoffTurn,
    };
    writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    console.error("[AgenticTools] writeRuntimeStateSync failed, session state was not persisted:", err);
  }
}

async function readHistoryText(ctl?: PromptPreprocessorController | ToolsProviderController): Promise<string | null> {
  try {
    const history = await (ctl as any)?.pullHistory?.();
    if (!history) return null;
    return composeHistoryText(history.getSystemPrompt(), history.toString());
  } catch {
    return null;
  }
}

async function bootstrapSessionState(ctl?: PromptPreprocessorController | ToolsProviderController, force = false): Promise<SessionState> {
  if (activeSessionInitialized && !force) {
    return activeSessionState;
  }

  if (force) {
    activeSessionInitialized = false;
    activeSessionBootstrapPromise = null;
    activeSessionState = createSessionState();
  }

  if (!activeSessionBootstrapPromise) {
    activeSessionBootstrapPromise = (async () => {
      const historyText = await readHistoryText(ctl);
      if (!historyText) {
        activeSessionState = createSessionState();
      } else {
        const historyFingerprint = fingerprintHistoryText(historyText);
        const persisted = readRuntimeStateSync();
        if (persisted && persisted.historyFingerprint === historyFingerprint) {
          activeSessionState = {
            sessionId: persisted.sessionId,
            turnCounter: persisted.turnCounter,
            toolCallHistory: [],
            lastCompactionTurn: persisted.lastCompactionTurn,
            historyFingerprint,
            resumedFromPersistedState: true,
            managedContextBlocks: persisted.managedContextBlocks ?? [],
            lastHandoffSummary: persisted.lastHandoffSummary ?? "",
            lastHandoffTurn: persisted.lastHandoffTurn ?? 0,
          };
        } else {
          activeSessionState = createSessionState();
          activeSessionState.historyFingerprint = historyFingerprint;
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
  }
  writeRuntimeStateSync(state);
}

function recordProcessedPrompt(historyText: string, processed: string, state: SessionState = activeSessionState): string {
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

function estimateCharsFromTokens(tokens: number): number {
  return Math.max(1, tokens * 4);
}

function hardPromptBudgetLimit(contextWindow: number): number {
  return Math.max(512, Math.floor(contextWindow * PROMPT_BUDGET_RATIO));
}

function formatPromptBudgetHandoff(contextWindow: number, estimatedTokens: number, mode: "workspace" | "multi-step" | "general"): string {
  return `${MANAGED_CONTEXT_MARKER}
[Budget warning: estimated ${estimatedTokens}/${contextWindow} tokens with a ${COMPACT_CONTEXT_SAFETY_MARGIN}-token safety margin.]
[Action: preserve code verbatim, summarize only the actionable state, and call amend with the best available handoff.]
[If the user wants a clean slate, tell them to start a new chat and paste the summary.]`;
}

function buildPromptBudgetReport(
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

function compactTaskReminder(stepCount: number): string {
  return `${MANAGED_CONTEXT_MARKER}
[Task mode: follow all ${stepCount} listed steps in order. Use one tool call at a time. Call amend when the task is done, blocked, or you have the best available handoff and cannot safely continue.]`;
}

function compactContinueInstruction(): string {
  return `${MANAGED_CONTEXT_MARKER}
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

function detectRepeatedToolSignature(state: SessionState, name: string, signature: string): string | null {
  state.toolCallHistory.push({ name, signature, ts: Date.now() });
  if (state.toolCallHistory.length > LOOP_WINDOW) {
    state.toolCallHistory = state.toolCallHistory.slice(-LOOP_WINDOW);
  }
  if (state.toolCallHistory.length >= 4) {
    const last4 = state.toolCallHistory.slice(-4).map((t) => t.signature);
    if (last4.every((sig) => sig === last4[0])) {
      return state.toolCallHistory[state.toolCallHistory.length - 1].name;
    }
  }
  const window = state.toolCallHistory.slice(-6);
  const counts: Record<string, number> = {};
  for (const t of window) {
    counts[t.signature] = (counts[t.signature] || 0) + 1;
  }
  for (const [n, c] of Object.entries(counts)) {
    if (c >= 4) {
      const match = window.find((entry) => entry.signature === n);
      return match?.name || null;
    }
  }
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

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

async function getHistoryText(ctl?: PromptPreprocessorController): Promise<string> {
  if (!ctl) return "";
  try {
    const history = await ctl.pullHistory();
    return composeHistoryText(history.getSystemPrompt(), history.toString());
  } catch {
    return "";
  }
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

function stringifyToolResult(result: unknown): string {
  try {
    const text = JSON.stringify(result);
    return truncateText(text, MAX_TOOL_RESULT_CHARS);
  } catch {
    return truncateText(String(result), MAX_TOOL_RESULT_CHARS);
  }
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
  return tokenEstimate >= Math.floor(contextWindow * COMPACT_CONTEXT_TRIGGER_RATIO);
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
        return {
          ok: false,
          error: `Max turns (${maxTurns}) exceeded. Use amend with what you have so far.`,
        };
      }

      const looped = detectRepeatedToolSignature(state, name, toolSignature(name, args));
      if (looped) {
        return {
          ok: false,
          error: `Loop detected: tool "${looped}" called ${LOOP_WINDOW}+ times consecutively. Try a different approach or call amend to produce your answer.`,
        };
      }

      console.log(`[AgenticTools] [turn ${state.turnCounter}] Tool: ${name}`);

      let result: any;
      try {
        result = await origImpl(args, ctx);
      } catch (e: any) {
        result = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      const log = getSessionLog();
      const serializedResult = stringifyToolResult(result);
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
      if (!readOnlyTools.includes(name) && !["save_memory","compact_context","search_memory","list_memories","clear_memories","delete_memory","update_memory"].includes(name)) {
        const tags = buildMemoryTags([`turn:${state.turnCounter}`, `tool:${name}`], currentSessionId(state), workspace || "", "workspace");
        log.saveMemory(tags, `${name} → ${serializedResult}`, state.turnCounter, currentSessionId(state), workspace || undefined, "workspace");
      }

      if (shouldSaveCheckpoint(state)) {
        log.saveCheckpoint(
          `Turn ${state.turnCounter}: called ${name} — result ok=${result?.ok}`,
          ["checkpoint", `turn:${state.turnCounter}`],
          state.turnCounter,
          currentSessionId(state),
        );
      }

      if (name !== "compact_context" && shouldAutoCompactSession(log, state, await getContextWindow(ctx))) {
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
  const sessionState = await bootstrapSessionState(ctl, true);
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
NOTE: This uses the system clock. Timezone reflects local machine settings.`,
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
      activeSessionState.lastHandoffSummary = text;
      activeSessionState.lastHandoffTurn = activeSessionState.turnCounter;
      const managedBlock = new RegExp(`${escapeRegExp(MANAGED_CONTEXT_MARKER)}[\\s\\S]*?(?=\\n{2,}|$)`, "g");
      const blocks: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = managedBlock.exec(text)) !== null) {
        blocks.push(match[0]);
      }
      if (blocks.length > 0) {
        activeSessionState.managedContextBlocks = blocks;
      }
      writeRuntimeStateSync(activeSessionState);
      return {
        ok: true,
        data: { text },
      };
    },
  });

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
EXAMPLE: delete_file({ path: "temp/output.txt" })
NOTE: Will NOT delete non-empty directories. Use bash_terminal 'rm -rf' for that.`,
    parameters: {
      path: z.string().min(1).describe("Path relative to workspace"),
    },
    implementation: async ({ path }) => {
      try {
        const ws = requireWorkspace(ctl);
        const resolved = sandboxPath(ws, path);
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
USE WHEN: you need to run shell commands, scripts, or access binary files.
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
        const { exec } = await import("child_process");
        return await new Promise((res) => {
          exec(command, { cwd: requireWorkspace(ctl), env: { ...process.env }, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
        content,
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
          handover = result.content.trim();
        }

        // Step 2: Build chat with handover + bridge prompt
        const chatMessages: Array<{ role: "system" | "user"; content: string }> = [];
        if (handover) {
          chatMessages.push({
            role: "system",
            content: `Context from the current session:\n${handover}`,
          });
        }
        chatMessages.push({
          role: "user",
          content: _bridgePrompt,
        });

        const chat = Chat.from(chatMessages);
        // bash_terminal is intentionally excluded from unattended ticks until it has a command
        // allowlist — see NOTES.md. vibe_bridge/amend are excluded to avoid nested bridge starts
        // and orchestrator-specific finalize semantics that don't apply to this standalone act() call.
        const bridgeTickTools = [
          exploreWorkspaceTool, listFilesTool, readFileTool, writeFileTool, appendFileTool,
          searchFilesTool, saveMemoryTool, searchMemoryTool, webFetchTool, webSearchTool,
        ];
        await model.act(chat, bridgeTickTools, {
          maxPredictionRounds: VIBE_BRIDGE_TICK_MAX_ROUNDS,
          signal: AbortSignal.timeout(VIBE_BRIDGE_TICK_TIMEOUT_MS),
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
      const resolvedPrompt = prompt || String(readPluginConfigValue(ctl, ["tools.vibe_bridge_prompt", "vibe_bridge_prompt"])
        || DEFAULT_VIBE_BRIDGE_PROMPT);
      const resolvedInterval = interval ?? Number(readPluginConfigValue(ctl, ["tools.vibe_bridge_interval", "vibe_bridge_interval"])
        ?? DEFAULT_VIBE_BRIDGE_INTERVAL);
      const resolvedMaxDuration = maxDuration ?? Number(readPluginConfigValue(ctl, ["tools.vibe_bridge_maxDuration", "vibe_bridge_maxDuration"])
        ?? DEFAULT_VIBE_BRIDGE_MAX_DURATION);
      if (_bridgeTimer) clearTimeout(_bridgeTimer);
      _bridgeActive = true;
      _bridgePrompt = resolvedPrompt;
      _bridgeInterval = resolvedInterval;
      _bridgeIteration = 0;
      _bridgeConsecutiveFailures = 0;
      _bridgeMaxIterations = maxIterations ?? 0;
      _bridgeMaxDuration = resolvedMaxDuration;
      _bridgeStartedAt = Date.now();
      _scheduleNextBridgeIteration();
      ctx?.status?.(`Bridge started: ${_bridgeInterval}s interval, max ${_bridgeMaxDuration ? `${_bridgeMaxDuration}s` : "∞"}`);
      return ok({
        active: true,
        prompt: _bridgePrompt.slice(0, 100),
        interval: _bridgeInterval,
        maxDuration: _bridgeMaxDuration,
        maxIterations: _bridgeMaxIterations || "unlimited",
      });
    },
  }), "vibe_bridge");

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
    vibe_bridge: vibeBridgeTool,
  };

  const MANDATORY_ENABLED = ["amend"];

  const enabledNames = dedupeTags([
    ...resolveEnabledToolNames(ctl),
    ...MANDATORY_ENABLED,
  ]);
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

  return allTools;
}

export async function preprocessMessage(text: string, ctl?: PromptPreprocessorController): Promise<string | null> {
  const t = text.trim();
  await bootstrapSessionState(ctl as any);
  const contextWindow = await getContextWindow(ctl as any);
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
      return recordProcessedPrompt(historyText, `[Tool executed: set_workspace]`);
    }
    return recordProcessedPrompt(historyText, `[Tool error: set_workspace → path not found: ${resolved}]`);
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
        return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, plainReport.estimatedTokens, "multi-step"));
      }
      // Continuation: replace stale "follow all steps" instruction with a continue directive
      if (CONTINUATION_PATTERN.test(t)) {
        return recordProcessedPrompt(historyText, compactContinueInstruction());
      }
      return null;
    }
    const report = buildPromptBudgetReport(normalizedHistoryText, t, contextWindow, rollingWindowTriggerTokens);
    if (report.overflow) {
      return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, report.estimatedTokens, "multi-step"));
    }
    return recordProcessedPrompt(historyText, compactTaskReminder(steps.length));
  }

  const calcMatch = t.match(/^(?:calculate|evaluate|solve|what\s+is|compute)\s+(.+)/i);
  if (calcMatch) {
    try {
      const calcResp = await import("mathjs").then(m => m.evaluate(calcMatch[1]));
      if (typeof calcResp === "number" || typeof calcResp === "string") {
        const processed = `[Tool executed: calculate → ${calcResp}]`;
        const report = buildPromptBudgetReport(normalizedHistoryText, processed, contextWindow, rollingWindowTriggerTokens);
        if (report.overflow) {
          return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, report.estimatedTokens, "general"));
        }
        return recordProcessedPrompt(historyText, processed);
      }
    } catch (e) {
      console.warn(`[AgenticTools] calculate preprocessor failed:`, e);
    }
  }

  const searchMatch = t.match(/^(?:search|find|google|look\s+up|lookup|bing)\s+(?:the\s+web\s+)?(?:for\s+)?(.+)/i);
  if (searchMatch) {
    try {
      const results = await webSearch(searchMatch[1], 5);
      if (results.length > 0) {
        const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`);
        const processed = `[Tool executed: web_search →\n${lines.join("\n")}]\n\n${t}`;
        const report = buildPromptBudgetReport(normalizedHistoryText, processed, contextWindow, rollingWindowTriggerTokens);
        if (report.overflow) {
          return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, report.estimatedTokens, "general"));
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
    return recordProcessedPrompt(historyText, formatPromptBudgetHandoff(contextWindow, plainReport.estimatedTokens, "general"));
  }
  // Continuation in managed-context session: prevent LLM from re-executing stale instructions
  if (managedContextPresent && CONTINUATION_PATTERN.test(t)) {
    if (hasStoredBlocks) {
      const rehydrated = `${MANAGED_CONTEXT_MARKER}\n[Session resumed from saved state. Here is the previous context that was preserved:]\n\n${activeSessionState.managedContextBlocks.join("\n\n")}\n\n[Continue from the last completed step. Do NOT restart. Read the history and proceed with the next uncompleted step.]`;
      activeSessionState.managedContextBlocks = [];
      activeSessionState.resumedFromPersistedState = false;
      writeRuntimeStateSync(activeSessionState);
      return recordProcessedPrompt(historyText, rehydrated);
    }
    return recordProcessedPrompt(historyText, compactContinueInstruction());
  }
  return null;
}
