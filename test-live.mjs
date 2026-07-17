import { LMStudioClient, Chat } from "@lmstudio/sdk";

const client = new LMStudioClient();
const model = await client.llm.model();
console.log("Model:", model.modelKey);

// Try act with tools — see what's registered by the plugin
const result = await model.act("What tools do you have? List them.", [], {
  maxSteps: 1,
  onMessage: (msg) => console.log("MSG:", msg.toData?.()),  
});

console.log("\n=== Result ===");
console.log(JSON.stringify({ finishReason: result.finishReason, content: result.content?.slice(0, 500) }, null, 2));
