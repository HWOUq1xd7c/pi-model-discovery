import type { ExtensionConfig, ProviderConfigEntry } from "../config/types.js";
import { registerDiscoveryAdapter, getDiscoveryAdapter, type DiscoveryAdapter } from "./adapter.js";
import { discoverAnthropicCompatible } from "./anthropic-compatible.js";
import { discoverLlamaCpp } from "./llama-cpp.js";
import { discoverLmStudio } from "./lm-studio.js";
import { discoverOllama } from "./ollama.js";
import { discoverOpenAICompat } from "./openai-compat.js";
import { discoverOpenAIResponses } from "./openai-responses.js";
import { discoverStaticModels } from "./static.js";
import type { RawDiscoveredModel, RawDiscoveryResult } from "./types.js";

const DISCOVERY_MAX_CONCURRENCY = 4;
const DISCOVERY_MAX_ATTEMPTS = 3;

const BUILTIN_ADAPTERS: readonly DiscoveryAdapter[] = [
  { type: "openai-compat", discover: discoverOpenAICompat },
  { type: "ollama", discover: discoverOllama },
  { type: "anthropic-compatible", discover: discoverAnthropicCompatible },
  { type: "openai-responses", discover: discoverOpenAIResponses },
  { type: "lm-studio", discover: discoverLmStudio },
  { type: "llama-cpp", discover: discoverLlamaCpp },
  { type: "static", discover: discoverStaticModels },
];

let builtinsRegistered = false;

function ensureBuiltinAdaptersRegistered(): void {
  if (builtinsRegistered) return;
  for (const adapter of BUILTIN_ADAPTERS) registerDiscoveryAdapter(adapter);
  builtinsRegistered = true;
}

function credentialRef(provider: ProviderConfigEntry): RawDiscoveryResult["provider"]["credentialRef"] {
  return provider.source === "auto-import" ? "agent-auth-json" : "extension-config";
}

function withProviderModelConfig(models: RawDiscoveredModel[], provider: ProviderConfigEntry): RawDiscoveredModel[] {
  return models.map((model) => ({
    ...model,
    providerModelConfig: {
      id: model.id,
      name: model.name ?? model.id,
      api: provider.api,
    },
  }));
}

function createDiscoveryResult(
  provider: ProviderConfigEntry,
  models: RawDiscoveredModel[],
  authoritative: boolean,
  warnings: string[],
): RawDiscoveryResult {
  const result = {
    contractVersion: 1,
    provider: {
      id: provider.id,
      api: provider.api,
      baseUrl: provider.baseUrl,
      source: provider.source,
      credentialRef: credentialRef(provider),
    },
    models: withProviderModelConfig(models, provider),
    authoritative,
    warnings,
    compatibility: {
      providerModelConfig: "compatible",
      modelsJson: "compatible",
      piMultiAuth: "compatible",
    },
  } satisfies Omit<RawDiscoveryResult, "sourceProvider">;

  Object.defineProperty(result, "sourceProvider", {
    value: provider,
    enumerable: false,
  });
  return result as RawDiscoveryResult;
}

async function discoverProvider(provider: ProviderConfigEntry): Promise<RawDiscoveredModel[]> {
  ensureBuiltinAdaptersRegistered();
  const adapter = getDiscoveryAdapter(provider.discovery.type);
  if (!adapter) {
    throw new Error(`Unsupported discovery adapter '${provider.discovery.type}'.`);
  }
  return adapter.discover(provider);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown discovery error";
}

function isTransientDiscoveryError(error: unknown): boolean {
  const message = errorMessage(error);
  const httpStatus = message.match(/HTTP (\d{3})/)?.[1];
  if (httpStatus) {
    const status = Number(httpStatus);
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  return /fetch failed|network|timeout|timed out|abort|aborted|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(message);
}

async function discoverProviderWithRetry(provider: ProviderConfigEntry): Promise<RawDiscoveredModel[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DISCOVERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await discoverProvider(provider);
    } catch (error) {
      lastError = error;
      if (attempt >= DISCOVERY_MAX_ATTEMPTS || !isTransientDiscoveryError(error)) break;
    }
  }
  throw lastError;
}

async function discoverProviderResult(provider: ProviderConfigEntry): Promise<RawDiscoveryResult> {
  try {
    const models = await discoverProviderWithRetry(provider);
    return createDiscoveryResult(provider, models, true, []);
  } catch (error) {
    return createDiscoveryResult(provider, [], false, [errorMessage(error)]);
  }
}

export async function discoverProviders(config: ExtensionConfig): Promise<RawDiscoveryResult[]> {
  const enabledProviders = config.providers.filter((provider) => provider.discovery.enabled);
  const results = new Array<RawDiscoveryResult | undefined>(enabledProviders.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < enabledProviders.length) {
      const index = nextIndex;
      nextIndex += 1;
      const provider = enabledProviders[index];
      if (!provider) continue;
      results[index] = await discoverProviderResult(provider);
    }
  }

  const workerCount = Math.min(DISCOVERY_MAX_CONCURRENCY, enabledProviders.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results.filter((result): result is RawDiscoveryResult => result !== undefined);
}
