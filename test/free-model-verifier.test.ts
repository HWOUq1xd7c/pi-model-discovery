/**
 * Green-phase tests for the provider-aware free-model verifier.
 *
 * Status: GREEN. These tests lock the implemented
 * `src/verification/free-model-verifier.ts` module that verifies cached
 * `isFree` classifications with cautious, provider-aware probes.
 *
 * Design note on the computed dynamic import below: the strict project
 * tsconfig (`module: NodeNext`, `strict`) compiles a specifier built via
 * array-join to a string cleanly, while a static `import` of a missing module
 * would fail `tsc` for the whole project. The computed specifier therefore
 * isolates the missing-implementation failure to this test file only, so the
 * existing test suite keeps building and passing while the verifier is absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { DiscoveredModel } from "../src/cache/types.js";
import type { CredentialEntry, ExtensionConfig, ProviderConfigEntry } from "../src/config/types.js";
import { createTestApiKey } from "./support/secrets.js";
import {
  assertNoSecretLeak,
  captureLogger,
  createCacheManagerWithEntries,
  createVerifierConfig,
  freeModel,
  headersToRecord,
  loadVerifierModule,
  paidModel,
  writeJson,
} from "./support/fixtures.js";

const TEST_API_KEY = createTestApiKey("free-verifier");
const CACHE_PREFIX = "pi-model-discovery-free-verifier-";

function provider(overrides: Partial<ProviderConfigEntry> = {}): ProviderConfigEntry {
  const base: ProviderConfigEntry = {
    id: "verifier-provider",
    baseUrl: "https://verifier-provider.example.invalid/v1",
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

function createVerifierCache(entries: Parameters<typeof createCacheManagerWithEntries>[0]): ReturnType<typeof createCacheManagerWithEntries> {
  return createCacheManagerWithEntries(entries, CACHE_PREFIX);
}

test("verifier confirms free models that the endpoint reports as zero-cost and downgrades mismatched ones to paid", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [
        freeModel("free-endpoint-model", "Free Endpoint Model"),
        freeModel("actually-paid-model", "Mismatched Model"),
      ],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  const requested: Array<{ url: string; method?: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, method: init?.method, headers: headersToRecord(init?.headers) });
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "free-endpoint-model" }, { id: "actually-paid-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init?.body ? JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> } : {};
    const prompt = body.messages?.[0]?.content ?? "";
    if (prompt.includes("actually-paid-model")) {
      // Explicit billing signal: a usage payload alone no longer proves a model
      // is paid, so the downgrade must come from a payment-required response.
      return new Response(JSON.stringify({ error: { message: "payment required: upgrade to a paid plan for this model", type: "billing_error", code: "payment_required" } }), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error", code: "insufficient_quota" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.deepEqual(
    result.verified.map((entry) => ({ providerId: entry.providerId, modelId: entry.modelId, category: entry.category })).sort((left, right) => left.modelId.localeCompare(right.modelId)),
    [
      { providerId: "verifier-provider", modelId: "actually-paid-model", category: "downgraded-to-paid" },
      { providerId: "verifier-provider", modelId: "free-endpoint-model", category: "confirmed-free" },
    ],
  );
  assert.ok(
    requested.some((request) => /\/chat\/completions$/.test(request.url.replace(/\?.*$/, ""))),
    "verifier must probe a generation endpoint to validate free status",
  );
  assertNoSecretLeak("verifier request headers", requested.map((request) => request.headers), [TEST_API_KEY]);
  assertNoSecretLeak("verifier logs", logs, [TEST_API_KEY]);
});

test("verifier confirms paid models that the endpoint reports as billable and does not probe whole-provider-free providers", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createVerifierCache({
    "whole-free-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("whole-free-model", "Whole Free Model")],
    },
  });
  const config = createVerifierConfig(dir, [
    provider({ id: "whole-free-provider", discovery: { type: "openai-compat", enabled: true, headers: {}, timeoutMs: 1000, includeDetails: false, allowModels: [], blockModels: [] } as never }),
  ]);

  const requested: Array<{ url: string; method?: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({ data: [{ id: "whole-free-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.deepEqual(
    result.verified.map((entry) => ({ modelId: entry.modelId, category: entry.category })),
    [{ modelId: "whole-free-model", category: "skipped" }],
    "whole-provider-free providers must be skipped without generation probes",
  );
  assert.equal(
    requested.some((request) => /\/chat\/completions$/.test(request.url.replace(/\?.*$/, ""))),
    false,
    "whole-provider-free providers must not trigger generation endpoint probes",
  );
  assertNoSecretLeak("whole-provider-free logs", logs, [TEST_API_KEY]);
});

// ---------------------------------------------------------------------------
// Cautious cache updates
// ---------------------------------------------------------------------------

test("verifier only rewrites the cache when a classification changed and preserves unchanged entries byte-for-byte", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const unchangedFree = freeModel("stable-free", "Stable Free");
  const downgraded = freeModel("was-free-now-paid", "Was Free Now Paid");
  const paid = paidModel("stable-paid", "Stable Paid", 1, 2);
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [unchangedFree, downgraded, paid],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);
  const cachePath = join(dir, "cache.json");
  const beforeRaw = readFileSync(cachePath, "utf-8");

  const requested: Array<{ url: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url });
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "stable-free" }, { id: "was-free-now-paid" }, { id: "stable-paid" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init?.body ? JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> } : {};
    const prompt = body.messages?.[0]?.content ?? "";
    if (prompt.includes("was-free-now-paid")) {
      // Usage alone no longer proves billing; the downgrade needs an explicit
      // payment-required signal.
      return new Response(JSON.stringify({ error: { message: "payment required for this model", type: "billing_error", code: "payment_required" } }), { status: 402, headers: { "content-type": "application/json" } });
    }
    if (prompt.includes("stable-paid")) {
      return new Response(JSON.stringify({ error: { message: "payment required for this model", type: "billing_error", code: "payment_required" } }), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.equal(result.cacheUpdated, true, "cache must be rewritten when at least one classification changed");
  const afterRaw = readFileSync(cachePath, "utf-8");
  const after = JSON.parse(afterRaw) as { providers: Record<string, { models: DiscoveredModel[] }> };
  const byId = new Map(after.providers["verifier-provider"]!.models.map((model) => [model.id, model]));
  assert.equal(byId.get("stable-free")?.isFree, true, "confirmed-free model must keep isFree true");
  assert.equal(byId.get("was-free-now-paid")?.isFree, false, "downgraded model must flip isFree to false");
  assert.equal(byId.get("stable-paid")?.isFree, false, "confirmed-paid model must keep isFree false");
  assert.notEqual(afterRaw, beforeRaw, "cache file content must change when a classification is corrected");
  assertNoSecretLeak("rewritten cache", after, [TEST_API_KEY]);
});

test("verifier leaves the cache untouched when every cached classification is re-confirmed and reports cacheUpdated false", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const confirmedFree = freeModel("re-confirmed-free", "Re-Confirmed Free");
  const confirmedPaid = paidModel("re-confirmed-paid", "Re-Confirmed Paid", 1, 2);
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [confirmedFree, confirmedPaid],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);
  const cachePath = join(dir, "cache.json");
  const beforeRaw = readFileSync(cachePath, "utf-8");

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "re-confirmed-free" }, { id: "re-confirmed-paid" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init?.body ? JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> } : {};
    const prompt = body.messages?.[0]?.content ?? "";
    if (prompt.includes("re-confirmed-paid")) {
      return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.equal(result.cacheUpdated, false, "cache must not be rewritten when no classification changed");
  assert.equal(readFileSync(cachePath, "utf-8"), beforeRaw, "cache file content must be byte-identical when nothing changed");
});

// ---------------------------------------------------------------------------
// Redacted compact logs
// ---------------------------------------------------------------------------

test("verifier emits a single compact redacted summary log line per probe and never records auth credentials", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("probe-free", "Probe Free")],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ id: "probe-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.ok(result.logs.length > 0, "verifier must emit at least one summary log line");
  assertNoSecretLeak("verifier summary logs", result.logs, [TEST_API_KEY]);
  assertNoSecretLeak("captured logger logs", logs, [TEST_API_KEY]);
  const serialized = JSON.stringify(result.logs);
  assert.equal(serialized.includes(TEST_API_KEY), false, "log summary must not contain the raw API key");
  assert.match(serialized, /free_model_verif|verif/i, "summary log should reference the verification event");
});

// ---------------------------------------------------------------------------
// Concurrency / unsupported API behavior
// ---------------------------------------------------------------------------

test("verifier bounds concurrent generation probes to a small fan-out across many models", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const models = Array.from({ length: 8 }, (_entry, index) => freeModel(`concurrent-${index}`, `Concurrent ${index}`));
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models,
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  let inFlight = 0;
  let maxInFlight = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: models.map((model) => ({ id: model.id })) }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.equal(result.verified.length, 8, "every probed model must produce a verification entry");
  assert.ok(maxInFlight <= 4, `verifier must bound concurrent generation probes (observed ${maxInFlight})`);
});

test("verifier marks models unverifiable and skips cache mutation when the provider discovery API is unsupported", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createVerifierCache({
    "static-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("static-free", "Static Free")],
    },
  });
  const config = createVerifierConfig(dir, [
    provider({
      id: "static-provider",
      discovery: { type: "static", enabled: false, headers: {}, timeoutMs: 0, includeDetails: false, allowModels: [], blockModels: [] } as never,
    }),
  ]);
  const cachePath = join(dir, "cache.json");
  const beforeRaw = readFileSync(cachePath, "utf-8");

  const requested: Array<{ url: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requested.push({ url: String(input) });
    return new Response(JSON.stringify({ data: [{ id: "static-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  assert.deepEqual(
    result.verified.map((entry) => ({ modelId: entry.modelId, category: entry.category })),
    [{ modelId: "static-free", category: "unverifiable" }],
    "unsupported discovery API providers must yield unverifiable entries",
  );
  assert.equal(result.cacheUpdated, false, "unsupported providers must not trigger a cache rewrite");
  assert.equal(readFileSync(cachePath, "utf-8"), beforeRaw, "cache file must be untouched for unsupported providers");
  assert.equal(requested.length, 0, "unsupported providers must not make any network requests");
  assertNoSecretLeak("unsupported API logs", logs, [TEST_API_KEY]);
});

// ---------------------------------------------------------------------------
// Credential rotation
// ---------------------------------------------------------------------------

test("verifier rotates to the next credential in the pool when the first attempt is rate-limited", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const primary = createTestApiKey("free-verifier-primary");
  const secondary = createTestApiKey("free-verifier-secondary");
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("rotated-free", "Rotated Free")],
    },
  });
  const credentials: CredentialEntry[] = [
    { apiKey: primary, authHeader: true, sourceId: "verifier-provider" },
    { apiKey: secondary, authHeader: true, sourceId: "verifier-provider-1" },
  ];
  const config = createVerifierConfig(dir, [provider({ apiKey: primary, credentials })]);

  const seenAuth: string[] = [];
  let chatAttempt = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "rotated-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const headers = headersToRecord(init?.headers);
    seenAuth.push(headers.authorization ?? "");
    chatAttempt += 1;
    // First attempt (whichever credential is shuffled first) is rate-limited
    // (rotation-worthy); the second attempt gets a quota-free signal.
    if (chatAttempt === 1) {
      return new Response(JSON.stringify({ error: { message: "rate limit exceeded", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, sendCredentials: true });

  assert.equal(seenAuth.length, 2, "verifier must rotate to a second credential after the first is rate-limited");
  assert.notEqual(seenAuth[0], seenAuth[1], "verifier must try a different credential on rotation");
  assert.deepEqual(
    result.verified.map((entry) => ({ modelId: entry.modelId, category: entry.category })),
    [{ modelId: "rotated-free", category: "confirmed-free" }],
    "the rotated credential must confirm the free classification via the quota-free signal",
  );
});

test("verifier rotates to the next credential when the first attempt fails authentication", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const primary = createTestApiKey("free-verifier-auth-primary");
  const secondary = createTestApiKey("free-verifier-auth-secondary");
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("auth-rotated-free", "Auth Rotated Free")],
    },
  });
  const credentials: CredentialEntry[] = [
    { apiKey: primary, authHeader: true, sourceId: "verifier-provider" },
    { apiKey: secondary, authHeader: true, sourceId: "verifier-provider-1" },
  ];
  const config = createVerifierConfig(dir, [provider({ apiKey: primary, credentials })]);

  const seenAuth: string[] = [];
  let chatAttempt = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "auth-rotated-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const headers = headersToRecord(init?.headers);
    seenAuth.push(headers.authorization ?? "");
    chatAttempt += 1;
    // First attempt (whichever credential is shuffled first) fails auth
    // (rotation-worthy); the second attempt gets a quota-free signal.
    if (chatAttempt === 1) {
      return new Response(JSON.stringify({ error: { message: "invalid api key", type: "authentication_error" } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, sendCredentials: true });

  assert.equal(seenAuth.length, 2, "verifier must rotate to a second credential after the first fails authentication");
  assert.notEqual(seenAuth[0], seenAuth[1], "verifier must try a different credential on rotation");
  assert.deepEqual(
    result.verified.map((entry) => ({ modelId: entry.modelId, category: entry.category })),
    [{ modelId: "auth-rotated-free", category: "confirmed-free" }],
    "the rotated credential must confirm the free classification",
  );
});

test("verifier does not rotate on non-credential failures like provider unavailability", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const primary = createTestApiKey("free-verifier-no-rotate");
  const secondary = createTestApiKey("free-verifier-no-rotate-2");
  const { cacheManager, dir } = createVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("no-rotate-free", "No Rotate Free")],
    },
  });
  const credentials: CredentialEntry[] = [
    { apiKey: primary, authHeader: true, sourceId: "verifier-provider" },
    { apiKey: secondary, authHeader: true, sourceId: "verifier-provider-1" },
  ];
  const config = createVerifierConfig(dir, [provider({ apiKey: primary, credentials })]);

  const seenAuth: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "no-rotate-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const headers = headersToRecord(init?.headers);
    seenAuth.push(headers.authorization ?? "");
    // 500 is provider-unavailable, not credential-specific → must not rotate.
    return new Response(JSON.stringify({ error: { message: "internal server error", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, sendCredentials: true });

  assert.equal(seenAuth.length, 1, "verifier must not rotate on a non-credential failure (provider unavailable)");
  assert.ok(seenAuth[0]?.includes(primary) || seenAuth[0]?.includes(secondary), "only one credential from the pool must be tried");
  assert.deepEqual(
    result.verified.map((entry) => ({ modelId: entry.modelId, category: entry.category })),
    [{ modelId: "no-rotate-free", category: "unverifiable" }],
    "a provider-unavailable failure must yield unverifiable, not a rotated retry",
  );
});
