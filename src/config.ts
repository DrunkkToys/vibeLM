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
  .build();
