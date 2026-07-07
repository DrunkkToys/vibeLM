import { createConfigSchematics } from "@lmstudio/sdk";

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
      );

    return scoped;
  })
  .build();
