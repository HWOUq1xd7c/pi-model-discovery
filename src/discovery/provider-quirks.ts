import type { ProviderConfigEntry } from "../config/types.js";

const DEFAULT_OPENAI_MODELS_ENDPOINT = "models";
const XIAOMI_TOKEN_PLAN_HOST_PATTERN = /^token-plan-[a-z0-9-]+\.xiaomimimo\.com$/i;
const XIAOMI_MODEL_DISCOVERY_PROVIDER_IDS = new Set(["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"]);

export function inferCloudflareModelsEndpoint(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    const match = parsed.pathname.match(/^(.*\/accounts\/[^/]+)\/ai\/v1\/?$/);
    if (!match || parsed.hostname !== "api.cloudflare.com") return undefined;
    return `${parsed.origin}${match[1]}/ai/models/search?per_page=100&task=Text%20Generation`;
  } catch {
    return undefined;
  }
}

export function inferXiaomiModelsEndpoint(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname !== "api.xiaomimimo.com" && !XIAOMI_TOKEN_PLAN_HOST_PATTERN.test(parsed.hostname)) return undefined;
    parsed.pathname = "/v1/models";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function resolveOpenAICompatibleModelsEndpoint(provider: ProviderConfigEntry): string {
  if (provider.discovery.endpointPath) return provider.discovery.endpointPath;
  if (provider.id === "cloudflare") return inferCloudflareModelsEndpoint(provider.baseUrl) ?? DEFAULT_OPENAI_MODELS_ENDPOINT;
  if (XIAOMI_MODEL_DISCOVERY_PROVIDER_IDS.has(provider.id)) return inferXiaomiModelsEndpoint(provider.baseUrl) ?? DEFAULT_OPENAI_MODELS_ENDPOINT;
  if (provider.id === "sub2api") return "v1/models";
  return DEFAULT_OPENAI_MODELS_ENDPOINT;
}
