import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionConfig, ProviderConfigEntry } from "../src/config/types.js";
import { discoverProviders } from "../src/discovery/engine.js";
import { createTestApiKey } from "./support/secrets.js";
import { configFor } from "./support/fixtures.js";

const TEST_API_KEY = createTestApiKey("now-contract");

function provider(overrides: Partial<ProviderConfigEntry> = {}): ProviderConfigEntry {
  return {
    id: "contract-provider",
    baseUrl: "https://contract.example.invalid/v1",
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

async function discoverOne(entry = provider()): Promise<unknown> {
  const results = await discoverProviders(configFor(entry));
  return results[0];
}

test("formal discovery contract redacts credential material from provider output", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [{ id: "safe-model", name: "Safe Model" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const result = await discoverOne();
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes(TEST_API_KEY), false, "discovery output contract must not expose raw provider apiKey values");
});

test("formal discovery contract declares Pi ProviderModelConfig, models.json, and pi-multi-auth compatibility", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ data: [{ id: "contract-model", name: "Contract Model", owned_by: "contract" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  const result = (await discoverOne(provider({ apiKey: "redacted-test-placeholder", authHeader: false }))) as {
    contractVersion?: number;
    provider?: { id?: string; api?: string; baseUrl?: string; source?: string; credentialRef?: string };
    compatibility?: {
      providerModelConfig?: "compatible";
      modelsJson?: "compatible";
      piMultiAuth?: "compatible";
    };
    models?: Array<{ id?: string; providerModelConfig?: { id?: string; name?: string; api?: string } }>;
  };

  assert.equal(result.contractVersion, 1);
  assert.deepEqual(result.provider, {
    id: "contract-provider",
    api: "openai-completions",
    baseUrl: "https://contract.example.invalid/v1",
    source: "explicit",
    credentialRef: "extension-config",
  });
  assert.deepEqual(result.compatibility, {
    providerModelConfig: "compatible",
    modelsJson: "compatible",
    piMultiAuth: "compatible",
  });
  assert.equal(result.models?.[0]?.providerModelConfig?.id, "contract-model");
  assert.equal(result.models?.[0]?.providerModelConfig?.name, "Contract Model");
  assert.equal(result.models?.[0]?.providerModelConfig?.api, "openai-completions");
});
