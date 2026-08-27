import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { CacheManager } from "../../src/cache/manager.js";
import { CACHE_SCHEMA_VERSION } from "../../src/cache/json-store.js";
import type { CacheEntry, DiscoveredModel } from "../../src/cache/types.js";
import type { ConfigLoadResult, ExtensionConfig, ProviderConfigEntry } from "../../src/config/types.js";
import { loadConfig } from "../../src/config/loader.js";

/**
 * Write a JSON-serializable value to a path. Shared by tests that stage fixture
 * files on disk so the identical helper is not redefined per test module.
 */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), "utf-8");
}

/**
 * Stage config/models/auth fixtures in a fresh temp dir and load the extension
 * config from them. The {@link prefix} personalizes the temp dir name so
 * parallel test runs keep readable diagnostics.
 */
export function loadWithFixtures(config: unknown, modelsRoot: unknown, authRoot: unknown, prefix: string): ConfigLoadResult {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(configPath, config);
  writeJson(modelsJsonPath, modelsRoot);
  writeJson(authJsonPath, authRoot);
  return loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
}

/**
 * Build a minimal `ExtensionConfig` wrapping a single provider. Shared by
 * adapter/contract tests that only need a fully-populated default config shape.
 */
export function configFor(provider: ProviderConfigEntry): ExtensionConfig {
  return {
    enabled: true,
    debug: false,
    refreshOnStart: true,
    refreshIntervalMs: 0,
    cacheTTL: 60_000,
    cacheFile: "cache.json",
    maxModels: 10,
    modelsDev: { enabled: false, url: "https://example.invalid/models-dev.json", timeoutMs: 1000 },
    autoImport: {
      enabled: false,
      allowUnauthenticated: false,
      modelsJsonPath: "models.json",
      authJsonPath: "auth.json",
      multiAuthJsonPath: "multi-auth.json",
      includeProviders: [],
      excludeProviders: [],
      hiddenProviders: [],
      externalStaticProviderIds: [],
      discovery: {
        enabled: true,
        headers: {},
        timeoutMs: 1000,
        ttlMs: 60_000,
        includeDetails: false,
        typeByProvider: {},
        endpointPathByProvider: {},
      },
    },
    providers: [provider],
  };
}

export interface FreeVerifierLogEntry {
  timestamp?: string;
  level?: string;
  extension?: string;
  event: string;
  [key: string]: unknown;
}

export interface FreeVerifierResult {
  verified: Array<{
    providerId: string;
    modelId: string;
    category: "confirmed-free" | "confirmed-paid" | "downgraded-to-paid" | "upgraded-to-free" | "unverifiable" | "skipped";
    reason?: string;
  }>;
  cacheUpdated: boolean;
  logs: FreeVerifierLogEntry[];
}

export interface FreeVerifierModule {
  verifyFreeModels(options: {
    config: ExtensionConfig;
    cacheManager: CacheManager;
    logger?: { debug(event: string, details?: unknown): void; warn(event: string, details?: unknown): void; error(event: string, details?: unknown): void };
    concurrency?: number;
    sendCredentials?: boolean;
    dryRun?: boolean;
    provider?: string;
    model?: string;
    strict?: boolean;
    json?: boolean;
  }): Promise<FreeVerifierResult>;
}

/** Computed specifier isolates a missing-implementation failure to verifier tests only. Resolves from `test/support/` to `src/`. */
export const VERIFIER_MODULE_SPECIFIER = ["..", "..", "src", "verification", "free-model-verifier.js"].join("/");

/**
 * Dynamically import the free-model verifier module and assert it exports
 * `verifyFreeModels`. Shared by verifier tests so the import/contract check is
 * not redefined per test module.
 */
export async function loadVerifierModule(): Promise<FreeVerifierModule> {
  const moduleNamespace = (await import(VERIFIER_MODULE_SPECIFIER)) as Partial<FreeVerifierModule>;
  assert.equal(typeof moduleNamespace.verifyFreeModels, "function", "verifyFreeModels must be exported from the free-model verifier module");
  return moduleNamespace as FreeVerifierModule;
}

/**
 * Capture verifier log output into an in-memory array. The returned logger
 * implements the `debug`/`warn`/`error` contract the verifier expects, so test
 * assertions can inspect emitted events without touching the filesystem.
 */
