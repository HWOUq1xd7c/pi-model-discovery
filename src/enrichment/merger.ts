import type { CapabilityProvenance, DiscoveredModel } from "../cache/types.js";
import type { DiscoveryDefaults, ModelDefaults, ProviderConfigEntry } from "../config/types.js";
import { getBuiltInProviderProfile } from "../discovery/builtin-profiles.js";
import type { RawDiscoveredModel } from "../discovery/types.js";
import { catalogTrailingVariantLookupIds, normalizeCatalogIdentity, stripCatalogLookupPrefix } from "../shared/catalog-identity.js";
import { GLOBAL_DEFAULTS, mergeCost } from "./defaults.js";
import { classifyFreeModels } from "./free-classifier.js";
import type { ModelsDevLookup, ModelsDevMetadata } from "./models-dev.js";
import { recordCapabilityProvenance, valuesEqual } from "./provenance.js";

function displayNameFromId(id: string, providerId: string): string {
  const lastSegment = id.split("/").at(-1) ?? id;
  const title = lastSegment
    .replace(/[._-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return `${title || id} (${providerId})`;
}

function withProvenance<T extends DiscoveredModel>(model: T, field: keyof CapabilityProvenance, nextValue: unknown, source: string, currentValue: unknown): T {
  if (nextValue === undefined) return model;
  if (valuesEqual(currentValue, nextValue)) {
    return model;
  }
  return {
    ...model,
    capabilityProvenance: recordCapabilityProvenance(model.capabilityProvenance, field, source),
  };
}

export function applyModelDefaults(model: DiscoveredModel, defaults: DiscoveryDefaults | ModelDefaults | ModelsDevMetadata | undefined, source: string): DiscoveredModel {
  if (!defaults) return model;
  let next = { ...model, sources: { ...model.sources, [source]: true } };

  const name = "name" in defaults && defaults.name ? defaults.name : undefined;
  next = withProvenance(next, "name", name, source, next.name);
  if (name !== undefined) next.name = name;

  next = withProvenance(next, "baseUrl", defaults.baseUrl, source, next.baseUrl);
  if (defaults.baseUrl !== undefined) next.baseUrl = defaults.baseUrl;

  next = withProvenance(next, "reasoning", defaults.reasoning, source, next.reasoning);
  if (defaults.reasoning !== undefined) next.reasoning = defaults.reasoning;

  const thinkingLevelMap = defaults.thinkingLevelMap ? { ...defaults.thinkingLevelMap } : undefined;
  next = withProvenance(next, "thinkingLevelMap", thinkingLevelMap, source, next.thinkingLevelMap);
  if (thinkingLevelMap !== undefined) next.thinkingLevelMap = thinkingLevelMap;

  next = withProvenance(next, "input", defaults.input, source, next.input);
  if (defaults.input !== undefined) next.input = defaults.input;

  next = withProvenance(next, "output", defaults.output, source, next.output);
  if (defaults.output !== undefined) next.output = defaults.output;

  next = withProvenance(next, "capabilities", defaults.capabilities, source, next.capabilities);
  if (defaults.capabilities !== undefined) next.capabilities = defaults.capabilities;

  const cost = defaults.cost ? mergeCost(next.cost, defaults.cost) : undefined;
  next = withProvenance(next, "cost", cost, source, next.cost);
  if (cost !== undefined) next.cost = cost;

  next = withProvenance(next, "contextWindow", defaults.contextWindow, source, next.contextWindow);
  if (defaults.contextWindow !== undefined) next.contextWindow = defaults.contextWindow;

  next = withProvenance(next, "maxTokens", defaults.maxTokens, source, next.maxTokens);
  if (defaults.maxTokens !== undefined) next.maxTokens = defaults.maxTokens;

  next = withProvenance(next, "compat", defaults.compat, source, next.compat);
  if (defaults.compat !== undefined) next.compat = defaults.compat;

  return next;
}

function applyEndpointField<K extends keyof DiscoveredModel>(
  model: DiscoveredModel,
  field: K,
  value: DiscoveredModel[K] | undefined,
  source: string,
): DiscoveredModel {
  if (value === undefined) return model;
  const next = withProvenance(model, field as keyof CapabilityProvenance, value, source, model[field]);
  return { ...next, [field]: value, sources: { ...next.sources, [source]: true } };
}

const BLAZEAPI_PROVIDER_ID = "blazeapi";
const OLLAMA_PROVIDER_ID = "ollama";
const PROVIDER_QUIRK_SOURCE = "providerQuirk";
const OLLAMA_CLOUD_FREE_SOURCE = "ollamaCloudHardcoded";
const REASONING_COMPAT_SOURCE = "reasoningCompatDefaults";
const OPENAI_REASONING_MODEL_PATTERN = /(^|\/)gpt-[5-9](?:[.\-]\d+)?(?:[.\-][\w.-]+)?(?:$|[:/])/i;
const OPENAI_REASONING_EFFORT_MODEL_PATTERN = /(^|\/)(?:gpt-[5-9]|o[1-9]|codex)(?:[.\-]\d+)?(?:[.\-][\w.-]+)?(?:$|[:/])/i;
const OPENAI_REASONING_DISABLED_EFFORT = "none";
const OPENAI_REASONING_UNSUPPORTED_MINIMAL = null;
const OPENAI_REASONING_XHIGH_EFFORT = "xhigh";

/**
 * Hard-coded free/premium classification for Ollama Cloud models based on
 * live curl-test results (May 2026). Free models accept the basic ollama
 * API key; premium models require a subscription/tier upgrade.
 */
const OLLAMA_CLOUD_FREE_MODELS = new Set([
  "gpt-oss:120b",
  "gemma3:4b",
  "ministral-3:8b",
  "devstral-2:123b",
  "gemma3:27b",
  "glm-4.7",
  "gpt-oss:20b",
  "ministral-3:14b",
  "nemotron-3-super",
  "qwen3-coder:480b",
  "nemotron-3-nano:30b",
  "ministral-3:3b",
  "devstral-small-2:24b",
  "rnj-1:8b",
  "qwen3-coder-next",
  "qwen3-vl:235b-instruct",
  "minimax-m2.1",
  "gemma4:31b",
  "qwen3-vl:235b",
  "minimax-m2",
  "cogito-2.1:671b",
  "minimax-m2.5",
  "qwen3-next:80b",
  "gemma3:12b",
  "glm-4.6",
]);

const OLLAMA_CLOUD_PREMIUM_MODELS = new Set([
  "glm-5",
  "kimi-k2.6",
  "qwen3.5:397b",
  "kimi-k2-thinking",
  "deepseek-v3.1:671b",
  "mistral-large-3:675b",
  "gemini-3-flash-preview",
  "glm-5.1",
  "deepseek-v4-flash",
  "minimax-m2.7",
  "kimi-k2:1t",
  "deepseek-v3.2",
  "kimi-k2.5",
  "deepseek-v4-pro",
]);

/**
 * Hard-coded truly-free models from huashang.dpdns.org (model_price=0 AND model_ratio=0).
 * Source: HAR archive 2026-05-30 pricing API.
 * These models have zero token cost and zero per-request cost.
 */
const HUASHANG_FREE_MODELS = new Set([
  // Meta
  "meta-llama/llama-3.2-3b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  // MiniMax
  "minimax/minimax-m2.5:free",
  "minimaxai/minimax-m2.7",
  // Mistral
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  // Moonshot
  "kimi-k2.6",
  "kimi-k2.6-agent",
  "kimi-k2.6-agent-swarm",
  "kimi-k2.6-search",
  "kimi-k2.6-thinking",
  "kimi-k2.6-thinking-search",
  "moonshotai/kimi-k2.6",
  // OpenAI
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  // Unknown/Other
  "aisingapore/sea-lion-7b-instruct",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "liquid/lfm-2.5-1.2b-instruct:free",
  "liquid/lfm-2.5-1.2b-thinking:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "openrouter/free",
  "poolside/laguna-m.1:free",
  "poolside/laguna-xs.2:free",
  // 智谱
  "z-ai/glm-4.5-air:free",
  // 阿里巴巴
  "qwen/qwen3-coder:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "qwen3.7-max",
]);

const HUASHANG_FREE_SOURCE = "huashangHardcoded";

function isOllamaCloudProvider(provider: ProviderConfigEntry): boolean {
  return provider.id === OLLAMA_PROVIDER_ID;
}

function isHuashangProvider(provider: ProviderConfigEntry): boolean {
  return provider.id.startsWith("huashang");
}

export function applyOllamaCloudFreePremium(model: DiscoveredModel): DiscoveredModel {
  if (!OLLAMA_CLOUD_FREE_MODELS.has(model.id) && !OLLAMA_CLOUD_PREMIUM_MODELS.has(model.id)) {
    return model;
  }
  const isFree = OLLAMA_CLOUD_FREE_MODELS.has(model.id);
  const next = withProvenance(model, "isFree", isFree, OLLAMA_CLOUD_FREE_SOURCE, model.isFree);
  return { ...next, isFree, sources: { ...next.sources, [OLLAMA_CLOUD_FREE_SOURCE]: true } };
}

export function applyHuashangFreeModels(model: DiscoveredModel): DiscoveredModel {
  if (!HUASHANG_FREE_MODELS.has(model.id)) return model;
  const next = withProvenance(model, "isFree", true, HUASHANG_FREE_SOURCE, model.isFree);
  return { ...next, isFree: true, sources: { ...next.sources, [HUASHANG_FREE_SOURCE]: true } };
}


function isBlazeApiClaudeRouteIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^route:claude-|^claude-/i.test(value.trim());
}

function isBlazeApiClaudeRoute(provider: ProviderConfigEntry, model: DiscoveredModel): boolean {
  if (provider.id !== BLAZEAPI_PROVIDER_ID) return false;
  return [
    model.endpointMetadata?.routingGroup,
    model.endpointMetadata?.providerId,
    model.id,
  ].some(isBlazeApiClaudeRouteIdentifier);
}

function collectModelIdentities(model: DiscoveredModel): string[] {
  return [model.id, model.name, model.endpointMetadata?.providerId, model.endpointMetadata?.routingGroup].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function isOpenAICompatibleReasoningModel(provider: ProviderConfigEntry, model: DiscoveredModel): boolean {
  if (provider.api !== "openai-completions") return false;
  if (model.reasoning !== true) return false;
  return collectModelIdentities(model).some((identity) => OPENAI_REASONING_MODEL_PATTERN.test(identity));
}

function supportsOpenAIReasoningEffort(model: DiscoveredModel): boolean {
  return collectModelIdentities(model).some((identity) => OPENAI_REASONING_EFFORT_MODEL_PATTERN.test(identity));
}

function applyOpenAIReasoningCompatDefaults(model: DiscoveredModel): DiscoveredModel {
  const nextCompat = supportsOpenAIReasoningEffort(model)
    ? {
        ...model.compat,
        supportsReasoningEffort: true,
      }
    : model.compat;
  const nextThinkingLevelMap = {
    ...model.thinkingLevelMap,
    off: model.thinkingLevelMap?.off ?? OPENAI_REASONING_DISABLED_EFFORT,
    minimal: model.thinkingLevelMap?.minimal ?? OPENAI_REASONING_UNSUPPORTED_MINIMAL,
    xhigh: model.thinkingLevelMap?.xhigh ?? OPENAI_REASONING_XHIGH_EFFORT,
  };

  let next = model;
  next = withProvenance(next, "compat", nextCompat, REASONING_COMPAT_SOURCE, next.compat);
  next = withProvenance(next, "thinkingLevelMap", nextThinkingLevelMap, REASONING_COMPAT_SOURCE, next.thinkingLevelMap);
  return {
    ...next,
    compat: nextCompat,
    thinkingLevelMap: nextThinkingLevelMap,
    sources: { ...next.sources, [REASONING_COMPAT_SOURCE]: true },
  };
}

function applySub2apiQuirks(provider: ProviderConfigEntry, model: DiscoveredModel): DiscoveredModel {
  const isClaude = /claude/i.test(model.id);
  const rawBase = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const protocol = isClaude ? "anthropic-messages" : "openai-completions";
  const baseUrl = isClaude ? rawBase : `${rawBase}/v1`;

  let nextModel: DiscoveredModel = {
    ...model,
    api: model.api ?? (protocol as DiscoveredModel["api"]),
    baseUrl: model.baseUrl ?? baseUrl,
  };

  if (isClaude) {
    const isReasoning = !/claude-3-(?!7-)/i.test(model.id);
    let contextWindow = model.contextWindow;
    let maxTokens = model.maxTokens;
    let thinkingLevelMap = model.thinkingLevelMap;

    if (!contextWindow || contextWindow === 128000) {
      if (/opus-4-[678]|opus-5|fable-5|sonnet-4-6|sonnet-5/i.test(model.id)) {
        contextWindow = 1000000;
        maxTokens = /opus-4-[67]/i.test(model.id) ? 128000 : 64000;
      } else if (/claude-3-(5-)?/i.test(model.id)) {
        contextWindow = 200000;
        maxTokens = 8192;
      } else {
        contextWindow = 200000;
        maxTokens = 64000;
      }
    }

    if (/opus-4-6/i.test(model.id)) {
      thinkingLevelMap = { ...(thinkingLevelMap ?? {}), xhigh: "max" };
    } else if (/opus-4-7/i.test(model.id)) {
      thinkingLevelMap = { ...(thinkingLevelMap ?? {}), xhigh: "xhigh" };
    }

    nextModel = {
      ...nextModel,
      reasoning: isReasoning,
      contextWindow,
      maxTokens,
      thinkingLevelMap,
    };
  } else {
    const isReasoning = Boolean(model.reasoning) || /gpt-5|codex|^o[1-9]|reason|think/i.test(model.id);
    nextModel = {
      ...nextModel,
      reasoning: isReasoning,
      contextWindow: model.contextWindow && model.contextWindow !== 128000 ? model.contextWindow : 400000,
      maxTokens: model.maxTokens && model.maxTokens !== 16384 ? model.maxTokens : 128000,
      thinkingLevelMap: isReasoning ? { ...(model.thinkingLevelMap ?? {}), minimal: null } : model.thinkingLevelMap,
    };
  }

  return nextModel;
}

function applyCpaQuirks(_provider: ProviderConfigEntry, model: DiscoveredModel): DiscoveredModel {
  const isKimi = /kimi|moonshot/i.test(model.id);
  let nextModel = model;
  if (isKimi) {
    nextModel = {
      ...nextModel,
      compat: { ...(nextModel.compat ?? {}), supportsDeveloperRole: false },
    };
  }
  return nextModel;
}

export function applyProviderModelQuirks(provider: ProviderConfigEntry, model: DiscoveredModel): DiscoveredModel {
  let nextModel = model;
  if (provider.id === "sub2api") {
    nextModel = applySub2apiQuirks(provider, nextModel);
  } else if (provider.id === "cpa") {
    nextModel = applyCpaQuirks(provider, nextModel);
  }

  if (isOpenAICompatibleReasoningModel(provider, nextModel)) {
    nextModel = applyOpenAIReasoningCompatDefaults(nextModel);
  }

  if (!isBlazeApiClaudeRoute(provider, nextModel)) return nextModel;

  const nextCompat = {
    ...nextModel.compat,
    supportsReasoningEffort: false,
  };
  const next = withProvenance(nextModel, "compat", nextCompat, PROVIDER_QUIRK_SOURCE, nextModel.compat);
  return {
    ...next,
    compat: nextCompat,
    sources: { ...next.sources, [PROVIDER_QUIRK_SOURCE]: true },
  };
}

export interface CatalogIdentityMatch {
  key: string;
  metadata: ModelsDevMetadata;
}

export interface CatalogIdentityIndex {
  normalizedKeys: Map<string, CatalogIdentityMatch[]>;
  normalizedEntries: Array<{ normalized: string; matches: CatalogIdentityMatch[] }>;
}

export function buildCatalogIdentityIndex(lookup: ModelsDevLookup): CatalogIdentityIndex {
  const normalizedKeys = new Map<string, CatalogIdentityMatch[]>();
  for (const [key, metadata] of lookup) {
    const normalized = normalizeCatalogIdentity(key);
    if (!normalized) continue;
    const matches = normalizedKeys.get(normalized) ?? [];
    matches.push({ key, metadata });
    normalizedKeys.set(normalized, matches);
  }
  const normalizedEntries = [...normalizedKeys.entries()].map(([normalized, matches]) => ({ normalized, matches }));
  return { normalizedKeys, normalizedEntries };
}

function dedupeCatalogMatches(matches: CatalogIdentityMatch[]): CatalogIdentityMatch[] {
  const byIdentity = new Map<string, CatalogIdentityMatch>();
  for (const match of matches) {
    const identity = match.metadata.canonicalId ?? match.metadata.id;
    if (!byIdentity.has(identity)) byIdentity.set(identity, match);
  }
  return [...byIdentity.values()];
}

function isSafeSuffixCatalogCandidate(normalized: string): boolean {
  const segments = normalized.split("-").filter(Boolean);
  return segments.length >= 3 && /\d/.test(normalized);
}

function resolveSuffixCatalogMatch(normalized: string, index: CatalogIdentityIndex): ModelsDevMetadata | undefined {
  if (!isSafeSuffixCatalogCandidate(normalized)) return undefined;
  const suffix = `-${normalized}`;
  const suffixMatches = index.normalizedEntries.flatMap((entry) => (entry.normalized.endsWith(suffix) ? entry.matches : []));
  const uniqueMatches = dedupeCatalogMatches(suffixMatches);
  return uniqueMatches.length === 1 ? uniqueMatches[0]?.metadata : undefined;
}

function resolveNormalizedCatalogMatch(candidate: string, index: CatalogIdentityIndex): ModelsDevMetadata | undefined {
  const normalized = normalizeCatalogIdentity(candidate);
  if (!normalized) return undefined;
  const matches = index.normalizedKeys.get(normalized);
  if (matches) {
    const uniqueMatches = dedupeCatalogMatches(matches);
    if (uniqueMatches.length === 1) return uniqueMatches[0]?.metadata;

    const lowerCandidate = candidate.trim().toLowerCase();
    const exactKeyMatches = uniqueMatches.filter((match) => match.key.trim().toLowerCase() === lowerCandidate);
    return exactKeyMatches.length === 1 ? exactKeyMatches[0]?.metadata : undefined;
  }
  return resolveSuffixCatalogMatch(normalized, index);
}

function addCatalogLookupCandidate(candidates: string[], value: string | undefined): void {
  const candidate = value ? stripCatalogLookupPrefix(value) : "";
  if (candidate) candidates.push(candidate);
}

function addVariantStrippedCatalogCandidates(candidates: string[], value: string | undefined): void {
  if (!value) return;
  candidates.push(...catalogTrailingVariantLookupIds(value));
}

function isPreferredOriginLookupId(value: string): boolean {
  return /^anthropic\//i.test(stripCatalogLookupPrefix(value));
}

export function catalogLookupCandidates(rawModel: RawDiscoveredModel): string[] {
  const candidates: string[] = [];
  const catalogLookupIds = rawModel.catalogLookupIds ?? [];
  for (const lookupId of catalogLookupIds) {
    if (isPreferredOriginLookupId(lookupId)) addCatalogLookupCandidate(candidates, lookupId);
  }
  addCatalogLookupCandidate(candidates, rawModel.id);
  for (const lookupId of catalogLookupIds) {
    if (!isPreferredOriginLookupId(lookupId)) addCatalogLookupCandidate(candidates, lookupId);
  }
  addCatalogLookupCandidate(candidates, rawModel.endpointMetadata?.providerId);
  addCatalogLookupCandidate(candidates, rawModel.endpointMetadata?.routingGroup);

  for (const candidate of [...candidates]) addVariantStrippedCatalogCandidates(candidates, candidate);
  return Array.from(new Set(candidates));
}

function applyRawEndpointMetadata(model: DiscoveredModel, rawModel: RawDiscoveredModel): DiscoveredModel {
  let next = model;
  next = applyEndpointField(next, "description", rawModel.description, "endpointMetadata");
  next = applyEndpointField(next, "created", rawModel.created, "endpointMetadata");
  next = applyEndpointField(next, "ownedBy", rawModel.ownedBy, "endpointMetadata");
  next = applyEndpointField(next, "tags", rawModel.tags ? [...rawModel.tags] : undefined, "endpointMetadata");
  next = applyEndpointField(next, "endpointPricing", rawModel.endpointPricing ? { ...rawModel.endpointPricing } : undefined, "endpointPricing");
  next = applyEndpointField(next, "endpointMetadata", rawModel.endpointMetadata ? { ...rawModel.endpointMetadata } : undefined, "endpointMetadata");
  return next;
}

function modelsDevDefaults(
  provider: ProviderConfigEntry,
  rawModel: RawDiscoveredModel,
  modelsDevLookup: ModelsDevLookup,
  catalogIdentityIndex: CatalogIdentityIndex,
): ModelsDevMetadata | undefined {
  const seen = new Set<string>();
  for (const lookupId of catalogLookupCandidates(rawModel)) {
    for (const key of [`${provider.id}:${lookupId}`, lookupId]) {
      if (seen.has(key)) continue;
      seen.add(key);
      const metadata = modelsDevLookup.get(key) ?? resolveNormalizedCatalogMatch(key, catalogIdentityIndex);
      if (metadata) return metadata;
    }
  }
  return undefined;
}


export function resolveModelsDevDefaults(
  provider: ProviderConfigEntry,
  rawModel: RawDiscoveredModel,
  modelsDevLookup: ModelsDevLookup,
  catalogIdentityIndex: CatalogIdentityIndex = buildCatalogIdentityIndex(modelsDevLookup),
): ModelsDevMetadata | undefined {
  return modelsDevDefaults(provider, rawModel, modelsDevLookup, catalogIdentityIndex);
}

export function enrichProviderModels(
  provider: ProviderConfigEntry,
  rawModels: RawDiscoveredModel[],
  modelsDevLookup: ModelsDevLookup,
): DiscoveredModel[] {
  const catalogIdentityIndex = buildCatalogIdentityIndex(modelsDevLookup);
  const enriched = rawModels.map((rawModel) => {
    let model: DiscoveredModel = {
      id: rawModel.id,
      name: rawModel.name ?? displayNameFromId(rawModel.id, provider.id),
      reasoning: GLOBAL_DEFAULTS.reasoning,
      input: GLOBAL_DEFAULTS.input,
      cost: GLOBAL_DEFAULTS.cost,
      contextWindow: GLOBAL_DEFAULTS.contextWindow,
      maxTokens: GLOBAL_DEFAULTS.maxTokens,
      compat: GLOBAL_DEFAULTS.compat,
      sources: { dynamic: true, globalDefaults: true },
      capabilityProvenance: { id: "dynamic" },
    };

    const catalogDefaults = modelsDevDefaults(provider, rawModel, modelsDevLookup, catalogIdentityIndex);
    model = applyModelDefaults(model, catalogDefaults, "modelsDev");
    if (provider.source === "auto-import") {
      model = applyModelDefaults(model, provider.modelDefaults[rawModel.id], "modelsJsonDefaults");
    }
    model = applyModelDefaults(model, rawModel.defaults, "endpointDetails");
    model = applyRawEndpointMetadata(model, rawModel);
    if (rawModel.endpointPricing?.isFree !== undefined) {
      model = applyEndpointField(model, "isFree", rawModel.endpointPricing.isFree, "endpointPricing");
    }
    if (provider.source !== "auto-import") {
      model = applyModelDefaults(model, provider.modelDefaults[rawModel.id], "modelsJsonDefaults");
    }
    model = applyModelDefaults(model, provider.defaults, "providerDefaults");
    model = applyProviderModelQuirks(provider, model);
    if (isOllamaCloudProvider(provider)) {
      model = applyOllamaCloudFreePremium(model);
    }
    if (isHuashangProvider(provider)) {
      model = applyHuashangFreeModels(model);
    }
    model = { ...model, id: rawModel.id, sources: { ...model.sources, dynamic: true } };
    return model;
  });
  return classifyFreeModels(enriched, {
    providerId: provider.id,
    wholeProviderFree: getBuiltInProviderProfile(provider.id)?.allDiscoveredModelsFree,
  });
}
