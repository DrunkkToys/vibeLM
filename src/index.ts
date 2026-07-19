console.log("[ENTRY] dist/index.js loaded");

import { type PluginContext, type ChatMessage, LMStudioClient } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider, preprocessMessage, reasoningDirectiveForSession, predictionLoopHandler } from "./toolsProvider";

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

  const clientIdentifier = process.env.LMS_PLUGIN_CLIENT_IDENTIFIER;
  const clientPasskey = process.env.LMS_PLUGIN_CLIENT_PASSKEY;
  const baseUrl = process.env.LMS_PLUGIN_BASE_URL;
  const bridgeClient = (clientIdentifier && clientPasskey && baseUrl)
    ? new LMStudioClient({ clientIdentifier, clientPasskey, baseUrl })
    : null;

  console.log("[AgenticTools] Registering tools provider...");
  try {
    context.withConfigSchematics(configSchematics);
    context.withToolsProvider((ctl) => toolsProvider(ctl, bridgeClient));
  } catch (error) {
    console.error("[AgenticTools] Failed to register tools provider.");
    throw error;
  }

  console.log("[AgenticTools] Registering prediction loop handler...");
  try {
    context.withPredictionLoopHandler((ctl) => predictionLoopHandler(ctl, bridgeClient));
  } catch (error) {
    console.error("[AgenticTools] Failed to register prediction loop handler.");
    throw error;
  }

  console.log("[AgenticTools] Registering prompt preprocessor...");
  try {
    context.withPromptPreprocessor(async (_ctl: any, userMessage: ChatMessage) => {
      const text = userMessage.getText();
      if (!text) return userMessage;

      const processed = await preprocessMessage(text, _ctl);
      // Reasoning-effort directive is applied here (after preprocessMessage) so it stays out of the
      // recorded/hashed managed-context state and applies uniformly to every outgoing message.
      const directive = await reasoningDirectiveForSession(_ctl);

      if (processed) {
        return directive ? `${processed}\n\n${directive}` : processed;
      }
      // No text transform: append to the ChatMessage in place so image/file attachments (VLMs) survive.
      if (directive) {
        userMessage.appendText(`\n\n${directive}`);
      }
      return userMessage;
    });
  } catch (error) {
    console.error("[AgenticTools] Failed to register prompt preprocessor.");
    throw error;
  }

  console.log("[AgenticTools] Tools provider registered.");
}
