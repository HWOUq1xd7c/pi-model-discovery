import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { CacheManager, isProviderCacheEntryFresh, type CacheProviderWrite } from "./cache/manager.js";
import { loadConfigAsync } from "./config/loader.js";
import type { ExtensionConfig, ProviderConfigEntry } from "./config/types.js";
import { discoverProviders } from "./discovery/engine.js";
import { applyModelFilters } from "./discovery/helpers.js";
import type { RawDiscoveredModel } from "./discovery/types.js";
import type { DiscoveredModel } from "./cache/types.js";
import { applyModelDefaults, applyOllamaCloudFreePremium, applyProviderModelQuirks, catalogLookupCandidates, enrichProviderModels } from "./enrichment/merger.js";
import { valuesEqual } from "./enrichment/provenance.js";
import { fetchModelsDevLookup, mergeModelsDevLookups, type ModelsDevLookup } from "./enrichment/models-dev.js";
import { fetchOpenRouterLookup } from "./enrichment/openrouter.js";
import { registerModelCatalogCommand } from "./commands/model-catalog-command.js";
import { DebugLogger } from "./logging/logger.js";
import { ModelRegistrar, type RegistrationOutcome, type RegistrationOptions } from "./registry/registrar.js";
import { isTextCompletionModel } from "./shared/model-kind.js";

interface ResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}

type ResourcesDiscoverHandler = (event: ResourcesDiscoverEvent, ctx: ExtensionContext) => void;

interface BootstrapRequest {
  trigger: string;
  forceRegistration?: boolean;
  builtinProviderIds?: ReadonlySet<string>;
}

interface BootstrapRuntimeState {
  bootstrap?: Promise<void>;
  discovery?: Promise<void>;
  pending?: BootstrapRequest;
}

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_MULTI_AUTH_PROVIDERS_REGISTERED_EVENT = "pi-multi-auth:providers-registered";
export const MODEL_DISCOVERY_READY_EVENT = "pi-model-discovery:ready";
export const MODEL_DISCOVERY_CACHE_ONLY_ENV = "PI_MODEL_DISCOVERY_CACHE_ONLY";

export interface ModelDiscoveryStartupPolicy {
  networkRefreshDisabled: boolean;
  registerStaleCache: boolean;
  reason?: string;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveModelDiscoveryStartupPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ModelDiscoveryStartupPolicy {
  if (isTruthyEnvFlag(env[MODEL_DISCOVERY_CACHE_ONLY_ENV])) {
    return {
      networkRefreshDisabled: true,
      registerStaleCache: true,
      reason: MODEL_DISCOVERY_CACHE_ONLY_ENV,
    };
  }

  return { networkRefreshDisabled: false, registerStaleCache: false };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function readDebugEnabled(extensionRoot: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(extensionRoot, "config.json"), "utf-8")) as unknown;
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        (parsed as { debug?: unknown }).debug === true,
    );
  } catch {
    return false;
  }
}

function logBootstrapFailure(trigger: string, error: unknown): void {
  const logger = new DebugLogger({
    extensionRoot: EXTENSION_ROOT,
    debug: readDebugEnabled(EXTENSION_ROOT),
  });
  logger.error("bootstrap_failed", { trigger, message: getErrorMessage(error) });
  void logger.flush();
}

function onResourcesDiscover(pi: ExtensionAPI, handler: ResourcesDiscoverHandler): void {
  (pi as unknown as { on(event: "resources_discover", handler: ResourcesDiscoverHandler): void }).on("resources_discover", handler);
}