export function captureLogger() {
  const logs: FreeVerifierLogEntry[] = [];
  return {
    logger: {
      debug(event: string, details?: unknown) {
        logs.push({ event, level: "debug", ...(details as object | undefined) });
      },
      warn(event: string, details?: unknown) {
        logs.push({ event, level: "warn", ...(details as object | undefined) });
      },
      error(event: string, details?: unknown) {
        logs.push({ event, level: "error", ...(details as object | undefined) });
      },
    },
    logs,
  };
}

/**
 * Assert that serialized output does not leak any raw credential material.
 * Shared by free-model verifier tests that validate redaction behavior.
 */
export function assertNoSecretLeak(label: string, value: unknown, secrets: string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `${label} must not expose raw credential material`);
  }
}

/**
 * Normalize a `HeadersInit` into a plain lowercase-keyed record. Shared by
 * verifier tests that compare dispatched request headers against expectations.
 */
export function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key.toLowerCase(), value]));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = String(value);
  return result;
}

/**
 * Stage a `CacheManager` backed by a temp dir pre-seeded with the given
 * provider entries. The {@link prefix} personalizes the temp dir name.
 */
export function createCacheManagerWithEntries(entries: Record<string, CacheEntry>, prefix: string): { cacheManager: CacheManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const cachePath = join(dir, "cache.json");
  writeJson(cachePath, {
    version: CACHE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    providers: entries,
  });
  return { cacheManager: new CacheManager(cachePath), dir };
}

/**
 * Build the canonical auth-first discovery config fixture used by auth/red
 * profile tests. Optional {@link extra} keys override the base shape.
 */
export function authFirstConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: [],
    autoImport: {
      enabled: true,
      discovery: {
        timeoutMs: 1000,
        includeDetails: false,
      },
    },
    modelsDev: { enabled: false },
    ...extra,
  };
}

/**
 * Build a free-tier `DiscoveredModel` fixture for verifier tests. Optional
 * {@link overrides} merge over the zero-cost base shape.
 */
export function freeModel(id: string, name: string, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    isFree: true,
    sources: { dynamic: true, cache: true },
    capabilityProvenance: { isFree: "cache" },
    ...overrides,
  };
}

/**
 * Build a paid `DiscoveredModel` fixture for verifier tests. Optional
 * {@link overrides} merge over the priced base shape.
 */
export function paidModel(id: string, name: string, inputCost: number, outputCost: number, overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    isFree: false,
    sources: { dynamic: true, cache: true },
    capabilityProvenance: { isFree: "cache" },
    ...overrides,
  };
}

/**
 * Find a provider by id within a loaded config. Shared by auth/red-profile tests
 * that assert on specific provider entries.
 */
export function providerById(config: ExtensionConfig, providerId: string): ProviderConfigEntry | undefined {
  return config.providers.find((provider) => provider.id === providerId);
}

/**
 * Build a verifier-style `ExtensionConfig` with `maxModels: 100`. Shared by
 * free-model verifier tests that need a fully-populated default config shape.
 */
export function verifierExtensionConfig(providers: ProviderConfigEntry[]): ExtensionConfig {
  return {
    enabled: true,
    debug: false,
    refreshOnStart: true,
    refreshIntervalMs: 0,
    cacheTTL: 60_000,
    cacheFile: "cache.json",
    maxModels: 100,
    modelsDev: { enabled: false, url: "https://models-dev.example.invalid/api.json", timeoutMs: 1000 },
    autoImport: {
      enabled: false,
      allowUnauthenticated: false,
      modelsJsonPath: "models.json",
      authJsonPath: "auth.json",
      multiAuthJsonPath: "multi-auth.json",
      includeProviders: [],
      excludeProviders: [],
      hiddenProviders: [],
      externalStaticProviderIds: [],
      discovery: {
        enabled: true,
        headers: {},
        timeoutMs: 1000,
        ttlMs: 60_000,
        includeDetails: false,
        typeByProvider: {},
        endpointPathByProvider: {},
      },
    },
    providers,
  };
}

/**
 * Build a verifier config pointing `cacheFile` at the staged cache inside
 * {@link dir}. Shared by verifier tests that pair a temp cache with providers.
 */
export function createVerifierConfig(dir: string, providers: ProviderConfigEntry[]): ExtensionConfig {
  const config = verifierExtensionConfig(providers);
  return { ...config, cacheFile: join(dir, "cache.json") };
}
