import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { DiscoveredModel } from "../src/cache/types.js";
import { loadConfig } from "../src/config/loader.js";
import type { ExtensionConfig, ProviderConfigEntry } from "../src/config/types.js";
import { discoverProviders } from "../src/discovery/engine.js";
import { buildModelsDevLookup, type ModelsDevLookup } from "../src/enrichment/models-dev.js";
import { enrichProviderModels } from "../src/enrichment/merger.js";
import { ModelRegistrar } from "../src/registry/registrar.js";
import { createTestApiKey } from "./support/secrets.js";
import { writeJson } from "./support/fixtures.js";

const TEST_API_KEY = createTestApiKey("audit-red");

function loadRawConfig(rawConfig: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-audit-red-"));
  const configPath = join(dir, "config.json");
  writeJson(configPath, rawConfig);
  return loadConfig({
    extensionRoot: dir,
    configPath,
    modelsJsonPath: join(dir, "models.json"),
    authJsonPath: join(dir, "auth.json"),
  });
}

function provider(overrides: Partial<ProviderConfigEntry> = {}): ProviderConfigEntry {
  const base: ProviderConfigEntry = {
    id: "audit-provider",
    baseUrl: "https://audit-provider.example.invalid/v1",
    apiKey: TEST_API_KEY,
    api: "openai-completions" as ProviderConfigEntry["api"],
    authHeader: true,
    headers: {},
    maxModels: 100,
    discovery: {
      type: "openai-compat",
      enabled: true,
      headers: {},
      timeoutMs: 1000,
      ttlMs: 60_000,
      includeDetails: false,
      allowModels: [],
      blockModels: [],
    },
    defaults: {},
    modelDefaults: {},
    source: "explicit",
  };
  return { ...base, ...overrides, discovery: { ...base.discovery, ...overrides.discovery } };
}

function extensionConfig(providers: ProviderConfigEntry[]): ExtensionConfig {
  return {
    enabled: true,
    debug: false,
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

function discoveredModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "shape-model",
    name: "Shape Model",
    reasoning: false,
    input: ["audio", "video"],
    output: ["text"],
    capabilities: { toolCalling: true },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    sources: { dynamic: true, cache: true },
    capabilityProvenance: { input: "endpointDetails" },
    ...overrides,
  };
}

test("explicit config rejects unsafe baseUrl values before discovery can make requests", () => {
  const userInfoBaseUrl = new URL("https://api.example.invalid/v1");
  userInfoBaseUrl.username = "user";
  const result = loadRawConfig({
    autoImport: { enabled: false },
    providers: [
      {
        id: "metadata-ip",
        baseUrl: "http://169.254.169.254/latest/meta-data",
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat" },
      },
      {
        id: "userinfo-url",
        baseUrl: userInfoBaseUrl.toString(),
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat" },
      },
      {
        id: "query-url",
        baseUrl: "https://api.example.invalid/v1?redirect=http://127.0.0.1",
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat" },
      },
    ],
  });

  assert.deepEqual(result.config.providers.map((entry) => entry.id), []);
  for (const providerId of ["metadata-ip", "userinfo-url", "query-url"]) {
    assert.ok(
      result.warnings.some((warning) => warning.includes(providerId) && warning.includes("baseUrl")),
      `expected a redacted baseUrl warning for ${providerId}`,
    );
  }
});

test("explicit config normalizes modelDefaults and fallbackModelIds for discovery fallback", () => {
  const result = loadRawConfig({
    autoImport: { enabled: false },
    providers: [
      {
        id: "defaults-provider",
        baseUrl: "https://defaults.example.invalid/v1",
        apiKey: TEST_API_KEY,
        api: "openai-completions",
        discovery: { type: "openai-compat" },
        modelDefaults: {
          "known-model": {
            name: "Known Model",
            input: ["text", "audio"],
            contextWindow: 64_000,
          },
        },
        fallbackModelIds: ["known-model", "known-model", "backup-model", "", 42],
      },
    ],
  });

  const loaded = result.config.providers[0];
  assert.equal(loaded?.modelDefaults["known-model"]?.name, "Known Model");
  assert.deepEqual(loaded?.modelDefaults["known-model"]?.input, ["text", "audio"]);
  assert.equal(loaded?.modelDefaults["known-model"]?.contextWindow, 64_000);
  assert.deepEqual(loaded?.fallbackModelIds, ["known-model", "backup-model"]);
});

