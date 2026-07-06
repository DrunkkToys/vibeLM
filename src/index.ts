console.log("[ENTRY] dist/index.js loaded");

import { type PluginContext, type ChatMessage } from "@lmstudio/sdk";
import { toolsProvider, preprocessMessage } from "./toolsProvider";
import { getSystemPrompt } from "./prompts/system";

let systemPromptInjected = false;

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
  context.withToolsProvider(toolsProvider);

  console.log("[AgenticTools] Registering prompt preprocessor...");
  context.withPromptPreprocessor(async (_ctl: any, userMessage: ChatMessage) => {
    const text = userMessage.getText();
    if (!text) return userMessage;

    if (!systemPromptInjected) {
      systemPromptInjected = true;
      const systemPrompt = getSystemPrompt();
      userMessage.replaceText(`${systemPrompt}\n\n${text}`);
      console.log("[AgenticTools] System prompt injected (prepended to first user message)");
      return userMessage;
    }

    const processed = await preprocessMessage(text);
    if (processed) return processed;

    return userMessage;
  });

  console.log("[AgenticTools] Tools provider registered.");
}
