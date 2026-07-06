console.log("[ENTRY] dist/index.js loaded");

import { type PluginContext } from "@lmstudio/sdk";
import { handler } from "./handler";

export async function main(context: PluginContext) {
  console.log("[AgenticTools] main() called");
  context.withPredictionLoopHandler(handler);
  console.log("[AgenticTools] Prediction loop handler registered.");
}