test("models.dev enrichment uses provider-qualified catalog mappings when raw IDs are provider-local", () => {
  const lookup = buildModelsDevLookup({
    models: {
      "openai/gpt-4o-mini": {
        id: "openai/gpt-4o-mini",
        name: "GPT-4o mini Catalog Name",
        providers: {
          openai: { id: "gpt-4o-mini" },
        },
        limit: { input: 200_000, output: 32_000 },
      },
    },
  }) as ModelsDevLookup;

  const [enriched] = enrichProviderModels(
    provider({ id: "openai" }),
    [{ id: "gpt-4o-mini", name: "Endpoint Name" }],
    lookup,
  );

  assert.deepEqual(
    {
      name: enriched?.name,
      contextWindow: enriched?.contextWindow,
      maxTokens: enriched?.maxTokens,
      provenance: enriched?.capabilityProvenance,
    },
    {
      name: "GPT-4o mini Catalog Name",
      contextWindow: 200_000,
      maxTokens: 32_000,
      provenance: {
        id: "dynamic",
        name: "modelsDev",
        contextWindow: "modelsDev",
        maxTokens: "modelsDev",
      },
    },
  );
});

test("malformed Anthropic-compatible and Ollama payloads return non-authoritative warning results", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const results = await discoverProviders(
    extensionConfig([
      provider({
        id: "anthropic-malformed",
        api: "anthropic-messages" as ProviderConfigEntry["api"],
        discovery: { type: "anthropic-compatible" } as Partial<ProviderConfigEntry["discovery"]> as ProviderConfigEntry["discovery"],
      }),
      provider({
        id: "ollama-malformed",
        baseUrl: "http://127.0.0.1:11434",
        authHeader: false,
        discovery: { type: "ollama" } as Partial<ProviderConfigEntry["discovery"]> as ProviderConfigEntry["discovery"],
      }),
    ]),
  );

  assert.deepEqual(
    results.map((result) => ({
      id: result.provider.id,
      authoritative: result.authoritative,
      hasMalformedWarning: result.warnings.some((warning) => /malformed|expected/i.test(warning)),
    })),
    [
      { id: "anthropic-malformed", authoritative: false, hasMalformedWarning: true },
      { id: "ollama-malformed", authoritative: false, hasMalformedWarning: true },
    ],
  );
});

test("OpenAI-compatible pagination returns a non-authoritative warning when maxPages is exhausted with more data", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [{ id: "first-page" }], has_more: true, next_page: "still-more" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const [result] = await discoverProviders(
    extensionConfig([
      provider({
        id: "pagination-max-pages",
        discovery: {
          pagination: {
            enabled: true,
            cursorParam: "after",
            nextCursorField: "next_page",
            hasMoreField: "has_more",
            maxPages: 1,
          },
        } as Partial<ProviderConfigEntry["discovery"]> as ProviderConfigEntry["discovery"],
      }),
    ]),
  );

  assert.equal(result?.authoritative, false);
  assert.ok(result?.warnings.some((warning) => /pagination|page/i.test(warning)));
});

test("registrar output shape is Pi-compatible and omits extension-only provenance metadata", () => {
  const registrations: Array<{ providerId: string; models: Array<Record<string, unknown>> }> = [];
  const pi = {
    registerProvider(providerId: string, config: { models?: Array<Record<string, unknown>> }) {
      registrations.push({ providerId, models: config.models ?? [] });
    },
    unregisterProvider() {
      // No-op test double.
    },
  };
  const registrar = new ModelRegistrar(pi as never);

  registrar.register({ provider: provider({ id: "shape-provider" }), models: [discoveredModel()] }, { force: true });

  const registeredModel = registrations[0]?.models[0];
  assert.equal(registrations[0]?.providerId, "shape-provider");
  assert.deepEqual(registeredModel?.input, ["text"]);
  assert.equal(registeredModel?.importOwnership, "pi-model-discovery");
  assert.equal(Object.hasOwn(registeredModel ?? {}, "sources"), false);
  assert.equal(Object.hasOwn(registeredModel ?? {}, "capabilityProvenance"), false);
});

test("package test script discovers nested compiled test files", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  const testScript = packageJson.scripts?.test ?? "";

  assert.notEqual(testScript, "npm run build --silent && node --test dist/test/*.test.js");
  assert.match(testScript, /dist\/test\/\*\*\/\*\.test\.js|node --test dist\/test\b/);
});
