import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "maxOrchestratorTurns",
    "numeric",
    {
      displayName: "Max Orchestrator Turns",
      subtitle: "Hard cap on how many tool turns the agent can use before it must stop and respond.",
      int: true,
      min: 1,
      max: 100,
      slider: { min: 1, max: 50, step: 1 },
    },
    50,
  )
  .field(
    "contextOverflowHeadroomTokens",
    "numeric",
    {
      displayName: "Rolling Window Trigger Tokens",
      subtitle: "When the remaining context drops below this many tokens, vibeLM treats the session as near limit and can compact or recommend rolling-window behavior.",
      int: true,
      min: 256,
      max: 8192,
      slider: { min: 256, max: 4096, step: 128 },
    },
    1024,
  )
  .build();