function emitModelDiscoveryReady(
  pi: ExtensionAPI,
  payload: { trigger: string; phase: "cache" | "discovery"; forceRegistration?: boolean },
): void {
  pi.events?.emit(MODEL_DISCOVERY_READY_EVENT, {
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

async function fetchCatalogSource(
  logger: DebugLogger,
  source: { url: string; successEvent: string; failureEvent: string; fetch: () => Promise<ModelsDevLookup> },
): Promise<ModelsDevLookup | undefined> {
  try {
    const lookup = await source.fetch();
    logger.debug(source.successEvent, { url: source.url, entries: lookup.size });
    return lookup;
  } catch (error) {
    logger.warn(source.failureEvent, { message: error instanceof Error ? error.message : "unknown error" });
    return undefined;
  }
}

async function loadModelsDevLookup(config: ExtensionConfig, logger: DebugLogger): Promise<ModelsDevLookup> {
  const sources: Array<Parameters<typeof fetchCatalogSource>[1]> = [];

  if (config.modelsDev.enabled) {
    sources.push({
      url: config.modelsDev.url,
      successEvent: "models_dev_fetch_succeeded",
      failureEvent: "models_dev_fetch_failed",
      fetch: () => fetchModelsDevLookup(config.modelsDev.url, config.modelsDev.timeoutMs),
    });
  }

  const openRouter = config.openRouter;
  if (openRouter?.enabled) {
    sources.push({
      url: openRouter.url,
      successEvent: "openrouter_catalog_fetch_succeeded",
      failureEvent: "openrouter_catalog_fetch_failed",
      fetch: () => fetchOpenRouterLookup(openRouter.url, openRouter.timeoutMs),
    });
  }

  const lookups = (await Promise.all(sources.map((source) => fetchCatalogSource(logger, source)))).filter((lookup): lookup is ModelsDevLookup => lookup !== undefined);
  return mergeModelsDevLookups(lookups);
}

function fallbackRawModels(provider: ProviderConfigEntry): Array<{ id: string }> {
  return applyModelFilters(provider.fallbackModelIds ?? [], provider).map((id) => ({ id }));
}

function applyCurrentProviderDefaults(provider: ProviderConfigEntry, models: DiscoveredModel[]): DiscoveredModel[] {
  return models.map((model) => {
    const withDefaults = Object.keys(provider.defaults).length === 0
      ? model
      : applyModelDefaults(model, provider.defaults, "providerDefaults");
    const withQuirks = applyProviderModelQuirks(provider, withDefaults);
    return provider.id === "ollama" ? applyOllamaCloudFreePremium(withQuirks) : withQuirks;
  });
}

function mergeWithStaticModels(provider: ProviderConfigEntry, models: DiscoveredModel[], modelsDevLookup: ModelsDevLookup = new Map()): DiscoveredModel[] {
  const staticRawModels = fallbackRawModels(provider);
  const currentModels = applyCurrentProviderDefaults(provider, models).filter((model) => isTextCompletionModel(provider, model));
  const mergedById = new Map(currentModels.map((model) => [model.id, model]));
  if (staticRawModels.length === 0) return [...mergedById.values()];

  for (const staticRawModel of staticRawModels) {
    const existing = mergedById.get(staticRawModel.id);
    if (existing) {
      const withModelDefaults = applyModelDefaults(existing, provider.modelDefaults[staticRawModel.id], "modelsJsonDefaults");
      mergedById.set(staticRawModel.id, applyModelDefaults(withModelDefaults, provider.defaults, "providerDefaults"));
      continue;
    }
    const [staticModel] = enrichProviderModels(provider, [staticRawModel], modelsDevLookup);
    if (staticModel && isTextCompletionModel(provider, staticModel)) mergedById.set(staticModel.id, staticModel);
  }

  return [...mergedById.values()];
}

function modelsChanged(previous: DiscoveredModel[], next: DiscoveredModel[]): boolean {
  return !valuesEqual(previous, next);
}

function logCatalogResolutionGaps(
  config: ExtensionConfig,
  logger: DebugLogger,
  provider: ProviderConfigEntry,
  rawModels: RawDiscoveredModel[],
  enrichedModels: DiscoveredModel[],
): void {
  if (!config.debug) return;
  const rawById = new Map(rawModels.map((model) => [model.id, model]));
  const unmatched = enrichedModels.filter((model) => model.sources.modelsDev !== true);
  if (unmatched.length === 0) return;

  const sampledModels = unmatched.slice(0, 10).map((model) => {
    const rawModel = rawById.get(model.id);
    return {
      id: model.id,
      lookupCandidates: rawModel ? catalogLookupCandidates(rawModel) : [model.id],
    };
  });
  logger.debug("catalog_resolution_unmatched_models", {
    providerId: provider.id,
    reason: "no catalog metadata matched from enabled sources",
    modelCount: unmatched.length,
    sampledModels,
    truncatedModelCount: Math.max(0, unmatched.length - sampledModels.length),
  });
}

function registrationOptions(config: ExtensionConfig, options: { force?: boolean } = {}): RegistrationOptions {
  return {
    ...options,
    importMode: config.registration?.importMode,
    ownership: config.registrationOwnership,
  };
}

function logRegistrationOutcome(logger: DebugLogger, providerId: string, outcome: boolean | RegistrationOutcome, context: string, modelCount: number): void {
  if (typeof outcome === "boolean") {
    if (outcome) logger.debug(context, { providerId, modelCount, owner: "pi-model-discovery" });
    return;
  }
  if (outcome.skipped) {
    logger.warn("registration_skipped", { providerId, context, owner: outcome.owner, reason: outcome.reason });
    return;
  }
  if (outcome.registered) {
    logger.debug(context, { providerId, modelCount, owner: outcome.owner });
  }
}

async function registerCachedModels(
  config: ExtensionConfig,
  cacheManager: CacheManager,
  registrar: ModelRegistrar,
  logger: DebugLogger,
  options: { force?: boolean; allowStale?: boolean; readOnlyCache?: boolean } = {},
): Promise<void> {
  const cache = cacheManager.read();
  for (const provider of config.providers) {
    if (!provider.discovery.enabled) continue;
    const entry = cache.providers[provider.id];
    const entryFresh = entry ? isProviderCacheEntryFresh(provider.id, entry) : false;
    const cachedModels = entry && (entryFresh || options.allowStale === true)
      ? entry.models
      : undefined;
    const fallbackModels = provider.discovery.type === "static" && !cachedModels
      ? enrichProviderModels(provider, fallbackRawModels(provider), new Map())
      : undefined;
    const models = cachedModels ?? fallbackModels;
    const context = cachedModels
      ? (entryFresh ? "registered_from_cache" : "registered_from_stale_cache")
      : "registered_static_fallback";
    if (!models || models.length === 0) continue;
    const mergedModels = mergeWithStaticModels(provider, models);
    if (entry && entryFresh && modelsChanged(entry.models, mergedModels)) {
      if (options.readOnlyCache) {
        logger.debug("static_fallback_cache_rewrite_skipped", {
          providerId: provider.id,
          reason: MODEL_DISCOVERY_CACHE_ONLY_ENV,
          authoritative: entry.authoritative,
          previousModelCount: entry.models.length,
          nextModelCount: mergedModels.length,
        });
      } else {
        try {
          await cacheManager.writeProviderEntry(provider.id, { ...entry, models: mergedModels });
          logger.debug("static_fallback_cache_rewritten", {
            providerId: provider.id,
            authoritative: entry.authoritative,
            previousModelCount: entry.models.length,
            nextModelCount: mergedModels.length,
          });
        } catch (error) {
          logger.warn("static_fallback_cache_rewrite_failed", { providerId: provider.id, message: getErrorMessage(error) });
        }
      }
    }
    try {
      const outcome = registrar.register({ provider, models: mergedModels }, registrationOptions(config, options));
      logRegistrationOutcome(logger, provider.id, outcome, context, mergedModels.length);
    } catch (error) {
      logger.error("cache_registration_failed", { providerId: provider.id, message: error instanceof Error ? error.message : "unknown error" });
    }
  }
}

async function refreshFromDiscovery(config: ExtensionConfig, cacheManager: CacheManager, registrar: ModelRegistrar, logger: DebugLogger): Promise<void> {
  const cacheSnapshot = cacheManager.read();
  const providersNeedingDiscovery = config.providers.filter((provider) => {
    if (!provider.discovery.enabled) return false;
    const entry = cacheSnapshot.providers[provider.id];
    return !entry || !isProviderCacheEntryFresh(provider.id, entry);
  });
  if (providersNeedingDiscovery.length === 0) return;

  const modelsDevLookup = await loadModelsDevLookup(config, logger);
  const results = await discoverProviders({ ...config, providers: providersNeedingDiscovery });
  const cacheUpdates: CacheProviderWrite[] = [];
  const registrations: Array<{ provider: ProviderConfigEntry; models: ReturnType<typeof enrichProviderModels>; context: string }> = [];

  for (const result of results) {
    if (result.warnings.length > 0) {
      logger.warn("provider_discovery_warning", { providerId: result.provider.id, warnings: result.warnings });
    }

    const provider = result.sourceProvider;
    if (!result.authoritative) {
      const cached = cacheSnapshot.providers[provider.id];
      if (cached) {
        const models = mergeWithStaticModels(provider, cached.models);
        cacheUpdates.push({ provider, models, authoritative: false });
        registrations.push({ provider, models, context: "registered_stale_cache_after_discovery_failure" });
        continue;
      }

      const fallbackModels = fallbackRawModels(provider);
      if (fallbackModels.length > 0) {
        const models = enrichProviderModels(provider, fallbackModels, modelsDevLookup);
        cacheUpdates.push({ provider, models, authoritative: false });
        registrations.push({ provider, models, context: "registered_models_json_fallback_after_discovery_failure" });
      } else {
        cacheUpdates.push({ provider, models: [], authoritative: false });
      }
      continue;
    }

    const cached = cacheSnapshot.providers[provider.id];
    const discoveredModels = enrichProviderModels(provider, result.models, modelsDevLookup, cached?.models ?? []);
    logCatalogResolutionGaps(config, logger, provider, result.models, discoveredModels);
    const models = mergeWithStaticModels(provider, discoveredModels, modelsDevLookup);
    cacheUpdates.push({ provider, models, authoritative: true });
    registrations.push({ provider, models, context: "registered_from_discovery" });
  }

  try {
    await cacheManager.writeProviders(cacheUpdates);
  } catch (error) {
    logger.warn("discovery_cache_write_failed", { message: getErrorMessage(error), providerCount: cacheUpdates.length });
  }
  for (const registration of registrations) {
    const outcome = registrar.register({ provider: registration.provider, models: registration.models }, registrationOptions(config));
    logRegistrationOutcome(logger, registration.provider.id, outcome, registration.context, registration.models.length);
  }
}

function deferBackgroundRefresh(refresh: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      void refresh().then(resolve, reject);
    }, 0);
    timeout.unref?.();
  });
}

