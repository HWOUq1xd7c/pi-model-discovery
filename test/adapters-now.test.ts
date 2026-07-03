import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionConfig, ProviderConfigEntry } from "../src/config/types.js";
import { discoverProviders } from "../src/discovery/engine.js";
import { createTestApiKey } from "./support/secrets.js";
import { configFor } from "./support/fixtures.js";

const TEST_API_KEY = createTestApiKey("now-adapters");

type FutureDiscoveryType =
  | ProviderConfigEntry["discovery"]["type"]
  | "anthropic-compatible"
  | "openai-responses"
  | "lm-studio"
  | "llama-cpp";

interface AdapterCase {
  discoveryType: FutureDiscoveryType;
  api: string;
  baseUrl: string;
  authHeader: boolean;
  payload: unknown;
  expectedId: string;
  expectedName: string;
  expectedPath: string;
}

function providerFor(testCase: AdapterCase): ProviderConfigEntry {
  return {
    id: `now-${testCase.discoveryType}`,
    baseUrl: testCase.baseUrl,
    apiKey: TEST_API_KEY,
    api: testCase.api as ProviderConfigEntry["api"],
    authHeader: testCase.authHeader,
    headers: {},
    maxModels: 10,
    discovery: {
      type: testCase.discoveryType as ProviderConfigEntry["discovery"]["type"],
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
}

const adapterCases: AdapterCase[] = [
  {
    discoveryType: "anthropic-compatible",
    api: "anthropic-messages",
    baseUrl: "https://anthropic.example.invalid/v1",
    authHeader: true,
    payload: { data: [{ id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet" }] },
    expectedId: "claude-3-5-sonnet-20241022",
    expectedName: "Claude 3.5 Sonnet",
    expectedPath: "/v1/models",
  },
  {
    discoveryType: "openai-responses",
    api: "openai-responses",
    baseUrl: "https://api.openai.example.invalid/v1",
    authHeader: true,
    payload: { data: [{ id: "gpt-5.1", name: "GPT 5.1", owned_by: "openai" }] },
    expectedId: "gpt-5.1",
    expectedName: "GPT 5.1",
    expectedPath: "/v1/models",
  },
  {
    discoveryType: "lm-studio",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1234/v1",
    authHeader: false,
    payload: { data: [{ id: "lmstudio-community/qwen3-4b", name: "Qwen3 4B" }] },
    expectedId: "lmstudio-community/qwen3-4b",
    expectedName: "Qwen3 4B",
    expectedPath: "/v1/models",
  },
  {
    discoveryType: "llama-cpp",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    authHeader: false,
    payload: { data: [{ id: "llama.cpp/default", name: "llama.cpp Local" }] },
    expectedId: "llama.cpp/default",
    expectedName: "llama.cpp Local",
    expectedPath: "/v1/models",
  },
];

for (const testCase of adapterCases) {
  test(`dispatches ${testCase.discoveryType} discovery through a pluggable adapter and normalizes output`, async (t) => {
    const requestedUrls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify(testCase.payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = providerFor(testCase);
    const [result] = await discoverProviders(configFor(provider));

    assert.equal(requestedUrls.length, 1, `${testCase.discoveryType} adapter should perform exactly one discovery request`);
    assert.ok(requestedUrls[0]?.endsWith(testCase.expectedPath), `${testCase.discoveryType} adapter should use the expected default model endpoint`);
    assert.equal(result?.authoritative, true);
    assert.deepEqual(result?.warnings, []);
    assert.equal(result?.models[0]?.id, testCase.expectedId);
    assert.equal(result?.models[0]?.name, testCase.expectedName);
  });
}
