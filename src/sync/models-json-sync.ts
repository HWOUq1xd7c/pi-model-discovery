import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import type { DiscoveredModel } from "../cache/types.js";
import { loadConfigAsync } from "../config/loader.js";
import type { ProviderConfigEntry } from "../config/types.js";
import { discoverProviders } from "../discovery/engine.js";
import { applyModelDefaults, applyOllamaCloudFreePremium, applyProviderModelQuirks, enrichProviderModels } from "../enrichment/merger.js";
import type { DebugLogger } from "../logging/logger.js";
import { isTextCompletionModel } from "../shared/model-kind.js";
import { isRecord } from "../shared/validation.js";

export interface SyncModelsJsonOptions {
  extensionRoot: string;
  modelsJsonPath?: string;
  authJsonPath?: string;
  configPath?: string;
  providerId?: string;
  dryRun?: boolean;
  backup?: boolean;
  logger?: DebugLogger;
}

export interface SyncedProviderResult {
  providerId: string;
  totalModels: number;
  addedModels: number;
  updatedModels: number;
  warnings: string[];
}

export interface SyncModelsJsonResult {
  success: boolean;
  modelsJsonPath: string;
  providers: SyncedProviderResult[];
  written: boolean;
  warnings: string[];
}

interface ModelsJsonStructure {
  providers?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const MODEL_ROUTING_FIELDS = new Set(["api", "baseUrl", "headers", "apiKey", "authHeader"]);
const PROVIDER_ROUTING_FIELDS = new Set(["api", "apiKey", "authHeader", "baseUrl", "headers", "models"]);

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function withoutModelRoutingFields(model: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(model).filter(([key]) => !MODEL_ROUTING_FIELDS.has(key)));
}

function mergeDiscoveredModel(discovered: ProviderModelConfig, existing: Record<string, unknown>): ProviderModelConfig {
  return {
    ...discovered,
    ...withoutModelRoutingFields(existing),
    id: discovered.id,
  };
}

export function toCleanProviderModelConfig(model: DiscoveredModel, provider?: ProviderConfigEntry): ProviderModelConfig {
  const input = (model.input ?? []).filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
  const config: ProviderModelConfig & { samplingParams?: Record<string, unknown> } = {
    id: model.id,
    name: model.name || model.id,
    input: input.length > 0 ? input : ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 16384,
  };

  if (model.api && (!provider || model.api !== provider.api)) config.api = model.api;
  if (model.baseUrl && (!provider || model.baseUrl !== provider.baseUrl)) config.baseUrl = model.baseUrl;
  if (model.reasoning !== undefined) config.reasoning = model.reasoning;
  if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) config.thinkingLevelMap = { ...model.thinkingLevelMap };
  if (model.compat && Object.keys(model.compat).length > 0) config.compat = { ...model.compat };
  if (model.samplingParams && Object.keys(model.samplingParams).length > 0) config.samplingParams = { ...model.samplingParams };

  return config;
}

function applyProviderDefaultsAndQuirks(provider: ProviderConfigEntry, models: DiscoveredModel[]): DiscoveredModel[] {
  return models.map((model) => {
    const withDefaults = Object.keys(provider.defaults).length === 0
      ? model
      : applyModelDefaults(model, provider.defaults, "providerDefaults");
    const withQuirks = applyProviderModelQuirks(provider, withDefaults);
    return provider.id === "ollama" ? applyOllamaCloudFreePremium(withQuirks) : withQuirks;
  });
}

