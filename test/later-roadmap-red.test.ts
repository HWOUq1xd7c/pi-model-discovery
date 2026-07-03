import test from "node:test";
import assert from "node:assert/strict";

import type { DiscoveredModel } from "../src/cache/types.js";
import type { ExtensionConfig, ProviderConfigEntry } from "../src/config/types.js";
import { discoverProviders } from "../src/discovery/engine.js";
import { discoverOpenAICompat } from "../src/discovery/openai-compat.js";
import { buildModelsDevLookup } from "../src/enrichment/models-dev.js";
import { ModelRegistrar } from "../src/registry/registrar.js";
import { createTestApiKey } from "./support/secrets.js";

const TEST_API_KEY = createTestApiKey("later-roadmap");

function provider(overrides: Partial<ProviderConfigEntry> = {}): ProviderConfigEntry {
  const base: ProviderConfigEntry = {
    id: "later-provider",
    baseUrl: "https://later-provider.example.invalid/v1",
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
    modelsDev: { enabled: false, url: "https://models.dev.invalid/api.json", timeoutMs: 1000 },
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

function discoveredModel(id: string, name: string): DiscoveredModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    sources: { dynamic: true },
  };
}

function existingProviderModel(id: string, name: string, managedByModelDiscovery: boolean): Record<string, unknown> {
  return {
    id,
    name,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    importOwnership: managedByModelDiscovery ? "pi-model-discovery" : "manual",
  };
}

function captureRegistrar(): {
  registrar: ModelRegistrar;
  registrations: Array<{ providerId: string; models: Array<{ id?: string; name?: string }> }>;
} {
  const registrations: Array<{ providerId: string; models: Array<{ id?: string; name?: string }> }> = [];
  const pi = {
    registerProvider(providerId: string, config: { models?: Array<{ id?: string; name?: string }> }) {
      registrations.push({ providerId, models: config.models ?? [] });
    },
    unregisterProvider() {
      // No-op test double.
    },
  };
  return { registrar: new ModelRegistrar(pi as never), registrations };
}