/**
 * Collect Pi-Mono-managed built-in provider IDs dynamically from the runtime
 * model registry. This replaces a hardcoded provider list so stale-cache
 * pruning and auto-import skip decisions track upstream renames and additions
 * automatically. Returns an empty set (driving the static fallback) when the
 * registry is unavailable.
 */
function extractBuiltinProviderIds(registry: { getAll?(): ReadonlyArray<{ provider: string }> } | undefined): ReadonlySet<string> {
  try {
    const models = registry?.getAll?.() ?? [];
    const ids = new Set<string>();
    for (const model of models) {
      if (typeof model.provider === "string" && model.provider) ids.add(model.provider);
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

function collectBuiltinProviderIds(pi: ExtensionAPI): ReadonlySet<string> {
  return extractBuiltinProviderIds((pi as unknown as { modelRegistry?: { getAll?(): ReadonlyArray<{ provider: string }> } }).modelRegistry);
}

function collectBuiltinProviderIdsFromContext(ctx: ExtensionContext): ReadonlySet<string> {
  return extractBuiltinProviderIds(ctx.modelRegistry);
}

async function bootstrap(
  pi: ExtensionAPI,
  registrar: ModelRegistrar,
  trigger: string,
  runtime: BootstrapRuntimeState,
  options: { forceRegistration?: boolean; builtinProviderIds?: ReadonlySet<string> } = {},
): Promise<void> {
  const builtinProviderIds = options.builtinProviderIds ?? collectBuiltinProviderIds(pi);
  const { config, warnings } = await loadConfigAsync({ extensionRoot: EXTENSION_ROOT, builtinProviderIds });
  const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: config.debug });
  const startupPolicy = resolveModelDiscoveryStartupPolicy();
  for (const warning of warnings) {
    logger.warn("config_warning", { warning });
  }

  const activeProviderIds = new Set(config.providers.filter((provider) => provider.discovery.enabled).map((provider) => provider.id));
  const cacheManager = new CacheManager(config.cacheFile || join(EXTENSION_ROOT, "cache.json"));
  const explicitlyPrunedProviderIds = new Set([
    ...config.autoImport.excludeProviders,
    ...config.autoImport.hiddenProviders,
    ...config.autoImport.externalStaticProviderIds,
    ...config.providers.filter((provider) => !provider.discovery.enabled).map((provider) => provider.id),
  ]);
  if (startupPolicy.networkRefreshDisabled) {
    logger.debug("cache_prune_skipped", { trigger, reason: startupPolicy.reason });
  } else {
    try {
      const prunedProviderIds = await cacheManager.pruneProviderIds(explicitlyPrunedProviderIds);
      if (prunedProviderIds.length > 0) {
        logger.debug("pruned_explicitly_removed_provider_cache", { providerIds: prunedProviderIds });
      }
    } catch (error) {
      logger.warn("cache_prune_failed", { trigger, message: getErrorMessage(error) });
    }
  }

  const removedProviderIds = registrar.unregisterMissing(activeProviderIds);
  if (removedProviderIds.length > 0) {
    logger.debug("unregistered_removed_providers", { providerIds: removedProviderIds });
  }

  await registerCachedModels(config, cacheManager, registrar, logger, {
    force: options.forceRegistration,
    allowStale: startupPolicy.registerStaleCache,
    readOnlyCache: startupPolicy.networkRefreshDisabled,
  });
  emitModelDiscoveryReady(pi, {
    trigger,
    phase: "cache",
    forceRegistration: options.forceRegistration,
  });

  if (startupPolicy.networkRefreshDisabled) {
    logger.debug("network_refresh_skipped", {
      trigger,
      reason: startupPolicy.reason,
      registerStaleCache: startupPolicy.registerStaleCache,
    });
    return;
  }

  if (runtime.discovery) {
    logger.debug("background_refresh_already_running", { trigger });
    return;
  }

  runtime.discovery = deferBackgroundRefresh(() => refreshFromDiscovery(config, cacheManager, registrar, logger))
    .then(() => {
      emitModelDiscoveryReady(pi, {
        trigger,
        phase: "discovery",
        forceRegistration: options.forceRegistration,
      });
    })
    .catch((error: unknown) => {
      logger.error("background_refresh_failed", { trigger, message: error instanceof Error ? error.message : "unknown error" });
    })
    .finally(() => {
      runtime.discovery = undefined;
    });
}

function shouldQueueBootstrap(trigger: string, options: { forceRegistration?: boolean }): boolean {
  return options.forceRegistration === true || trigger === "resources_discover:reload";
}

function scheduleBootstrap(
  pi: ExtensionAPI,
  registrar: ModelRegistrar,
  runtime: BootstrapRuntimeState,
  trigger: string,
  options: { forceRegistration?: boolean; builtinProviderIds?: ReadonlySet<string> } = {},
): void {
  if (runtime.bootstrap) {
    if (shouldQueueBootstrap(trigger, options)) {
      runtime.pending = {
        trigger,
        forceRegistration: runtime.pending?.forceRegistration === true || options.forceRegistration === true,
        builtinProviderIds: options.builtinProviderIds ?? runtime.pending?.builtinProviderIds,
      };
    }
    return;
  }

  runtime.bootstrap = bootstrap(pi, registrar, trigger, runtime, options)
    .catch((error: unknown) => {
      logBootstrapFailure(trigger, error);
    })
    .finally(() => {
      runtime.bootstrap = undefined;
      const pending = runtime.pending;
      runtime.pending = undefined;
      if (pending) {
        scheduleBootstrap(pi, registrar, runtime, pending.trigger, {
          forceRegistration: pending.forceRegistration,
          builtinProviderIds: pending.builtinProviderIds,
        });
      }
    });
}

function isModelDiscoveryEnabled(): boolean {
  const configPath = join(EXTENSION_ROOT, "config.json");
  if (!existsSync(configPath)) {
    return true;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return true;
    }
    return (parsed as Record<string, unknown>).enabled !== false;
  } catch {
    return true;
  }
}

export default function modelDiscoveryExtension(pi: ExtensionAPI): void {
  if (!isModelDiscoveryEnabled()) {
    return;
  }

  const registrar = new ModelRegistrar(pi);
  const runtime: BootstrapRuntimeState = {};

  registerModelCatalogCommand(pi, EXTENSION_ROOT);
  scheduleBootstrap(pi, registrar, runtime, "extension_load");
  pi.events?.on(PI_MULTI_AUTH_PROVIDERS_REGISTERED_EVENT, () => {
    scheduleBootstrap(pi, registrar, runtime, PI_MULTI_AUTH_PROVIDERS_REGISTERED_EVENT, { forceRegistration: true });
  });

  pi.on("session_start", (_event, ctx) => {
    scheduleBootstrap(pi, registrar, runtime, "session_start", { builtinProviderIds: collectBuiltinProviderIdsFromContext(ctx) });
  });

  onResourcesDiscover(pi, (event) => {
    scheduleBootstrap(pi, registrar, runtime, `resources_discover:${event.reason}`);
  });
}
