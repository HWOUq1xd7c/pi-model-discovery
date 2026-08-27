import test from "node:test";
import assert from "node:assert/strict";

import type { DiscoveredModel } from "../src/cache/types.js";
import type { ProviderConfigEntry } from "../src/config/types.js";
import type { RawDiscoveredModel } from "../src/discovery/types.js";
import { enrichProviderModels } from "../src/enrichment/merger.js";
import { buildModelsDevLookup, fetchModelsDevLookup, type ModelsDevLookup } from "../src/enrichment/models-dev.js";
import { createTestApiKey } from "./support/secrets.js";

const TEST_API_KEY = createTestApiKey("next-roadmap");

type NextCatalogMetadata = Record<string, unknown> & {
  canonicalId?: string;
  equivalentIds?: string[];
  providerMapping?: { provider?: string };
  catalogSources?: string[];
  capabilities?: Record<string, boolean>;
  output?: string[];
  thinkingLevelMap?: Record<string, string | null>;
};

function provider(overrides: Partial<ProviderConfigEntry> = {}): ProviderConfigEntry {
  return {
    id: "next-provider",
    baseUrl: "https://next-provider.example.invalid/v1",
    apiKey: TEST_API_KEY,
    api: "openai-completions" as ProviderConfigEntry["api"],
    authHeader: true,
    headers: {},
    maxModels: 10,
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
    ...overrides,
  };
}

function rawModel(overrides: Partial<RawDiscoveredModel> = {}): RawDiscoveredModel {
  return {
    id: "catalog-model",
    name: "Endpoint Catalog Model",
    ...overrides,
  };
}

function pricedModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "catalog-model",
    name: "Cached Catalog Model",
    reasoning: false,
    input: ["text"],
    cost: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {},
    sources: {},
    ...overrides,
  };
}

