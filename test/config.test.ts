import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, loadConfigAsync } from "../src/config/loader.js";
import { createTestApiKey } from "./support/secrets.js";
import { writeJson } from "./support/fixtures.js";

test("config loader defaults debug to false, resolves env refs, and warns on provider collisions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-config-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  const envApiKey = createTestApiKey("env");
  process.env.MODEL_DISCOVERY_TEST_KEY = envApiKey;
  t.after(() => {
    delete process.env.MODEL_DISCOVERY_TEST_KEY;
  });
  writeJson(modelsJsonPath, { providers: { myproxy: { models: [] } } });
  writeJson(authJsonPath, {});
  writeJson(configPath, {
    autoImport: { enabled: false },
    providers: [
      {
        id: "myproxy",
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "${MODEL_DISCOVERY_TEST_KEY}",
        api: "openai-completions",
        discovery: { type: "openai-compat" },
      },
    ],
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
  assert.equal(result.config.debug, false);
  assert.equal(result.config.maxModels, undefined);
  assert.equal(result.config.registration?.importMode, "merge");
  assert.equal(result.config.registrationOwnership?.onConflict, "merge");
  assert.equal(result.config.providers[0]?.apiKey, envApiKey);
  assert.equal(result.config.providers[0]?.maxModels, undefined);
  assert.equal(result.config.providers[0]?.source, "explicit");
  assert.ok(result.warnings.some((warning) => warning.includes("matches agent/models.json")));
});

test("auto-import does not read unrelated parent models.json files outside the agent directory", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "pi-model-discovery-parent-models-"));
  writeJson(join(homeDir, "models.json"), { object: "list", data: [] });
  const agentDir = join(homeDir, ".pi", "agent");
  const extensionRoot = join(agentDir, "extensions", "pi-model-discovery");
  mkdirSync(extensionRoot, { recursive: true });
  writeJson(join(agentDir, "auth.json"), {
    unknown: { type: "api_key", key: createTestApiKey("parent-models") },
  });

  const result = loadConfig({ extensionRoot });

  assert.equal(result.config.autoImport.modelsJsonPath, join(agentDir, "models.json"));
  assert.ok(result.warnings.some((warning) => warning.includes("models.json not found")));
  assert.equal(result.warnings.some((warning) => warning.includes("does not contain a providers object")), false);
});

test("auto-import resolves agent models/auth files when runtime extension root points at a build subdirectory", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-model-discovery-agent-root-"));
  const extensionRoot = join(agentDir, "extensions", "pi-model-discovery", "dist");
  mkdirSync(extensionRoot, { recursive: true });
  writeJson(join(agentDir, "models.json"), {
    providers: {
      blazeapi: {
        baseUrl: "https://blaze.example.invalid/api",
        api: "openai-completions",
      },
    },
  });
  const apiKey = createTestApiKey("build-root-blazeapi");
  writeJson(join(agentDir, "auth.json"), {
    blazeapi: { type: "api_key", key: apiKey },
  });

  const result = loadConfig({ extensionRoot });
  const provider = result.config.providers.find((entry) => entry.id === "blazeapi");

  assert.deepEqual(
    {
      providerBaseUrl: provider?.baseUrl,
      providerApiKey: provider?.apiKey,
      missingModelsWarning: result.warnings.some((warning) => warning.includes("models.json not found")),
    },
    {
      providerBaseUrl: "https://blaze.example.invalid/api",
      providerApiKey: apiKey,
      missingModelsWarning: false,
    },
  );
});

