import { createConfigSchematics } from "@lmstudio/sdk";
import { TOOL_TOGGLES } from "./toolSettings";

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
        "vibe_bridge_prompt",
        "string",
        {
          displayName: "Vibe Bridge: Default Prompt",
          subtitle: "The prompt injected on each keep-alive cycle. Override per-call with the prompt parameter.",
          isParagraph: true,
          placeholder: "Continue working on the current task.",
        },
        "Continue working on the current task.",
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
        600,
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
        21600,
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
