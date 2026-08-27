import test from "node:test";
import assert from "node:assert/strict";

import { toCleanProviderModelConfig } from "../src/index.js";
import { applyProviderModelQuirks } from "../src/enrichment/merger.js";
import type { DiscoveredModel } from "../src/cache/types.js";
import type { ProviderConfigEntry } from "../src/config/types.js";

test("cpa provider applies anthropic-messages and strips /v1 baseUrl for claude models", () => {
  const provider: ProviderConfigEntry = {
    id: "cpa",
    baseUrl: "http://localhost:8317/v1",
    apiKey: "test-key",
    api: "openai-completions",
    authHeader: true,
    headers: {},
    discovery: {
      type: "openai-compat",
      enabled: true,
      headers: {},
      timeoutMs: 10000,
      includeDetails: false,
      allowModels: [],
      blockModels: [],
    },
    defaults: {},
    modelDefaults: {},
    source: "auto-import",
  };

  const rawClaudeModel: DiscoveredModel = {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4 6 (cpa)",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    sources: { dynamic: true },
  };

  const withQuirks = applyProviderModelQuirks(provider, rawClaudeModel);
  assert.equal(withQuirks.api, "anthropic-messages");
  assert.equal(withQuirks.baseUrl, "http://localhost:8317");
  assert.equal(withQuirks.contextWindow, 1000000);

  const cleanConfig = toCleanProviderModelConfig(withQuirks, provider);
  assert.equal(cleanConfig.api, "anthropic-messages");
  assert.equal(cleanConfig.baseUrl, "http://localhost:8317");
});

test("cpa provider applies openai-completions and keeps /v1 baseUrl for gpt models", () => {
  const provider: ProviderConfigEntry = {
    id: "cpa",
    baseUrl: "http://localhost:8317/v1",
    apiKey: "test-key",
    api: "openai-completions",
    authHeader: true,
    headers: {},
    discovery: {
      type: "openai-compat",
      enabled: true,
      headers: {},
      timeoutMs: 10000,
      includeDetails: false,
      allowModels: [],
      blockModels: [],
    },
    defaults: {},
    modelDefaults: {},
    source: "auto-import",
  };

  const rawGptModel: DiscoveredModel = {
    id: "gpt-5.4",
    name: "GPT 5 4 (cpa)",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    sources: { dynamic: true },
  };

  const withQuirks = applyProviderModelQuirks(provider, rawGptModel);
  assert.equal(withQuirks.api, "openai-completions");
  assert.equal(withQuirks.baseUrl, "http://localhost:8317/v1");

  const cleanConfig = toCleanProviderModelConfig(withQuirks, provider);
  // Matches provider defaults, so not redundantly written
  assert.equal(cleanConfig.api, undefined);
  assert.equal(cleanConfig.baseUrl, undefined);
});
