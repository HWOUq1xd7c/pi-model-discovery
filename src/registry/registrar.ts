import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import type {
  CapabilityFlags,
  OutputModality,
  PiInputModality,
  ProviderConfigEntry,
  RegistrationImportMode,
  RegistrationOwnershipConfig,
  ThinkingLevelMap,
} from "../config/types.js";
import type { DiscoveredModel } from "../cache/types.js";
import { isTextCompletionModel } from "../shared/model-kind.js";

export interface RegistrationPlan {
  provider: ProviderConfigEntry;
  models: DiscoveredModel[];
}

export interface RegistrationOutcome {
  registered: boolean;
  skipped: boolean;
  owner: "pi-model-discovery" | RegistrationOwnershipConfig["manager"];
  reason?: string;
}

type ExtendedProviderModelConfig = ProviderModelConfig & {
  baseUrl?: string;
  thinkingLevelMap?: ThinkingLevelMap;
  isFree?: boolean;
  output?: OutputModality[];
  capabilities?: CapabilityFlags;
  importOwnership?: "pi-model-discovery" | "manual" | string;
};

export interface PiBuiltInModelConfig extends Record<string, unknown> {
  providerId?: string;
  id?: string;
  importOwnership?: string;
}

export interface RegistrationOptions {
  force?: boolean;
  ownership?: RegistrationOwnershipConfig;
  importMode?: RegistrationImportMode;
  existingModels?: ReadonlyArray<Partial<ExtendedProviderModelConfig> & Record<string, unknown>>;
  builtInProviderIds?: ReadonlySet<string>;
  builtInModels?: ReadonlyArray<PiBuiltInModelConfig>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function piCompatibleInput(input: DiscoveredModel["input"]): PiInputModality[] {
  const compatible = input.filter((entry): entry is PiInputModality => entry === "text" || entry === "image");
  return compatible.length > 0 ? compatible : ["text"];
}

const INACTIVE_ENDPOINT_STATUSES = new Set(["dead", "legacy", "deprecated", "retired", "inactive", "disabled", "unavailable"]);
const MODEL_DISCOVERY_OWNERSHIP = "pi-model-discovery";
const LEGACY_MODEL_DISCOVERY_OWNERSHIP = "model-discovery";

function isInactiveEndpointMarker(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return INACTIVE_ENDPOINT_STATUSES.has(normalized);
}

function isRegistrableEndpointModel(provider: ProviderConfigEntry, model: DiscoveredModel): boolean {
  return !isInactiveEndpointMarker(model.endpointMetadata?.status) && !isInactiveEndpointMarker(model.endpointMetadata?.type) && isTextCompletionModel(provider, model);
}

function toProviderModelConfig(model: DiscoveredModel): ExtendedProviderModelConfig {
  return {
    id: model.id,
    name: model.isFree && !model.name.toLowerCase().includes("free") ? `${model.name} (free)` : model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
    input: piCompatibleInput(model.input),
    output: model.output,
    capabilities: model.capabilities,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    samplingParams: model.samplingParams ? { ...model.samplingParams } : undefined,
    headers: model.headers,
    compat: model.compat,
    isFree: model.isFree,
    importOwnership: MODEL_DISCOVERY_OWNERSHIP,
  };
}

function boolOrOutcome(options: RegistrationOptions, outcome: RegistrationOutcome): boolean | RegistrationOutcome {
  return options.ownership ? outcome : outcome.registered;
}

function modelId(model: Partial<ExtendedProviderModelConfig> & Record<string, unknown>): string | undefined {
  return typeof model.id === "string" && model.id.length > 0 ? model.id : undefined;
}

function normalizeModelKey(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalModelKeys(modelIdValue: string, providerIds: ReadonlySet<string>): string[] {
  const normalizedId = normalizeModelKey(modelIdValue);
  const keys = new Set([normalizedId]);
  for (const providerId of providerIds) {
    const normalizedProviderId = normalizeModelKey(providerId);
    const providerPrefix = `${normalizedProviderId}/`;
    if (normalizedId.startsWith(providerPrefix)) {
      keys.add(normalizedId.slice(providerPrefix.length));
    } else if (!normalizedId.includes("/")) {
      keys.add(`${normalizedProviderId}/${normalizedId}`);
    }
  }
  return [...keys];
}

function builtInDuplicateKeys(options: RegistrationOptions): Set<string> {
  const duplicateKeys = new Set<string>();
  const configuredProviderIds = options.builtInProviderIds ?? new Set<string>();
  for (const model of options.builtInModels ?? []) {
    const id = modelId(model);
    if (!id) continue;
    const providerId = typeof model.providerId === "string" && model.providerId.length > 0 ? model.providerId : undefined;
    const piBuiltInOwned = model.importOwnership === "pi-built-in";
    if (configuredProviderIds.size > 0 && providerId && !configuredProviderIds.has(providerId) && !piBuiltInOwned) continue;
    if (configuredProviderIds.size > 0 && !providerId && !piBuiltInOwned) continue;
    const scopedProviderIds = new Set(configuredProviderIds);
    if (providerId) scopedProviderIds.add(providerId);
    for (const key of canonicalModelKeys(id, scopedProviderIds)) duplicateKeys.add(key);
  }
  return duplicateKeys;
}

function filterPiBuiltInDuplicates(discoveredModels: ExtendedProviderModelConfig[], options: RegistrationOptions): ExtendedProviderModelConfig[] {
  const duplicateKeys = builtInDuplicateKeys(options);
  if (duplicateKeys.size === 0) return discoveredModels;
  const scopedProviderIds = options.builtInProviderIds ?? new Set<string>();
  return discoveredModels.filter((model) => !canonicalModelKeys(model.id, scopedProviderIds).some((key) => duplicateKeys.has(key)));
}

function isModelDiscoveryOwned(model: Partial<ExtendedProviderModelConfig> & Record<string, unknown>): boolean {
  return model.importOwnership === MODEL_DISCOVERY_OWNERSHIP || model.importOwnership === LEGACY_MODEL_DISCOVERY_OWNERSHIP;
}

function mergeRegistrationModels(
  discoveredModels: ExtendedProviderModelConfig[],
  options: RegistrationOptions,
  inactiveModelIds: ReadonlySet<string> = new Set(),
): Array<ExtendedProviderModelConfig | (Partial<ExtendedProviderModelConfig> & Record<string, unknown>)> {
  const importMode = options.importMode ?? "replace";
  const existingModels = options.existingModels ?? [];
  if (importMode === "replace" || existingModels.length === 0) return discoveredModels;

  const discoveredById = new Map<string, ExtendedProviderModelConfig>();
  for (const model of discoveredModels) discoveredById.set(model.id, model);

  const merged: Array<ExtendedProviderModelConfig | (Partial<ExtendedProviderModelConfig> & Record<string, unknown>)> = [];
  const emittedIds = new Set<string>();

  for (const existingModel of existingModels) {
    const id = modelId(existingModel);
    if (!id) continue;
    const discoveredModel = discoveredById.get(id);
    const manualOrOverride = !isModelDiscoveryOwned(existingModel);
    if (!manualOrOverride && inactiveModelIds.has(id)) continue;

    if (importMode === "sync" && !manualOrOverride && !discoveredModel) continue;

    if (manualOrOverride) {
      merged.push(existingModel);
    } else if (discoveredModel) {
      merged.push(discoveredModel);
    } else {
      merged.push(existingModel);
    }
    emittedIds.add(id);
  }

  for (const model of discoveredModels) {
    if (emittedIds.has(model.id)) continue;
    merged.push(model);
  }

  return merged;
}

export class ModelRegistrar {
  private readonly lastSignatures = new Map<string, string>();
  private readonly registeredProviderIds = new Set<string>();

  constructor(private readonly pi: ExtensionAPI) {}

  unregisterMissing(activeProviderIds: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const providerId of this.registeredProviderIds) {
      if (activeProviderIds.has(providerId)) continue;
      this.pi.unregisterProvider(providerId);
      this.registeredProviderIds.delete(providerId);
      this.lastSignatures.delete(providerId);
      removed.push(providerId);
    }
    return removed;
  }

  register(plan: RegistrationPlan, options?: RegistrationOptions & { ownership?: undefined }): boolean;
  register(plan: RegistrationPlan, options: RegistrationOptions & { ownership: RegistrationOwnershipConfig }): RegistrationOutcome;
  register(plan: RegistrationPlan, options: RegistrationOptions): boolean | RegistrationOutcome;
  register(plan: RegistrationPlan, options: RegistrationOptions = {}): boolean | RegistrationOutcome {
    const ownership = options.ownership;
    const managedByCredentialOwner = ownership?.managedProviderIds.has(plan.provider.id) === true;
    if (ownership?.onConflict === "skip" && managedByCredentialOwner) {
      this.lastSignatures.delete(plan.provider.id);
      this.registeredProviderIds.delete(plan.provider.id);
      return boolOrOutcome(options, {
        registered: false,
        skipped: true,
        owner: ownership.manager,
        reason: `Provider '${plan.provider.id}' is managed by ${ownership.manager}; pi-model-discovery registration skipped by explicit conflict policy.`,
      });
    }

    const activeModels = plan.models.filter((model) => isRegistrableEndpointModel(plan.provider, model));
    const inactiveModelIds = new Set(plan.models.filter((model) => !isRegistrableEndpointModel(plan.provider, model)).map((model) => model.id));
    const discoveredModels = filterPiBuiltInDuplicates(activeModels.map(toProviderModelConfig), options);
    const models = mergeRegistrationModels(discoveredModels, managedByCredentialOwner ? { ...options, importMode: options.importMode ?? "merge" } : options, inactiveModelIds);
    const providerConfig: ProviderConfig = {
      baseUrl: plan.provider.baseUrl,
      apiKey: plan.provider.apiKey,
      api: plan.provider.api,
      authHeader: plan.provider.authHeader,
      headers: plan.provider.headers,
      models: models as ProviderModelConfig[],
    };
    const signature = stableStringify(providerConfig);
    if (!options.force && this.lastSignatures.get(plan.provider.id) === signature) {
      return boolOrOutcome(options, {
        registered: false,
        skipped: false,
        owner: managedByCredentialOwner && ownership ? ownership.manager : "pi-model-discovery",
        reason: "Registration unchanged from the previous pi-model-discovery signature.",
      });
    }

    // Deliberately use pi.registerProvider() only. ModelRegistry.refresh() would clear dynamic models.
    this.pi.registerProvider(plan.provider.id, providerConfig);
    this.registeredProviderIds.add(plan.provider.id);
    this.lastSignatures.set(plan.provider.id, signature);
    return boolOrOutcome(options, { registered: true, skipped: false, owner: managedByCredentialOwner && ownership ? ownership.manager : "pi-model-discovery" });
  }
}