test("external catalog sync maps provider model IDs and aliases to canonical models without live network", async (t) => {
  const catalogUrl = "https://catalog.example.invalid/models.dev.json";
  const requestedUrls: string[] = [];
  const catalogFixture = {
    models: {
      "openai/gpt-4o-mini": {
        id: "openai/gpt-4o-mini",
        name: "GPT-4o mini",
        aliases: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"],
        providers: {
          openai: { id: "gpt-4o-mini" },
          openrouter: { id: "openai/gpt-4o-mini" },
          litellm: { id: "gpt-4o-mini" },
        },
      },
    },
  };

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requestedUrls.push(String(input));
    return new Response(JSON.stringify(catalogFixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const lookup = await fetchModelsDevLookup(catalogUrl, 1000);
  const alias = lookup.get("gpt-4o-mini-2024-07-18") as unknown as NextCatalogMetadata | undefined;
  const openaiMapping = lookup.get("openai:gpt-4o-mini") as unknown as NextCatalogMetadata | undefined;
  const openRouterMapping = lookup.get("openrouter:openai/gpt-4o-mini") as unknown as NextCatalogMetadata | undefined;
  const liteLlmMapping = lookup.get("litellm:gpt-4o-mini") as unknown as NextCatalogMetadata | undefined;

  assert.deepEqual(
    {
      requestedUrls,
      aliasCanonicalId: alias?.canonicalId,
      aliasEquivalentIds: alias?.equivalentIds,
      openaiCanonicalId: openaiMapping?.canonicalId,
      openaiProvider: openaiMapping?.providerMapping?.provider,
      openRouterCanonicalId: openRouterMapping?.canonicalId,
      liteLlmCanonicalId: liteLlmMapping?.canonicalId,
      catalogSources: openRouterMapping?.catalogSources,
    },
    {
      requestedUrls: [catalogUrl],
      aliasCanonicalId: "openai/gpt-4o-mini",
      aliasEquivalentIds: ["gpt-4o-mini", "gpt-4o-mini-2024-07-18", "openai:gpt-4o-mini", "openrouter:openai/gpt-4o-mini", "litellm:gpt-4o-mini"],
      openaiCanonicalId: "openai/gpt-4o-mini",
      openaiProvider: "openai",
      openRouterCanonicalId: "openai/gpt-4o-mini",
      liteLlmCanonicalId: "openai/gpt-4o-mini",
      catalogSources: ["models.dev"],
    },
  );
});

test("models.dev catalog fetch reports HTTP non-OK responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));

  await assert.rejects(() => fetchModelsDevLookup("https://catalog.example.invalid/models.dev.json", 1000), /models\.dev catalog fetch failed: HTTP 503/);
});

test("alias equivalence index reports ambiguous aliases instead of resolving arbitrarily", () => {
  const lookup = buildModelsDevLookup({
    models: {
      "anthropic/claude-sonnet-4": {
        id: "anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        aliases: ["sonnet-latest"],
      },
      "openrouter/anthropic-claude-sonnet-4": {
        id: "openrouter/anthropic-claude-sonnet-4",
        name: "Claude Sonnet 4 via OpenRouter",
        aliases: ["sonnet-latest"],
      },
    },
  });
  const alias = lookup.get("sonnet-latest") as unknown as NextCatalogMetadata | undefined;
  const ambiguities = (lookup as unknown as { ambiguities?: Array<{ alias: string; candidates: string[]; source: string }> }).ambiguities;

  assert.deepEqual(
    {
      ambiguousAliasResolved: alias?.canonicalId ?? null,
      ambiguities,
    },
    {
      ambiguousAliasResolved: null,
      ambiguities: [
        {
          alias: "sonnet-latest",
          candidates: ["anthropic/claude-sonnet-4", "openrouter/anthropic-claude-sonnet-4"],
          source: "models.dev",
        },
      ],
    },
  );
});

test("enrichment records per-capability provenance for dynamic, catalog, cache, endpoint, model, and provider sources", () => {
  const lookup = new Map([
    [
      "catalog-model",
      {
        id: "catalog-model",
        name: "Catalog Model",
        reasoning: false,
        contextWindow: 200_000,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      },
    ],
  ]) as ModelsDevLookup;
  const nextProvider = provider({
    defaults: {
      reasoning: true,
      input: ["text", "image"],
    },
    modelDefaults: {
      "catalog-model": {
        maxTokens: 64_000,
      },
    },
  });
  const [enriched] = enrichProviderModels(
    nextProvider,
    [rawModel({ defaults: { maxTokens: 32_000, compat: { strict: true } as never } })],
    lookup,
  );

  assert.deepEqual(
    {
      finalValues: {
        name: enriched?.name,
        reasoning: enriched?.reasoning,
        input: enriched?.input,
        contextWindow: enriched?.contextWindow,
        maxTokens: enriched?.maxTokens,
        compat: enriched?.compat,
      },
      capabilityProvenance: (enriched as unknown as Record<string, unknown> | undefined)?.capabilityProvenance,
    },
    {
      finalValues: {
        name: "Catalog Model",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
        compat: { strict: true },
      },
      capabilityProvenance: {
        id: "dynamic",
        name: "modelsDev",
        reasoning: "providerDefaults",
        input: "providerDefaults",
        cost: "modelsDev",
        contextWindow: "modelsDev",
        maxTokens: "modelsJsonDefaults",
        compat: "endpointDetails",
      },
    },
  );
});

test("models.dev metadata maps Claude Opus 4.6/4.7/4.8 xhigh to the documented effort tier", () => {
  const lookup = buildModelsDevLookup({
    models: [
      {
        id: "anthropic/claude-opus-4.8",
        name: "Claude Opus 4.8",
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
      },
      {
        id: "anthropic/claude-opus-4.7",
        name: "Claude Opus 4.7",
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
      },
      {
        id: "anthropic/claude-opus-4.6",
        name: "Claude Opus 4.6",
        reasoning: true,
        limit: { context: 1_000_000, output: 128_000 },
      },
    ],
  });

  const opus48Metadata = lookup.get("anthropic/claude-opus-4.8") as unknown as NextCatalogMetadata | undefined;
  const opus47Metadata = lookup.get("anthropic/claude-opus-4.7") as unknown as NextCatalogMetadata | undefined;
  const opus46Metadata = lookup.get("anthropic/claude-opus-4.6") as unknown as NextCatalogMetadata | undefined;
  assert.deepEqual(opus48Metadata?.thinkingLevelMap, { xhigh: "xhigh" });
  assert.deepEqual(opus47Metadata?.thinkingLevelMap, { xhigh: "xhigh" });
  assert.deepEqual(opus46Metadata?.thinkingLevelMap, { xhigh: "max" });
});

test("models.dev metadata maps the source schema into Pi Mono compatible model defaults", () => {
  const lookup = buildModelsDevLookup({
    models: [
      {
        id: "omni-realtime",
        name: "Omni Realtime",
        attachment: true,
        reasoning: true,
        tool_call: true,
        structured_output: true,
        temperature: true,
        open_weights: true,
        interleaved: { field: "reasoning_details" },
        modalities: {
          input: ["text", "image", "pdf", "audio", "video"],
          output: ["text", "audio"],
        },
        capabilities: {
          json_mode: true,
          web_search: true,
          computer_use: true,
          embeddings: true,
        },
        limit: {
          context: 1_050_000,
          input: 922_000,
          output: 128_000,
        },
        cost: {
          input: 3,
          output: 15,
          cache_read: 0.3,
          cache_write: 3.75,
          tiers: [
            {
              input: 6,
              output: 22.5,
              cache_read: 0.6,
              tier: {
                type: "context",
                size: 272_000,
              },
            },
          ],
        },
      },
    ],
  });
  const metadata = lookup.get("omni-realtime") as unknown as NextCatalogMetadata | undefined;

  assert.deepEqual(
    {
      reasoning: metadata?.reasoning,
      input: metadata?.input,
      output: metadata?.output,
      capabilities: metadata?.capabilities,
      contextWindow: metadata?.contextWindow,
      maxTokens: metadata?.maxTokens,
      cost: metadata?.cost,
    },
    {
      reasoning: true,
      input: ["text", "image"],
      output: ["text", "audio"],
      capabilities: {
        attachments: true,
        audioInput: true,
        computerUse: true,
        embeddings: true,
        interleavedReasoning: true,
        jsonMode: true,
        openWeights: true,
        structuredOutputs: true,
        temperature: true,
        toolCalling: true,
        videoInput: true,
        webSearch: true,
      },
      contextWindow: 272_000,
      maxTokens: 128_000,
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
      },
    },
  );
});
