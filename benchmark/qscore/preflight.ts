import { pathToFileURL } from "node:url";

type LoadedModelsPayload = {
  models?: Array<{
    key?: string;
    loaded_instances?: Array<{
      id?: string;
      config?: { context_length?: number };
    }>;
  }>;
};

export function assertSingleLoadedModel(payload: LoadedModelsPayload, requestedModel: string) {
  const loaded = (payload.models ?? []).flatMap((model) =>
    (model.loaded_instances ?? []).map((instance) => ({ model, instance })),
  );
  if (loaded.length !== 1) {
    throw new Error(`QScore requires exactly one loaded model; found ${loaded.length}`);
  }

  const [{ model, instance }] = loaded;
  const modelKey = model.key ?? "";
  const instanceId = instance.id ?? "";
  if (modelKey !== requestedModel && instanceId !== requestedModel) {
    throw new Error(
      `Loaded model ${modelKey || instanceId || "<unknown>"} does not match requested model ${requestedModel}`,
    );
  }

  const result: { modelKey: string; instanceId: string; contextLength?: number } = {
    modelKey,
    instanceId,
  };
  if (instance.config?.context_length !== undefined) {
    result.contextLength = instance.config.context_length;
  }
  return result;
}

export async function fetchLoadedModels(): Promise<LoadedModelsPayload> {
  const response = await fetch("http://127.0.0.1:1234/api/v1/models");
  if (!response.ok) {
    throw new Error(`LM Studio model preflight failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<LoadedModelsPayload>;
}

async function main() {
  const modelIndex = process.argv.indexOf("--model");
  const requestedModel = modelIndex >= 0 ? process.argv[modelIndex + 1] : undefined;
  if (!requestedModel) {
    throw new Error("Usage: npm run qscore:preflight -- --model <model-key>");
  }
  const loaded = assertSingleLoadedModel(await fetchLoadedModels(), requestedModel);
  if (loaded.contextLength !== 32_768) {
    throw new Error(
      `QScore requires context length 32768; found ${loaded.contextLength ?? "unknown"}`,
    );
  }
  process.stdout.write(`${JSON.stringify(loaded)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
