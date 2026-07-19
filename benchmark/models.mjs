import { LMStudioClient } from "@lmstudio/sdk";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REMOTES_PATH = resolve(fileURLToPath(new URL(".", import.meta.url)), "remotes.json");

// benchmark/remotes.json (optional, gitignored): [{ label, baseUrl, clientIdentifier, clientPasskeyEnv }]
// Same shape as the vibe_bridge remote-client wiring in src/index.ts:22-27.
function loadRemoteConfigs() {
  if (!existsSync(REMOTES_PATH)) return [];
  const raw = JSON.parse(readFileSync(REMOTES_PATH, "utf-8"));
  return Array.isArray(raw) ? raw : [];
}

function clientFor(remote) {
  if (!remote) return new LMStudioClient();
  const clientPasskey = remote.clientPasskeyEnv ? process.env[remote.clientPasskeyEnv] : undefined;
  return new LMStudioClient({
    baseUrl: remote.baseUrl,
    clientIdentifier: remote.clientIdentifier,
    clientPasskey,
  });
}

// Auto-discovers every model in each configured LM Studio instance's own dropdown
// (client.system.listDownloadedModels("llm")) rather than a hand-typed allowlist,
// per explicit instruction: "test all: gemma all the qwen glm gpt, all what is
// available in the dropdown menu."
export async function discoverModels() {
  const endpoints = [{ label: "local", remote: undefined }, ...loadRemoteConfigs().map((r) => ({ label: r.label, remote: r }))];

  const discovered = [];
  for (const endpoint of endpoints) {
    const client = clientFor(endpoint.remote);
    const infos = await client.system.listDownloadedModels("llm");
    for (const info of infos) {
      discovered.push({
        endpointLabel: endpoint.label,
        label: `${endpoint.label}:${info.modelKey}`,
        modelKey: info.modelKey,
        path: info.path,
        architecture: info.architecture,
        remote: endpoint.remote,
      });
    }
  }
  return discovered;
}

export function clientForEntry(entry) {
  return clientFor(entry.remote);
}

// The single "standard" load config every model in the benchmark must use, so results are
// actually comparable (same context budget, same cache precision) instead of each model
// getting whatever its own default happened to be. Forensically captured via the SDK from
// a model the user had already configured by hand in LM Studio (benchmark/_capture_config.mjs
// dumped its live `PredictionResult.loadConfig`), then translated from the raw KVConfig field
// names to the SDK's friendly LLMLoadModelConfig field names:
//   llm.load.contextLength            -> contextLength
//   llm.load.llama.flashAttention     -> flashAttention
//   llm.load.llama.kCacheQuantizationType (q4_0, checked) -> llamaKCacheQuantizationType
//   llm.load.llama.vCacheQuantizationType (q4_0, checked) -> llamaVCacheQuantizationType
//   llm.load.offloadKVCacheToGpu      -> offloadKVCacheToGpu
//   llm.load.llama.keepModelInMemory  -> keepModelInMemory
//   llm.load.numExperts               -> numExperts
// contextLength itself was overridden down from the captured 262144: at full context every
// model in the catalog exceeded this machine's local loading guardrail (each failed with
// "insufficient system resources", 13-26GB needed). 4096 is the largest value confirmed to
// load every model in REMOTE_CATALOG_MODELS -- still identical across all of them, which is
// the actual requirement (a fair comparison), not the biggest number possible.
export const STANDARD_LOAD_CONFIG = {
  contextLength: 4096,
  flashAttention: true,
  llamaKCacheQuantizationType: "q4_0",
  llamaVCacheQuantizationType: "q4_0",
  offloadKVCacheToGpu: false,
  keepModelInMemory: false,
  numExperts: 8,
};

// The LM Studio "Remote" catalog tab (models served via the exo distributed-compute mesh,
// identified by a peer-hash-prefixed key like "d00804ddc9fbf5a7216dbef43a8520e4:qwen/...")
// isn't enumerable through this SDK version -- no listRemote/catalog API exists (verified:
// grepping @lmstudio/sdk's .d.ts for "remote"/"catalog" turns up nothing beyond deprecated
// Hub-upload helpers). These 8 are the models visible in that tab as of tonight's live check.
export const REMOTE_CATALOG_MODELS = [
  { label: "remote:nemotron-3-nano", modelKey: "nvidia/nemotron-3-nano-omni" },
  { label: "remote:qwen3.6-35b-a3b", modelKey: "qwen/qwen3.6-35b-a3b" },
  { label: "remote:qwen3-coder-30b", modelKey: "qwen/qwen3-coder-30b" },
  { label: "remote:glm-4.7-flash", modelKey: "zai-org/glm-4.7-flash" },
  { label: "remote:qwen3.6-27b", modelKey: "qwen/qwen3.6-27b" },
  { label: "remote:gemma-4-26b-a4b", modelKey: "google/gemma-4-26b-a4b-qat" },
  { label: "remote:gpt-oss-20b", modelKey: "openai/gpt-oss-20b" },
  { label: "remote:gemma-4-e4b", modelKey: "google/gemma-4-e4b" },
];
