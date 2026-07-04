console.log("[ENTRY] dist/index.js loaded");

import { type PluginContext, type ChatMessage } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";

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
    console.warn(`[AgenticTools] Cannot reach LM Studio API (localhost:${process.env.LMSTUDIO_API_PORT || "1234"}). Run 'lms server start' — callLLM tools will not work until the server is running.`);
  }

  console.log("[AgenticTools] Registering tools provider...");
  context.withToolsProvider(toolsProvider);
  console.log("[AgenticTools] Tools provider registered.");
}
