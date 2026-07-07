console.log("[ENTRY] dist/index.js loaded");

import { type PluginContext, type ChatMessage } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider, preprocessMessage } from "./toolsProvider";

export async function main(context: PluginContext) {
  console.log("[AgenticTools] main() called");

  try {
    const port = process.env.LMSTUDIO_API_PORT || "1234";
    const resp = await fetch(`http://localhost:${port}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      console.warn(`[AgenticTools] LM Studio API returned HTTP ${resp.status}. Run 'lms server start'`);
    } else {
      console.log(`[AgenticTools] LM Studio API server reachable on port ${port}`);
    }
  } catch {
    console.warn(`[AgenticTools] Cannot reach LM Studio API (localhost:${process.env.LMSTUDIO_API_PORT || "1234"}). Run 'lms server start'`);
  }

  console.log("[AgenticTools] Registering tools provider...");
  try {
    context.withConfigSchematics(configSchematics);
    context.withToolsProvider(toolsProvider);
  } catch (error) {
    console.error("[AgenticTools] Failed to register tools provider.");
    throw error;
  }

  console.log("[AgenticTools] Registering prompt preprocessor...");
  try {
    context.withPromptPreprocessor(async (_ctl: any, userMessage: ChatMessage) => {
      const text = userMessage.getText();
      if (!text) return userMessage;

      const processed = await preprocessMessage(text, _ctl);
      if (processed) return processed;

      return userMessage;
    });
  } catch (error) {
    console.error("[AgenticTools] Failed to register prompt preprocessor.");
    throw error;
  }

  console.log("[AgenticTools] Tools provider registered.");
}
