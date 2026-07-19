import { createConfigSchematics } from "@lmstudio/sdk";
import { TOOL_TOGGLES } from "./toolSettings";

// Single source of truth for vibe_bridge defaults — read by toolsProvider.ts's fallback chain
// instead of duplicating these values in a second place.
export const DEFAULT_VIBE_BRIDGE_PROMPT = "Check progress to reach your goal, if you are failing adjust trajectory.";
export const DEFAULT_VIBE_BRIDGE_INTERVAL = 600;
export const DEFAULT_VIBE_BRIDGE_MAX_DURATION = 21600;

export const configSchematics = createConfigSchematics()
  .scope("tools", (builder) => {
    let scoped = builder
      .field(
        "maxOrchestratorTurns",
        "numeric",
        {
          displayName: "Max Orchestrator Turns",
          subtitle: "Hard cap on how many tool turns the agent can use before it must stop and respond. Set to 0 to disable the hard cap.",
          int: true,
          min: 0,
          max: 100,
          slider: { min: 0, max: 100, step: 1 },
        },
        50,
      )
      .field(
        "rollingWindowTriggerTokens",
        "numeric",
        {
          displayName: "Rolling Window Trigger Limit (prompt tokens)",
          subtitle: "Enter a token count, not characters. Set 0 to auto-derive from the selected model context window minus a safety margin. When the prompt estimate reaches this many tokens, vibeLM treats the session as near limit and can compact or recommend rolling-window behavior.",
          int: true,
          min: 0,
          max: 16384,
          slider: { min: 0, max: 16384, step: 256 },
        },
        0,
      )
      .field(
        "maxEffectiveContextTokens",
        "numeric",
        {
          displayName: "Max Effective Context (tokens)",
          subtitle: "Optional hard cap on the token budget vibeLM plans against. vibeLM already reads the model's actual loaded context length, so leave this at 0 for normal use. Set it only if your machine can't sustain even the configured length (e.g. a large VLM whose KV cache exhausts unified memory) — vibeLM will then compact against this lower ceiling instead.",
          int: true,
          min: 0,
          max: 1048576,
          slider: { min: 0, max: 262144, step: 1024 },
        },
        0,
      )
      .field(
        "compactionTriggerPercent",
        "numeric",
        {
          displayName: "Auto-Compaction Trigger (% of context)",
          subtitle: "How full the context gets before vibeLM auto-summarizes older history into memory. Lower = compact earlier (more headroom, but compaction is lossy and costs a model call, so it runs more often); higher = keep more live context (better fidelity for long tasks, closer to the limit). Works on top of the actual loaded context window; the Rolling Window and Max Effective Context settings govern warnings/caps, this one governs compaction.",
          int: true,
          min: 10,
          max: 90,
          slider: { min: 10, max: 90, step: 5 },
        },
        30,
      )
      .field(
        "reasoningEffort",
        "select",
        {
          displayName: "Reasoning Effort",
          subtitle: "Calibrates how much the model 'thinks' before answering. Mapped per model family: gpt-oss uses its native Harmony 'Reasoning: low/medium/high' tiers (deterministic); Qwen uses /no_think and /think soft switches; other models get an equivalent natural-language directive. 'off' keeps sessions leanest and avoids reasoning-loop hangs.",
          options: [
            { value: "off", displayName: "Off — answer directly" },
            { value: "low", displayName: "Low — brief reasoning" },
            { value: "medium", displayName: "Medium — moderate reasoning" },
            { value: "high", displayName: "High — full reasoning" },
          ],
        },
        "off",
      )
      .field(
        "maxThinkingSteps",
        "numeric",
        {
          displayName: "Max Thinking Steps",
          subtitle: "Caps the number of prediction rounds an unattended vibe_bridge tick may take, so a model stuck reasoning without calling a tool (looping on 'Wait... Actually...') can't run unbounded — it is canceled and counted as a failed tick instead. Lower this to fail fast; raise it to allow more multi-step work per tick.",
          int: true,
          min: 1,
          max: 50,
          slider: { min: 1, max: 50, step: 1 },
        },
        8,
      )
      .field(
        "enforceMainChatBounds",
        "boolean",
        {
          displayName: "Enforce Main Chat Bounds",
          subtitle: "vibeLM owns the main chat's prediction loop so Max Orchestrator Turns and the always-reasoning token floor can actually cap the interactive chat too, not just vibe_bridge ticks — fixes a model rambling with no tool call ever bounding out. Turning this off keeps vibeLM rendering the chat but removes those caps (uncapped rounds/tokens), for use only if the caps themselves cause problems.",
        },
        true,
      )
      .field(
        "vibe_bridge_prompt",
        "string",
        {
          displayName: "Vibe Bridge: Default Prompt",
          subtitle: "The prompt injected on each keep-alive cycle. Override per-call with the prompt parameter.",
          isParagraph: true,
          placeholder: DEFAULT_VIBE_BRIDGE_PROMPT,
        },
        DEFAULT_VIBE_BRIDGE_PROMPT,
      )
      .field(
        "vibe_bridge_interval",
        "numeric",
        {
          displayName: "Vibe Bridge: Interval (seconds)",
          subtitle: "Seconds between keep-alive injections. E.g. 600 = every 10 minutes.",
          int: true,
          min: 5,
          max: 3600,
          slider: { min: 5, max: 3600, step: 5 },
        },
        DEFAULT_VIBE_BRIDGE_INTERVAL,
      )
      .field(
        "vibe_bridge_maxDuration",
        "numeric",
        {
          displayName: "Vibe Bridge: Max Duration (seconds)",
          subtitle: "Maximum total runtime before auto-stop. E.g. 21600 = 6 hours. Set 0 for unlimited.",
          int: true,
          min: 0,
          max: 86400,
          slider: { min: 0, max: 86400, step: 600 },
        },
        DEFAULT_VIBE_BRIDGE_MAX_DURATION,
      );

    for (const tool of TOOL_TOGGLES) {
      scoped = scoped.field(
        tool.name,
        "boolean",
        {
          displayName: tool.displayName,
          subtitle: tool.subtitle,
        },
        tool.defaultEnabled,
      );
    }

    return scoped;
  })
  .build();