function mergeModelEntries(
  existingModels: unknown,
  discoveredConfigs: ProviderModelConfig[],
): { merged: ProviderModelConfig[]; added: number; updated: number } {
  const existingList: Array<Record<string, unknown>> = Array.isArray(existingModels)
    ? existingModels.filter((model): model is Record<string, unknown> => isRecord(model) && typeof model.id === "string")
    : [];
  const discoveredById = new Map(discoveredConfigs.map((model) => [model.id, model]));
  const merged: ProviderModelConfig[] = [];
  const emittedIds = new Set<string>();
  let added = 0;
  let updated = 0;

  for (const existing of existingList) {
    const id = existing.id as string;
    if (emittedIds.has(id)) continue;
    const discovered = discoveredById.get(id);
    if (discovered) {
      merged.push(mergeDiscoveredModel(discovered, existing));
      updated += 1;
    } else {
      merged.push(existing as unknown as ProviderModelConfig);
    }
    emittedIds.add(id);
  }

  for (const discovered of discoveredConfigs) {
    if (emittedIds.has(discovered.id)) continue;
    merged.push(discovered);
    added += 1;
    emittedIds.add(discovered.id);
  }

  return { merged, added, updated };
}

export async function atomicWriteJson(filePath: string, data: unknown, backup = true): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  if (backup && existsSync(filePath)) await copyFile(filePath, `${filePath}.bak`);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function buildSyncedProviderEntry(
  existingProviderEntry: Record<string, unknown>,
  provider: ProviderConfigEntry,
  models: ProviderModelConfig[],
): Record<string, unknown> {
  const preserved = Object.fromEntries(
    Object.entries(existingProviderEntry).filter(([key]) => !PROVIDER_ROUTING_FIELDS.has(key)),
  );
  return {
    ...preserved,
    baseUrl: provider.baseUrl,
    api: provider.api,
    authHeader: provider.authHeader,
    ...(Object.keys(provider.headers).length > 0 ? { headers: { ...provider.headers } } : {}),
    models,
  };
}

export async function syncModelsJson(options: SyncModelsJsonOptions): Promise<SyncModelsJsonResult> {
  const { config, warnings: configWarnings } = await loadConfigAsync({
    extensionRoot: options.extensionRoot,
    modelsJsonPath: options.modelsJsonPath,
    authJsonPath: options.authJsonPath,
    configPath: options.configPath,
  });

  const modelsJsonPath = options.modelsJsonPath ?? config.autoImport.modelsJsonPath;
  const providersToSync = config.providers
    .filter((provider) => provider.discovery.enabled)
    .filter((provider) => !options.providerId || provider.id === options.providerId);
  const allWarnings = [...configWarnings];

  if (providersToSync.length === 0) {
    return { success: true, modelsJsonPath, providers: [], written: false, warnings: allWarnings };
  }

  const rawModelsJson = readJson(modelsJsonPath);
  const rootObj: ModelsJsonStructure = isRecord(rawModelsJson) ? { ...rawModelsJson } : {};
  const providerEntries = isRecord(rootObj.providers) ? { ...rootObj.providers } : {};
  rootObj.providers = providerEntries;
  const discoveryResults = await discoverProviders({ ...config, providers: providersToSync });
  const syncedProviderResults: SyncedProviderResult[] = [];

  for (const result of discoveryResults) {
    const provider = result.sourceProvider;
    const enriched = enrichProviderModels(provider, result.models, new Map());
    const withQuirks = applyProviderDefaultsAndQuirks(provider, enriched);
    const modelConfigs = withQuirks
      .filter((model) => isTextCompletionModel(provider, model))
      .map((model) => toCleanProviderModelConfig(model, provider));
    const existingProviderEntry = isRecord(providerEntries[provider.id]) ? providerEntries[provider.id] : {};
    const { merged, added, updated } = mergeModelEntries(existingProviderEntry.models, modelConfigs);

    providerEntries[provider.id] = buildSyncedProviderEntry(existingProviderEntry, provider, merged);
    syncedProviderResults.push({
      providerId: provider.id,
      totalModels: merged.length,
      addedModels: added,
      updatedModels: updated,
      warnings: [...result.warnings],
    });
  }

  const written = !options.dryRun && syncedProviderResults.some((provider) => provider.totalModels > 0);
  if (written) await atomicWriteJson(modelsJsonPath, rootObj, options.backup !== false);

  return {
    success: true,
    modelsJsonPath,
    providers: syncedProviderResults,
    written,
    warnings: allWarnings,
  };
}
