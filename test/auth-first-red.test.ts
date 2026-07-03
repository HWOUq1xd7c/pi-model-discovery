import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionConfig, ProviderConfigEntry } from "../src/config/types.js";
import { discoverProviders } from "../src/discovery/engine.js";
import { createTestApiKey } from "./support/secrets.js";
import { assertNoSecretLeak, authFirstConfig, headersToRecord, loadWithFixtures, providerById } from "./support/fixtures.js";

const AUTH_FIRST_PREFIX = "pi-model-discovery-auth-first-red-";

function loadAuthFirstFixtures(config: unknown, modelsRoot: unknown, authRoot: unknown) {
  return loadWithFixtures(config, modelsRoot, authRoot, AUTH_FIRST_PREFIX);
}

test("auth-only API-key provider uses a built-in provider profile fallback for read-only model discovery", async (t) => {
  const nvidiaKey = createTestApiKey("auth-first-nvidia");
  const loaded = loadAuthFirstFixtures(authFirstConfig(), { providers: {} }, { nvidia: { type: "api_key", key: nvidiaKey } });

  assertNoSecretLeak("auth-only fallback warnings", loaded.warnings, [nvidiaKey]);
  const provider = providerById(loaded.config, "nvidia");
  assert.ok(provider, "auth.json-only nvidia credential should be imported using a built-in provider profile");
  assert.equal(provider.source, "auto-import");
  assert.equal(provider.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.discovery.type, "openai-compat");
  assert.equal(provider.apiKey === nvidiaKey, true, "built-in profile provider should use the auth.json credential");

  const requested: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), method: init?.method, headers: headersToRecord(init?.headers) });
    return new Response(JSON.stringify({ data: [{ id: "nvidia/llama-3.1-nemotron", name: "Nemotron" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const [discovery] = await discoverProviders({ ...loaded.config, providers: [provider] });
  assert.deepEqual(
    requested.map((request) => ({ method: request.method, url: request.url })),
    [{ method: "GET", url: "https://integrate.api.nvidia.com/v1/models" }],
  );
  assert.equal(requested[0]?.headers.authorization === `Bearer ${nvidiaKey}`, true, "model-list request should use the auth.json credential");
  assert.equal(requested.some((request) => /chat|completion/i.test(request.url.replace(/\/models(?:\?.*)?$/i, ""))), false);
  assert.equal(discovery?.models[0]?.providerModelConfig?.api, "openai-completions");
  assertNoSecretLeak("auth-only discovery contract", discovery, [nvidiaKey]);
});

test("auth plus models.json provider uses models.json metadata and auth.json credentials", async (t) => {
  const authKey = createTestApiKey("auth-first-myproxy");
  const modelsJsonKey = createTestApiKey("models-json-myproxy");
  const loaded = loadAuthFirstFixtures(
    authFirstConfig(),
    {
      providers: {
        myproxy: {
          baseUrl: "https://myproxy.example.invalid/v1",
          api: "openai-completions",
          apiKey: modelsJsonKey,
          headers: { "x-models-json": "metadata-header" },
          defaults: {
            input: ["text", "image"],
            contextWindow: 128000,
            compat: { strict: true },
          },
          models: [
            {
              id: "myproxy/model-a",
              name: "Model A from models.json",
              contextWindow: 64000,
            },
          ],
        },
      },
    },
    { myproxy: { type: "api_key", key: authKey } },
  );

  assertNoSecretLeak("auth plus models warnings", loaded.warnings, [authKey, modelsJsonKey]);
  const provider = providerById(loaded.config, "myproxy");
  assert.ok(provider, "auth+models provider should be imported");
  assert.equal(provider.apiKey === authKey, true, "auth.json credential should take precedence over models.json credential material");
  assert.equal(provider.headers["x-models-json"], "metadata-header");
  assert.deepEqual(provider.defaults.input, ["text", "image"]);
  assert.equal(provider.defaults.contextWindow, 128000);
  assert.deepEqual(provider.defaults.compat, { strict: true });
  assert.equal(provider.modelDefaults["myproxy/model-a"]?.name, "Model A from models.json");

  const requested: Array<{ url: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), headers: headersToRecord(init?.headers) });
    return new Response(JSON.stringify({ data: [{ id: "myproxy/model-a", name: "Model A live" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const [discovery] = await discoverProviders({ ...loaded.config, providers: [provider] });
  assert.equal(requested[0]?.headers.authorization === `Bearer ${authKey}`, true, "model-list request should use auth.json credential material");
  assert.equal(requested[0]?.headers["x-models-json"], "metadata-header");
  assert.equal(discovery?.provider.credentialRef, "agent-auth-json");
  assertNoSecretLeak("auth plus models discovery contract", discovery, [authKey, modelsJsonKey]);
});

test("OAuth credentials are imported only for built-in profiles that approve read-only model-list discovery", async (t) => {
  const cloudflareOauth = createTestApiKey("auth-first-cloudflare-oauth");
  const unsupportedOauth = createTestApiKey("auth-first-factoryai-oauth");
  const loaded = loadAuthFirstFixtures(
    authFirstConfig(),
    { providers: {} },
    {
      cloudflare: {
        type: "oauth",
        key: cloudflareOauth,
        request: { baseUrl: "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1" },
      },
      factoryai: { type: "oauth", key: unsupportedOauth },
    },
  );

  assertNoSecretLeak("OAuth profile warnings", loaded.warnings, [cloudflareOauth, unsupportedOauth]);
  const cloudflare = providerById(loaded.config, "cloudflare");
  assert.ok(cloudflare, "cloudflare OAuth credential should be imported because its profile allows read-only model-list discovery");
  assert.equal(providerById(loaded.config, "factoryai"), undefined, "unsupported OAuth auth-only providers should not be imported");
  assert.ok(
    loaded.warnings.some((warning) => warning.includes("factoryai") && /oauth/i.test(warning) && /unsupported|not approved|no built-in/i.test(warning)),
    "unsupported OAuth provider should be skipped with a redacted warning",
  );

  const requested: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), method: init?.method, headers: headersToRecord(init?.headers) });
    return new Response(JSON.stringify({ result: [{ name: "@cf/meta/llama-3.1-8b-instruct" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const [discovery] = await discoverProviders({ ...loaded.config, providers: [cloudflare] });
  assert.equal(requested[0]?.method, "GET");
  assert.match(requested[0]?.url ?? "", /\/ai\/models\/search\?per_page=100&task=Text%20Generation$/);
  assert.equal(requested[0]?.headers.authorization === `Bearer ${cloudflareOauth}`, true, "OAuth credential should be used only for the approved model-list endpoint");
  assert.equal(requested.some((request) => /chat|completion/i.test(request.url)), false, "OAuth discovery must not call generation endpoints");
  assert.equal(discovery?.models[0]?.id, "@cf/meta/llama-3.1-8b-instruct");
  assertNoSecretLeak("OAuth discovery contract", discovery, [cloudflareOauth, unsupportedOauth]);
});

test("Pi Mono managed providers with user credentials are not auto-imported for discovery", () => {
  const openaiKey = createTestApiKey("auth-first-openai");
  const loaded = loadAuthFirstFixtures(
    authFirstConfig(),
    {
      providers: {
        openai: {
          baseUrl: "https://api.openai.example.invalid/v1",
          api: "openai-completions",
          models: [],
        },
      },
    },
    { openai: { type: "api_key", key: openaiKey } },
  );

  assert.equal(providerById(loaded.config, "openai"), undefined, "openai should remain owned by Pi Mono when auth.json has user credentials");
  assert.equal(loaded.config.registrationOwnership?.managedProviderIds.has("openai"), true);
  assertNoSecretLeak("Pi Mono skip warnings", loaded.warnings, [openaiKey]);
});

test("unsupported auth-only providers are skipped with a redacted warning", () => {
  const unsupportedKey = createTestApiKey("auth-first-unsupported");
  const loaded = loadAuthFirstFixtures(authFirstConfig(), { providers: {} }, { "unknown-auth-only": { type: "api_key", key: unsupportedKey } });

  assert.equal(providerById(loaded.config, "unknown-auth-only"), undefined);
  assert.ok(
    loaded.warnings.some((warning) => warning.includes("unknown-auth-only") && /unsupported|no built-in provider profile/i.test(warning)),
    "unsupported auth-only provider should be explicitly skipped with a redacted warning",
  );
  assertNoSecretLeak("unsupported auth-only warnings", loaded.warnings, [unsupportedKey]);
});
