import type { DiscoveryDefaults, DiscoveryType, ProviderConfigEntry } from "../config/types.js";

export type BuiltInCredentialKind = "api_key" | "oauth";

export interface BuiltInProviderProfile {
  id: string;
  baseUrl?: string;
  api: ProviderConfigEntry["api"];
  discoveryType: DiscoveryType;
  endpointPath?: string;
  headers?: Record<string, string>;
  defaults?: DiscoveryDefaults;
  discoveryAllowModels?: string[];
  discoveryBlockModels?: string[];
  staticModelIds?: readonly string[];
  credentialEnvVars?: readonly string[];
  allDiscoveredModelsFree?: boolean;
  supportsPublicDiscovery?: boolean;
  supportsApiKeyDiscovery: boolean;
  supportsOAuthDiscovery: boolean;
}

/**
 * Build a Xiaomi token-plan regional profile. The cn/ams/sgp endpoints share
 * every field except the region segment, so they are generated from a single
 * helper instead of copy-pasted literal blocks.
 */
function xiaomiTokenPlanProfile(region: string): BuiltInProviderProfile {
  return {
    id: `xiaomi-token-plan-${region}`,
    baseUrl: `https://token-plan-${region}.xiaomimimo.com/anthropic`,
    api: "anthropic-messages" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    discoveryBlockModels: ["-tts"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  };
}

const BUILT_IN_PROVIDER_PROFILES: Readonly<Record<string, BuiltInProviderProfile>> = {
  nvidia: {
    id: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
    discoveryBlockModels: ["embed", "rerank", "tts"],
    allDiscoveredModelsFree: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  cloudflare: {
    id: "cloudflare",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["CLOUDFLARE_API_KEY"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: true,
  },
  cerebras: {
    id: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["CEREBRAS_API_KEY"],
    allDiscoveredModelsFree: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  groq: {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["GROQ_API_KEY"],
    discoveryBlockModels: ["whisper", "tts", "embed", "guard"],
    allDiscoveredModelsFree: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  mistral: {
    id: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["MISTRAL_API_KEY"],
    discoveryBlockModels: ["embed", "moderation"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  deepseek: {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["DEEPSEEK_API_KEY"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  openrouter: {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["OPENROUTER_API_KEY"],
    discoveryAllowModels: [":free"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  sambanova: {
    id: "sambanova",
    baseUrl: "https://api.sambanova.ai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["SAMBANOVA_API_KEY"],
    allDiscoveredModelsFree: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  together: {
    id: "together",
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["TOGETHER_API_KEY", "TOGETHER_AI_API_KEY"],
    discoveryBlockModels: ["embed", "moderation", "rerank", "whisper", "tts", "image"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  huggingface: {
    id: "huggingface",
    baseUrl: "https://router.huggingface.co/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["HF_TOKEN", "HUGGINGFACE_API_KEY"],
    discoveryBlockModels: ["embed", "rerank", "tts", "whisper", "image"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  llm7: {
    id: "llm7",
    baseUrl: "https://api.llm7.io/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["LLM7_API_KEY"],
    discoveryBlockModels: ["embed", "tts", "audio", "whisper", "image"],
    allDiscoveredModelsFree: true,
    supportsPublicDiscovery: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  pollinations: {
    id: "pollinations",
    baseUrl: "https://gen.pollinations.ai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["POLLINATIONS_API_KEY"],
    allDiscoveredModelsFree: true,
    supportsPublicDiscovery: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  kluster: {
    id: "kluster",
    baseUrl: "https://api.kluster.ai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["KLUSTER_API_KEY"],
    discoveryBlockModels: ["embed", "bge", "rerank", "tts", "whisper"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  novita: {
    id: "novita",
    baseUrl: "https://api.novita.ai/openai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["NOVITA_API_KEY"],
    discoveryBlockModels: ["embed", "rerank", "tts", "whisper", "image"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  deepinfra: {
    id: "deepinfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["DEEPINFRA_API_KEY"],
    discoveryBlockModels: ["embed", "rerank", "tts", "whisper", "image"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  zai: {
    id: "zai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
    discoveryAllowModels: ["flash"],
    discoveryBlockModels: ["embed", "rerank", "tts", "stt", "audio", "image"],
    staticModelIds: ["glm-4-flash", "glm-4-flash-250414", "glm-4v-flash", "glm-z1-flash", "glm-4.5-flash"],
    allDiscoveredModelsFree: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  "github-models": {
    id: "github-models",
    baseUrl: "https://models.inference.ai.azure.com",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["GH_MODELS_TOKEN", "GITHUB_MODELS_TOKEN", "GITHUB_TOKEN"],
    discoveryBlockModels: ["embed", "tts", "whisper", "dall-e", "image", "moderation"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  qwen: {
    id: "qwen",
    baseUrl: "https://portal.qwen.ai/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["QWEN_API_KEY", "DASHSCOPE_API_KEY"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: true,
  },
  xiaomi: {
    id: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com/anthropic",
    api: "anthropic-messages" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["XIAOMI_API_KEY"],
    discoveryBlockModels: ["-tts"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  "xiaomi-token-plan-cn": xiaomiTokenPlanProfile("cn"),
  "xiaomi-token-plan-ams": xiaomiTokenPlanProfile("ams"),
  "xiaomi-token-plan-sgp": xiaomiTokenPlanProfile("sgp"),
  cline: {
    id: "cline",
    baseUrl: "https://api.cline.bot/api/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["CLINE_API_KEY"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: true,
  },
  kilo: {
    id: "kilo",
    baseUrl: "https://api.kilo.ai/api/gateway",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["KILO_API_KEY"],
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: true,
  },
  sub2api: {
    id: "sub2api",
    baseUrl: "http://localhost:8080",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["SUB2API_KEY"],
    discoveryBlockModels: ["embedding", "image"],
    supportsPublicDiscovery: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
  cpa: {
    id: "cpa",
    baseUrl: "http://127.0.0.1:8317/v1",
    api: "openai-completions" as ProviderConfigEntry["api"],
    discoveryType: "openai-compat",
    credentialEnvVars: ["CPA_API_KEY"],
    discoveryBlockModels: ["embedding", "image"],
    supportsPublicDiscovery: true,
    supportsApiKeyDiscovery: true,
    supportsOAuthDiscovery: false,
  },
};

export function getBuiltInProviderProfile(providerId: string): BuiltInProviderProfile | undefined {
  return BUILT_IN_PROVIDER_PROFILES[providerId];
}

export function builtInProfileAllowsCredential(profile: BuiltInProviderProfile | undefined, credentialKind: BuiltInCredentialKind): boolean {
  if (!profile) return false;
  if (credentialKind === "api_key") return profile.supportsApiKeyDiscovery;
  return profile.supportsOAuthDiscovery;
}

export function listBuiltInProviderProfileIds(): string[] {
  return Object.keys(BUILT_IN_PROVIDER_PROFILES);
}
