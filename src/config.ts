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
        "contextLength",
        "numeric",
        {
          displayName: "Context Length (tokens)",
          subtitle: "How many tokens of context the model keeps. When the conversation exceeds this limit, older messages are truncated (cut in the middle). Set to 0 to use the model's default. Requires a model reload to take effect.",
          int: true,
          min: 0,
          max: 262144,
          slider: { min: 0, max: 262144, step: 1024 },
        },
        0,
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