test("auto-import defaults on and reads eligible models.json providers with API-key auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-autoimport-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(configPath, {
    providers: [],
  });
  writeJson(modelsJsonPath, {
    providers: {
      "auto-one": {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        models: [
          {
            id: "raw/model-id",
            name: "Raw Model",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 32000,
            maxTokens: 8000,
          },
        ],
      },
      "oauth-only": {
        baseUrl: "https://oauth.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
      "unsupported-api": {
        baseUrl: "https://anthropic.example.invalid/v1",
        api: "anthropic-messages",
        models: [],
      },
      "missing-auth": {
        baseUrl: "https://missing.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  const autoOneApiKey = createTestApiKey("auto-one");
  const oauthPlaceholder = createTestApiKey("oauth-only");
  writeJson(authJsonPath, {
    "auto-one": { type: "api_key", key: autoOneApiKey },
    "oauth-only": { type: "oauth", key: oauthPlaceholder },
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
  assert.equal(result.config.providers.length, 1);
  const provider = result.config.providers[0];
  assert.equal(provider?.id, "auto-one");
  assert.equal(provider?.source, "auto-import");
  assert.equal(provider?.discovery.type, "openai-compat");
  assert.equal(provider?.modelDefaults["raw/model-id"]?.name, "Raw Model");
  assert.equal(provider?.modelDefaults["raw/model-id"]?.reasoning, true);
  assert.ok(result.warnings.some((warning) => warning.includes("oauth-only") && warning.includes("not API-key based")));
  assert.ok(result.warnings.some((warning) => warning.includes("unsupported-api") && warning.includes("unsupported api")));
  assert.ok(result.warnings.some((warning) => warning.includes("missing-auth") && warning.includes("missing API-key credential")));
});

test("auto-import skips models.json providers without auth.json credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-models-without-auth-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(configPath, {
    autoImport: {
      enabled: true,
      allowUnauthenticated: true,
    },
    providers: [],
  });
  writeJson(modelsJsonPath, {
    providers: {
      aistudio: {
        baseUrl: "http://127.0.0.1:2048/v1",
        api: "openai-completions",
        apiKey: "AISTUDIO_API_KEY",
        models: [{ id: "gemini-test" }],
      },
      cline: {
        baseUrl: "https://api.cline.example.invalid/v1",
        api: "openai-completions",
        apiKey: "CLINE_API_KEY",
        models: [{ id: "cline-test" }],
      },
      visible: {
        baseUrl: "https://visible.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  const visibleApiKey = createTestApiKey("visible-with-auth");
  writeJson(authJsonPath, {
    visible: { type: "api_key", key: visibleApiKey },
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });

  assert.deepEqual(result.config.providers.map((provider) => provider.id), ["visible"]);
  assert.equal(result.config.providers[0]?.apiKey, visibleApiKey);
  assert.equal(result.warnings.some((warning) => /aistudio|cline/.test(warning)), false);
});

test("auto-import skips providers hidden by multi-auth UI state", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-hidden-providers-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(configPath, {
    providers: [
      {
        id: "manual-hidden",
        baseUrl: "https://manual-hidden.example.invalid/v1",
        apiKey: createTestApiKey("manual-hidden"),
        api: "openai-completions",
        discovery: { type: "openai-compat" },
      },
    ],
  });
  writeJson(join(dir, "multi-auth.json"), {
    ui: {
      hiddenProviders: ["factoryai", "vivgrid", "dappit-2", "manual-hidden"],
    },
  });
  writeJson(modelsJsonPath, {
    providers: {
      factoryai: {
        baseUrl: "https://factory.example.invalid/api/llm/a",
        api: "anthropic-messages",
        models: [],
      },
      vivgrid: {
        baseUrl: "https://api.vivgrid.example/v1",
        api: "openai-completions",
        models: [],
      },
      visible: {
        baseUrl: "https://visible.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  const visibleApiKey = createTestApiKey("visible");
  writeJson(authJsonPath, {
    factoryai: { type: "api_key", key: createTestApiKey("factoryai") },
    "vivgrid-1": { type: "api_key", key: createTestApiKey("vivgrid-alias") },
    "dappit-2": { type: "oauth", key: createTestApiKey("dappit") },
    visible: { type: "api_key", key: visibleApiKey },
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });

  assert.deepEqual(result.config.autoImport.hiddenProviders, ["factoryai", "vivgrid", "dappit-2", "manual-hidden"]);
  assert.deepEqual(result.config.providers.map((provider) => provider.id), ["visible"]);
  assert.equal(result.config.providers[0]?.apiKey, visibleApiKey);
  assert.equal(result.warnings.some((warning) => /factoryai|vivgrid|dappit|manual-hidden/.test(warning)), false);
});

test("auto-import reads hidden providers from pi-multi-auth config instead of stale legacy JSON", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-model-discovery-hidden-config-agent-"));
  const extensionRoot = join(agentDir, "extensions", "pi-model-discovery");
  const multiAuthRoot = join(agentDir, "extensions", "pi-multi-auth");
  mkdirSync(extensionRoot, { recursive: true });
  mkdirSync(multiAuthRoot, { recursive: true });
  const configPath = join(extensionRoot, "config.json");
  const modelsJsonPath = join(agentDir, "models.json");
  const authJsonPath = join(agentDir, "auth.json");
  writeJson(configPath, { providers: [] });
  writeJson(join(agentDir, "multi-auth.json"), {
    ui: {
      hiddenProviders: ["legacy-hidden"],
    },
  });
  writeJson(join(multiAuthRoot, "config.json"), {
    hiddenProviders: ["config-hidden"],
  });
  writeJson(modelsJsonPath, {
    providers: {
      "legacy-hidden": {
        baseUrl: "https://legacy-hidden.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
      "config-hidden": {
        baseUrl: "https://config-hidden.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  const legacyHiddenApiKey = createTestApiKey("legacy-hidden-config");
  writeJson(authJsonPath, {
    "legacy-hidden": { type: "api_key", key: legacyHiddenApiKey },
    "config-hidden": { type: "api_key", key: createTestApiKey("config-hidden") },
  });

  const result = await loadConfigAsync({ extensionRoot, configPath });

  assert.deepEqual(result.config.autoImport.hiddenProviders, ["config-hidden"]);
  assert.deepEqual(result.config.providers.map((provider) => provider.id), ["legacy-hidden"]);
  assert.equal(result.config.providers[0]?.apiKey, legacyHiddenApiKey);
});

test("auto-import skips provider IDs owned by sibling static provider extensions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-external-static-provider-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  const commandCodeExtensionDir = join(dir, "extensions", "pi-command-code-provider");
  mkdirSync(commandCodeExtensionDir, { recursive: true });
  writeJson(configPath, {
    providers: [],
  });
  writeJson(join(commandCodeExtensionDir, "config.json"), {
    enabled: true,
    providerId: "command-code",
    models: [{ id: "gpt-5.3-codex" }],
  });
  writeJson(modelsJsonPath, {
    providers: {
      visible: {
        baseUrl: "https://visible.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  const visibleApiKey = createTestApiKey("visible-external-static");
  writeJson(authJsonPath, {
    "command-code": { type: "api_key", key: createTestApiKey("command-code") },
    visible: { type: "api_key", key: visibleApiKey },
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });

  assert.deepEqual(result.config.autoImport.externalStaticProviderIds, ["command-code"]);
  assert.deepEqual(result.config.providers.map((provider) => provider.id), ["visible"]);
  assert.equal(result.config.providers[0]?.apiKey, visibleApiKey);
  assert.equal(result.warnings.some((warning) => warning.includes("command-code")), false);
});

test("auto-import canonicalizes numbered credential aliases to one provider discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-autoimport-alias-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  writeJson(configPath, {
    providers: [],
  });
  writeJson(modelsJsonPath, {
    providers: {
      vivgrid: {
        baseUrl: "https://api.vivgrid.example/v1",
        api: "openai-completions",
        defaults: {
          contextWindow: 256_000,
        },
        models: [
          {
            id: "family-model",
            name: "Family Model",
            reasoning: true,
          },
        ],
      },
      cloudflare: {
        baseUrl: "https://api.cloudflare.com/client/v4",
        api: "openai-completions",
      },
    },
  });
  const vivgridAliasKey = createTestApiKey("vivgrid-alias");
  const cloudflareAliasKey = createTestApiKey("cloudflare-alias");
  writeJson(authJsonPath, {
    "vivgrid-1": { type: "api_key", key: vivgridAliasKey },
    "vivgrid-2": { type: "api_key", key: createTestApiKey("vivgrid-alias-2") },
    "cloudflare-1": {
      type: "api_key",
      key: cloudflareAliasKey,
      request: {
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1",
      },
    },
    "cloudflare-2": {
      type: "api_key",
      key: createTestApiKey("cloudflare-alias-2"),
      request: {
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/second-account/ai/v1",
      },
    },
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
  const vivgrid = result.config.providers.find((provider) => provider.id === "vivgrid");
  const cloudflare = result.config.providers.find((provider) => provider.id === "cloudflare");

  assert.deepEqual(
    {
      providerIds: result.config.providers.map((provider) => provider.id).sort(),
      vivgridBaseUrl: vivgrid?.baseUrl,
      vivgridApi: vivgrid?.api,
      vivgridApiKey: vivgrid?.apiKey,
      vivgridContextWindow: vivgrid?.defaults.contextWindow,
      vivgridModelName: vivgrid?.modelDefaults["family-model"]?.name,
      cloudflareBaseUrl: cloudflare?.baseUrl,
      cloudflareApiKey: cloudflare?.apiKey,
      cloudflareEndpointPath: cloudflare?.discovery.endpointPath,
      cloudflareType: cloudflare?.discovery.type,
      noisyAliasWarning: result.warnings.some((warning) => /vivgrid-\d+|cloudflare-\d+/.test(warning) && /no built-in provider profile|unsupported/i.test(warning)),
    },
    {
      providerIds: ["cloudflare", "vivgrid"],
      vivgridBaseUrl: "https://api.vivgrid.example/v1",
      vivgridApi: "openai-completions",
      vivgridApiKey: vivgridAliasKey,
      vivgridContextWindow: 256_000,
      vivgridModelName: "Family Model",
      cloudflareBaseUrl: "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1",
      cloudflareApiKey: cloudflareAliasKey,
      cloudflareEndpointPath: "https://api.cloudflare.com/client/v4/accounts/account-id/ai/models/search?per_page=100&task=Text%20Generation",
      cloudflareType: "openai-compat",
      noisyAliasWarning: false,
    },
  );
});

test("explicit providers override auto-imported providers with the same ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-discovery-override-"));
  const configPath = join(dir, "config.json");
  const modelsJsonPath = join(dir, "models.json");
  const authJsonPath = join(dir, "auth.json");
  const manualApiKey = createTestApiKey("manual");
  writeJson(configPath, {
    providers: [
      {
        id: "auto-one",
        baseUrl: "https://manual.example.invalid/v1",
        apiKey: manualApiKey,
        api: "openai-completions",
        discovery: { type: "openai-compat" },
      },
    ],
  });
  writeJson(modelsJsonPath, {
    providers: {
      "auto-one": {
        baseUrl: "https://auto.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
      "auto-two": {
        baseUrl: "https://second.example.invalid/v1",
        api: "openai-completions",
        models: [],
      },
    },
  });
  const autoOneApiKey = createTestApiKey("auto-one");
  const autoTwoApiKey = createTestApiKey("auto-two");
  writeJson(authJsonPath, {
    "auto-one": { type: "api_key", key: autoOneApiKey },
    "auto-two": { type: "api_key", key: autoTwoApiKey },
  });

  const result = loadConfig({ extensionRoot: dir, configPath, modelsJsonPath, authJsonPath });
  assert.equal(result.config.providers.length, 2);
  const overridden = result.config.providers.find((provider) => provider.id === "auto-one");
  const supplemented = result.config.providers.find((provider) => provider.id === "auto-two");
  assert.equal(overridden?.source, "explicit");
  assert.equal(overridden?.baseUrl, "https://manual.example.invalid/v1");
  assert.equal(supplemented?.source, "auto-import");
  assert.ok(result.warnings.some((warning) => warning.includes("overrides auto-imported provider")));
});