test("OpenAI-compatible discovery follows cursor pagination until the provider signals completion", async (t) => {
  const requestedUrls: string[] = [];
  const paginatedProvider = provider({
    discovery: {
      ...provider().discovery,
      pagination: {
        enabled: true,
        cursorParam: "after",
        nextCursorField: "next_page",
        hasMoreField: "has_more",
      },
    } as never,
  });

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://later-provider.example.invalid/v1/models") {
      return new Response(JSON.stringify({ data: [{ id: "page-one" }], has_more: true, next_page: "cursor-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://later-provider.example.invalid/v1/models?after=cursor-2") {
      return new Response(JSON.stringify({ data: [{ id: "page-two" }], has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected URL" }), { status: 404 });
  });

  const models = await discoverOpenAICompat(paginatedProvider);

  assert.deepEqual(
    { requestedUrls, modelIds: models.map((model) => model.id) },
    {
      requestedUrls: [
        "https://later-provider.example.invalid/v1/models",
        "https://later-provider.example.invalid/v1/models?after=cursor-2",
      ],
      modelIds: ["page-one", "page-two"],
    },
  );
});

test("provider endpoint quirks override the default OpenAI-compatible /models endpoint", async (t) => {
  const requestedUrls: string[] = [];
  const cloudflareProvider = provider({
    id: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1",
  });
  const expectedCloudflareModelsUrl =
    "https://api.cloudflare.com/client/v4/accounts/account-id/ai/models/search?per_page=100&task=Text%20Generation";

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url !== expectedCloudflareModelsUrl) {
      return new Response(JSON.stringify({ error: "provider quirk endpoint was not used" }), { status: 404 });
    }
    return new Response(JSON.stringify({ result: [{ name: "@cf/meta/llama-3.1-8b-instruct" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const models = await discoverOpenAICompat(cloudflareProvider);

  assert.deepEqual(
    { requestedUrls, modelIds: models.map((model) => model.id) },
    { requestedUrls: [expectedCloudflareModelsUrl], modelIds: ["@cf/meta/llama-3.1-8b-instruct"] },
  );
});

test("merge import mode preserves stale models and manual model overrides", () => {
  const { registrar, registrations } = captureRegistrar();
  const current = discoveredModel("current-dynamic", "Endpoint Current Name");
  const existingModels = [
    existingProviderModel("manual-local", "Manual Local Model", false),
    existingProviderModel("stale-dynamic", "Previously Discovered Model", true),
    existingProviderModel("current-dynamic", "Manual Override Current Name", false),
  ];

  registrar.register(
    { provider: provider({ id: "merge-provider" }), models: [current] },
    { force: true, importMode: "merge", existingModels } as never,
  );

  const registeredModels = registrations[0]?.models ?? [];
  assert.deepEqual(
    {
      ids: registeredModels.map((model) => model.id),
      currentName: registeredModels.find((model) => model.id === "current-dynamic")?.name,
    },
    {
      ids: ["manual-local", "stale-dynamic", "current-dynamic"],
      currentName: "Manual Override Current Name",
    },
  );
});

test("sync import mode removes stale pi-model-discovery entries while preserving manual entries and overrides", () => {
  const { registrar, registrations } = captureRegistrar();
  const current = discoveredModel("current-dynamic", "Endpoint Current Name");
  const existingModels = [
    existingProviderModel("manual-local", "Manual Local Model", false),
    existingProviderModel("stale-dynamic", "Previously Discovered Model", true),
    existingProviderModel("current-dynamic", "Manual Override Current Name", false),
  ];

  registrar.register(
    { provider: provider({ id: "sync-provider" }), models: [current] },
    { force: true, importMode: "sync", existingModels } as never,
  );

  const registeredModels = registrations[0]?.models ?? [];
  assert.deepEqual(
    {
      ids: registeredModels.map((model) => model.id),
      currentName: registeredModels.find((model) => model.id === "current-dynamic")?.name,
    },
    {
      ids: ["manual-local", "current-dynamic"],
      currentName: "Manual Override Current Name",
    },
  );
});

test("malformed catalog numeric metadata is ignored instead of poisoning enrichment defaults", () => {
  const lookup = buildModelsDevLookup({
    models: {
      "bad-catalog": {
        id: "bad-catalog",
        limit: { input: -128_000, output: -16_000 },
        cost: { input: -1, output: Number.NaN, cache_read: Number.POSITIVE_INFINITY, cache_write: -2 },
      },
    },
  });
  const metadata = lookup.get("bad-catalog");

  assert.deepEqual(
    {
      cost: metadata?.cost ?? null,
      contextWindow: metadata?.contextWindow ?? null,
      maxTokens: metadata?.maxTokens ?? null,
    },
    { cost: null, contextWindow: null, maxTokens: null },
  );
});

test("malformed discovery payloads produce non-authoritative results with actionable warnings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(JSON.stringify("not-a-model-list"), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const [result] = await discoverProviders(extensionConfig([provider({ id: "malformed-provider" })]));

  assert.deepEqual(
    {
      authoritative: result?.authoritative,
      modelCount: result?.models.length,
      hasMalformedWarning: result?.warnings.some((warning) => /malformed|invalid|schema/i.test(warning)),
    },
    { authoritative: false, modelCount: 0, hasMalformedWarning: true },
  );
});

test("transient discovery failures are retried before writing non-authoritative results", async (t) => {
  const requestedUrls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    if (requestedUrls.length === 1) {
      return new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 });
    }
    return new Response(JSON.stringify({ data: [{ id: "retry-success" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const [result] = await discoverProviders(extensionConfig([provider({ id: "retry-provider" })]));

  assert.deepEqual(
    {
      requestedCount: requestedUrls.length,
      authoritative: result?.authoritative,
      modelIds: result?.models.map((model) => model.id),
      warnings: result?.warnings,
    },
    {
      requestedCount: 2,
      authoritative: true,
      modelIds: ["retry-success"],
      warnings: [],
    },
  );
});

test("discovery limits startup fan-out across OpenAI-compatible providers", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  t.mock.method(globalThis, "fetch", async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight -= 1;
    return new Response(JSON.stringify({ data: [{ id: "limited" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const providers = Array.from({ length: 8 }, (_entry, index) => provider({ id: `limited-provider-${index}` }));
  const results = await discoverProviders(extensionConfig(providers));

  assert.deepEqual(
    {
      maxInFlight,
      resultCount: results.length,
      allAuthoritative: results.every((result) => result.authoritative),
    },
    {
      maxInFlight: 4,
      resultCount: 8,
      allAuthoritative: true,
    },
  );
});
