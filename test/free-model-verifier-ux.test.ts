/**
 * Green-phase tests for verifier CLI/operator UX improvements.
 *
 * Status: GREEN. These tests lock the implemented UX features for the
 * `pi-model-discovery` free-model verifier:
 *   - `--help`, `--dry-run`, `--provider`, `--model`, `--concurrency`,
 *     `--json`, `--strict` CLI flags on `scripts/verify-free-models.mjs`
 *   - credential warning / opt-out (`sendCredentials: false` honored by the
 *     script and surfaced to the operator)
 *   - actionable reason hints (operator-readable, not opaque machine codes)
 *   - visible result summary with category counts and timing
 *
 * The verifier implementation module (`src/verification/free-model-verifier.ts`)
 * already exists and passes its provider-aware suite; these tests extend its
 * surface with UX-layer expectations and guard against regressions in CLI
 * parsing, credential warnings, strict mode, JSON summaries, and dry-run behavior.
 *
 * Determinism / network safety:
 *   - Module tests use `t.mock.method(globalThis, "fetch")` only.
 *   - CLI spawn tests run the script in an ISOLATED temp extension root that
 *     contains a no-network `config.json` (`autoImport.enabled:false`,
 *     `providers:[]`) and no agent-level `auth.json`/`models.json`, so no real
 *     credentials are loaded and no live network call is attempted. No auth
 *     secrets are ever read or printed by these tests.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { CACHE_SCHEMA_VERSION } from "../src/cache/json-store.js";
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
import { isRecord } from "../src/shared/validation.js";
import type { ProviderConfigEntry } from "../src/config/types.js";

const TEST_API_KEY = createTestApiKey("free-verifier-ux");
const CACHE_PREFIX = "pi-model-discovery-free-verifier-ux-";

// The compiled test lives at <extensionRoot>/dist/test/*.js, so the extension
// root is three dirname hops up from import.meta.url. (Source layout is
// <root>/test/*.ts, two hops; the extra hop accounts for the dist/ outDir.)
const EXTENSION_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT_PATH = join(EXTENSION_ROOT, "scripts", "verify-free-models.mjs");
const DIST_SRC_DIR = join(EXTENSION_ROOT, "dist", "src");

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

function createUxVerifierCache(entries: Parameters<typeof createCacheManagerWithEntries>[0]): ReturnType<typeof createCacheManagerWithEntries> {
  return createCacheManagerWithEntries(entries, CACHE_PREFIX);
}

/**
 * Build an isolated temp extension root for CLI spawn tests.
 *
 * Copies the built `dist/src` tree and the verifier script into a temp dir and
 * writes a no-network `config.json` (`autoImport.enabled:false`, `providers:[]`)
 * with no agent-level `auth.json`/`models.json` nearby, so the spawned process
 * loads zero providers and never reaches the network. No real credentials are
 * ever loaded, read, or printed.
 */
function createIsolatedExtensionRoot(): { root: string; scriptPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-md-ux-cli-"));
  const distDir = join(dir, "dist");
  const distSrcTarget = join(distDir, "src");
  copyTree(DIST_SRC_DIR, distSrcTarget);
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, "verify-free-models.mjs");
  writeFileSync(scriptPath, readScriptSource(), "utf-8");
  writeJson(join(dir, "config.json"), { debug: false, cacheTTL: 60_000, autoImport: { enabled: false }, providers: [] });
  writeJson(join(dir, "cache.json"), { version: CACHE_SCHEMA_VERSION, updatedAt: new Date().toISOString(), providers: {} });
  return { root: dir, scriptPath };
}

function copyTree(source: string, target: string): void {
  // Recursive copy; create each target directory so nested files land.
  mkdirSync(target, { recursive: true });
  const entries = readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

function readScriptSource(): string {
  // Re-read the script from its source so the temp copy stays in sync with the
  // working tree (these tests assert against the implemented UX behavior).
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(`verifier script not found at ${SCRIPT_PATH}; run \`npm run build\` first`);
  }
  // The script computes extensionRoot from its own location; copying it verbatim
  // into the temp scripts/ dir keeps that resolution pointed at the temp root.
  return readFileSync(SCRIPT_PATH, "utf-8");
}

function runScript(scriptPath: string, args: string[], cwd: string, timeoutMs = 8_000): { stdout: string; stderr: string; status: number | null; timedOut: boolean } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
    env: { ...process.env, PI_MODEL_DISCOVERY_CACHE_ONLY: "1" },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    timedOut: result.signal === "SIGTERM" || result.signal === "SIGKILL",
  };
}

// ===========================================================================
// CLI: --help
// ===========================================================================

test("--help prints usage and exits 0 without touching the network", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--help"], root);
    assert.equal(run.timedOut, false, "--help must exit promptly instead of hanging on network");
    assert.equal(run.status, 0, `--help must exit 0; got status=${run.status}\nstderr:\n${run.stderr}`);
    assert.match(run.stdout, /--help/i, "--help output must document the --help flag");
    assert.match(run.stdout, /--dry-run/i, "--help output must document --dry-run");
    assert.match(run.stdout, /--provider/i, "--help output must document --provider");
    assert.match(run.stdout, /--model/i, "--help output must document --model");
    assert.match(run.stdout, /--concurrency/i, "--help output must document --concurrency");
    assert.match(run.stdout, /--json/i, "--help output must document --json");
    assert.match(run.stdout, /--strict/i, "--help output must document --strict");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--help output warns about credential transmission and documents the opt-out", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--help"], root);
    assert.equal(run.status, 0, `--help must exit 0; got status=${run.status}`);
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /credential|api[_ -]?key|auth/i, "--help must surface a credential warning so operators know requests carry auth material");
    assert.match(out, /--no-credentials|sendCredentials|opt[_ -]?out/i, "--help must document a credential opt-out flag for operators who want anonymous probes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// CLI: --dry-run (no cache mutation, no network generation probes required)
// ===========================================================================

test("--dry-run exits 0 without mutating the cache and reports a summary", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const cachePath = join(root, "cache.json");
    const before = readFileSync(cachePath, "utf-8");
    const run = runScript(scriptPath, ["--dry-run"], root);
    assert.equal(run.timedOut, false, "--dry-run must exit promptly without hanging on network");
    assert.equal(run.status, 0, `--dry-run must exit 0; got status=${run.status}\nstderr:\n${run.stderr}`);
    assert.equal(readFileSync(cachePath, "utf-8"), before, "--dry-run must not rewrite the cache file");
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /verif|summary|model/i, "--dry-run must emit a human-readable summary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// CLI: --provider and --model filters
// ===========================================================================

test("--provider restricts verification to a single provider id", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--provider", "does-not-exist", "--dry-run"], root);
    assert.equal(run.timedOut, false, "filtered --dry-run must exit promptly");
    assert.equal(run.status, 0, `--provider with --dry-run must exit 0; got status=${run.status}`);
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /0\s+(model|verif)|no\s+(model|provider)|does-not-exist|nothing/i, "--provider filter with a non-matching id must report zero models verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--model restricts verification to a single model id", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--model", "missing-model", "--dry-run"], root);
    assert.equal(run.timedOut, false, "filtered --dry-run must exit promptly");
    assert.equal(run.status, 0, `--model with --dry-run must exit 0; got status=${run.status}`);
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /0\s+(model|verif)|no\s+(model|provider)|missing-model|nothing/i, "--model filter with a non-matching id must report zero models verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// CLI: --concurrency
// ===========================================================================

test("--concurrency accepts a positive integer and is reflected in --help", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const helpRun = runScript(scriptPath, ["--help"], root);
    assert.match(helpRun.stdout, /--concurrency\s+<n>|--concurrency\s+<number>|--concurrency\s+\d/i, "--help must show --concurrency takes a numeric value");
    const run = runScript(scriptPath, ["--concurrency", "2", "--dry-run"], root);
    assert.equal(run.timedOut, false, "--concurrency --dry-run must exit promptly");
    assert.equal(run.status, 0, `--concurrency 2 --dry-run must exit 0; got status=${run.status}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--concurrency rejects non-numeric values with a clear error and non-zero exit", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--concurrency", "not-a-number", "--dry-run"], root);
    assert.equal(run.timedOut, false, "bad --concurrency must fail fast without hanging");
    assert.notEqual(run.status, 0, "invalid --concurrency must exit non-zero");
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /concurrency|invalid|number|integer/i, "invalid --concurrency must produce an actionable error mentioning the flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// CLI: --json
// ===========================================================================

test("--json emits machine-readable output and exits 0", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--json", "--dry-run"], root);
    assert.equal(run.timedOut, false, "--json --dry-run must exit promptly");
    assert.equal(run.status, 0, `--json --dry-run must exit 0; got status=${run.status}`);
    // The whole stdout must be a single JSON document (summary shape).
    let parsed: unknown = undefined;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(run.stdout.trim());
    }, `--json stdout must be valid JSON; got:\n${run.stdout}`);
    assert.ok(isRecord(parsed), "--json output must be a JSON object");
    assert.ok("summary" in parsed || "verified" in parsed || "cacheUpdated" in parsed, "--json output must contain a recognizable summary/verified/cacheUpdated field");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// CLI: --strict
// ===========================================================================

test("--strict makes unverifiable entries cause a non-zero exit code", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    // With zero providers/models, strict mode must surface a non-zero exit
    // (nothing could be verified to a definitive free/paid state).
    const run = runScript(scriptPath, ["--strict", "--dry-run"], root);
    assert.equal(run.timedOut, false, "--strict --dry-run must exit promptly");
    assert.notEqual(run.status, 0, "--strict must fail when no model can be verified to a definitive category");
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /strict|unverif|could not/i, "--strict failure must reference strict/unverifiable status");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// CLI: unknown flag handling
// ===========================================================================

test("unknown flags are rejected with a clear error and non-zero exit, not silently ignored", () => {
  const { root, scriptPath } = createIsolatedExtensionRoot();
  try {
    const run = runScript(scriptPath, ["--bogus-flag", "--dry-run"], root);
    assert.equal(run.timedOut, false, "unknown flag must fail fast without hanging");
    assert.notEqual(run.status, 0, "unknown flag must exit non-zero");
    const out = `${run.stdout}\n${run.stderr}`;
    assert.match(out, /unknown|unrecognized|invalid|--bogus-flag/i, "unknown flag must produce an actionable error naming the bad flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// Module: --dry-run option honored (no cache mutation, probes still computed)
// ===========================================================================

test("dryRun:true reports verification decisions but never rewrites the cache", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const downgraded = freeModel("was-free-now-paid", "Was Free Now Paid");
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [downgraded],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);
  const cachePath = join(dir, "cache.json");
  const before = readFileSync(cachePath, "utf-8");

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "was-free-now-paid" }] }), { status: 200, headers: { "content-type": "application/json" } });
    // Explicit billing signal: a usage payload alone no longer proves a model
    // is paid, so the downgrade must come from a payment-required response.
    return new Response(JSON.stringify({ error: { message: "payment required for this model", type: "billing_error", code: "payment_required" } }), { status: 402, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, dryRun: true });

  assert.equal(result.cacheUpdated, false, "dryRun must report cacheUpdated:false even when a classification would change");
  assert.equal(readFileSync(cachePath, "utf-8"), before, "dryRun must leave the cache byte-identical");
  assert.deepEqual(
    result.verified.map((entry) => entry.category),
    ["downgraded-to-paid"],
    "dryRun must still compute and report the would-be category so operators can preview changes",
  );
});

// ===========================================================================
// Module: provider/model filters
// ===========================================================================

test("provider filter restricts probing to the named provider and skips the rest", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("keep-model", "Keep Model")],
    },
    "other-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("skip-model", "Skip Model")],
    },
  });
  const config = createVerifierConfig(dir, [
    provider({ id: "verifier-provider" }),
    provider({ id: "other-provider", baseUrl: "https://other-provider.example.invalid/v1" }),
  ]);

  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "keep-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, provider: "verifier-provider" });

  const providerIds = new Set(result.verified.map((entry) => entry.providerId));
  assert.deepEqual([...providerIds], ["verifier-provider"], "provider filter must exclude entries from other providers");
  assert.equal(requested.some((url) => /other-provider/.test(url)), false, "provider filter must not issue any requests against the excluded provider");
});

test("model filter restricts probing to the named model id across providers", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("target-model", "Target"), freeModel("other-model", "Other")],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  const probedModels: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "target-model" }, { id: "other-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
    probedModels.push(body.model ?? "");
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, model: "target-model" });

  assert.deepEqual(result.verified.map((entry) => entry.modelId), ["target-model"], "model filter must produce a verification entry only for the named model");
  assert.deepEqual(probedModels, ["target-model"], "model filter must probe only the named model id");
});

// ===========================================================================
// Module: --concurrency honored
// ===========================================================================

test("concurrency option overrides the default fan-out cap", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const models = Array.from({ length: 8 }, (_entry, index) => freeModel(`concurrent-${index}`, `Concurrent ${index}`));
  const { cacheManager, dir } = createUxVerifierCache({
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
  await verifyFreeModels({ config, cacheManager, logger, concurrency: 2 });

  assert.ok(maxInFlight <= 2, `concurrency:2 must bound fan-out to 2 (observed ${maxInFlight})`);
});

// ===========================================================================
// Module: credential warning / opt-out (sendCredentials:false honored)
// ===========================================================================

test("sendCredentials:false strips auth headers from every probe request", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("probe-free", "Probe Free")],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  const requested: Array<{ url: string; headers: Record<string, string> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(input), headers: headersToRecord(init?.headers) });
    const url = String(input);
    if (/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ id: "probe-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  await verifyFreeModels({ config, cacheManager, logger, sendCredentials: false });

  assert.ok(requested.length > 0, "at least one request must be issued");
  for (const request of requested) {
    assertNoSecretLeak("opt-out request headers", request.headers, [TEST_API_KEY]);
    assert.equal(request.headers.authorization ?? request.headers["api-key"], undefined, "sendCredentials:false must remove all auth headers from outbound requests");
  }
  assertNoSecretLeak("opt-out logs", logs, [TEST_API_KEY]);
});

test("verifier logs a visible credential-transmission warning when sendCredentials defaults to true", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("probe-free", "Probe Free")],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ id: "probe-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  await verifyFreeModels({ config, cacheManager, logger });

  const serialized = JSON.stringify(logs);
  assert.match(serialized, /credential|api[_ -]?key|auth|sendCredentials/i, "when credentials are transmitted the verifier must emit a visible operator-facing credential warning");
  assertNoSecretLeak("credential-warning logs", logs, [TEST_API_KEY]);
});

// ===========================================================================
// Module: actionable reason hints
// ===========================================================================

test("unverifiable reasons include actionable hints the operator can act on", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("authless-model", "Authless Model")],
    },
  });
  // Provider with an authHeader requirement but no usable API key → auth-missing.
  const config = createVerifierConfig(dir, [provider({ apiKey: "" })]);

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ id: "authless-model" }] }), { status: 200, headers: { "content-type": "application/json" } }));

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  const unverifiable = result.verified.find((entry) => entry.category === "unverifiable");
  assert.ok(unverifiable, "expected at least one unverifiable entry");
  const reason = unverifiable?.reason ?? "";
  // Machine codes like "auth-missing" are not actionable hints. A real hint is
  // human-readable prose that tells the operator what to do (e.g. "Set an API
  // key for this provider to verify it").
  assert.equal(/^[a-z][a-z0-9-]*$/i.test(reason) && reason.includes("-"), false, `unverifiable reason must be actionable human-readable prose, not an opaque kebab-case machine code; got: "${reason}"`);
  assert.match(reason, /\b(set|provide|configure|add|check|supply|ensure)\b|api[_ -]?key|credential/i, `unverifiable reason must tell the operator what to do (an actionable directive); got: "${reason}"`);
  assert.ok(reason.length >= 20, `unverifiable reason must be a descriptive sentence/hint (length ${reason.length} is too short); got: "${reason}"`);
});

test("model-not-listed reason explains that the provider endpoint does not advertise the model", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("ghost-model", "Ghost Model")],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      // Endpoint listing omits ghost-model → model-not-listed branch.
      return new Response(JSON.stringify({ data: [{ id: "ghost-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Models endpoint lists a DIFFERENT model, so ghost-model is not advertised.
    return new Response(JSON.stringify({ data: [{ id: "other-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  const entry = result.verified.find((verified) => verified.modelId === "ghost-model");
  assert.ok(entry, "expected a verification entry for ghost-model");
  const reason = entry?.reason ?? "";
  // Machine codes like "model-not-listed-by-provider" are not actionable hints.
  assert.equal(/^[a-z][a-z0-9-]*$/i.test(reason) && reason.includes("-"), false, `model-not-listed reason must be actionable human-readable prose, not an opaque kebab-case machine code; got: "${reason}"`);
  assert.match(reason, /not (listed|advertised)|provider|endpoint|available/i, `model-not-listed reason must explain the cause in operator-readable terms; got: "${reason}"`);
  assert.ok(reason.length >= 20, `model-not-listed reason must be a descriptive sentence/hint (length ${reason.length} is too short); got: "${reason}"`);
});

// ===========================================================================
// Module: visible result summary with category counts and timing
// ===========================================================================

test("summary log reports per-category counts and total elapsed timing", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [
        freeModel("free-confirmed", "Free Confirmed"),
        paidModel("paid-confirmed", "Paid Confirmed", 1, 2),
      ],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const isChat = /\/chat\/completions$/.test(url.replace(/\?.*$/, ""));
    if (!isChat) return new Response(JSON.stringify({ data: [{ id: "free-confirmed" }, { id: "paid-confirmed" }] }), { status: 200, headers: { "content-type": "application/json" } });
    const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: Array<{ content?: string }> }) : {};
    const prompt = body.messages?.[0]?.content ?? "";
    if (prompt.includes("paid-confirmed")) {
      // Usage alone no longer proves billing; confirmed-paid needs an explicit
      // payment-required signal.
      return new Response(JSON.stringify({ error: { message: "payment required for this model", type: "billing_error", code: "payment_required" } }), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
  });

  const { logger, logs } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger });

  const summaryLogs = logs.filter((entry) => /summary/i.test(entry.event));
  assert.ok(summaryLogs.length > 0, "verifier must emit a dedicated summary log event");
  const summary = summaryLogs[summaryLogs.length - 1]!;
  const summarySerialized = JSON.stringify(summary);

  // Per-category counts.
  assert.match(summarySerialized, /confirmed-free/i, "summary must include a confirmed-free count");
  assert.match(summarySerialized, /confirmed-paid/i, "summary must include a confirmed-paid count");
  assert.match(summarySerialized, /unverif/i, "summary must include an unverifiable count");

  // Timing.
  assert.match(
    summarySerialized,
    /duration|elapsed|ms|timing|took/i,
    "summary must include timing information (duration/elapsed ms)",
  );

  assertNoSecretLeak("summary log", summary, [TEST_API_KEY]);

  // Sanity: the computed categories match the counts narrative.
  const categories = result.verified.map((entry) => entry.category);
  assert.ok(categories.includes("confirmed-free"), "expected a confirmed-free entry");
  assert.ok(categories.includes("confirmed-paid"), "expected a confirmed-paid entry");
});

// ===========================================================================
// Module: --json mode produces a machine-readable summary shape
// ===========================================================================

test("json:true result exposes a structured summary with counts and cacheUpdated", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("json-free", "Json Free")],
    },
  });
  const config = createVerifierConfig(dir, [provider()]);

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (/\/chat\/completions$/.test(url.replace(/\?.*$/, ""))) {
      return new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "billing_error" } }), { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ id: "json-free" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, json: true });

  // The result must carry a structured summary field usable by --json output.
  const resultRecord = asRecord(result);
  assert.ok("summary" in resultRecord || resultRecord.summary !== undefined, "json mode must expose a `summary` field on the result");
  const summary = resultRecord.summary;
  assert.ok(summary, "json summary must be present");
  assert.ok(isRecord(summary) && ("counts" in summary || "byCategory" in summary), "json summary must include per-category counts");
  assert.ok((isRecord(summary) && "cacheUpdated" in summary) || result.cacheUpdated !== undefined, "json summary must include cacheUpdated");
  assertNoSecretLeak("json summary", summary, [TEST_API_KEY]);
});

// ===========================================================================
// Module: --strict surfaces unverifiable outcomes as a failure signal
// ===========================================================================

test("strict:true causes verifyFreeModels to signal failure when any model is unverifiable", async (t) => {
  const { verifyFreeModels } = await loadVerifierModule();
  const { cacheManager, dir } = createUxVerifierCache({
    "verifier-provider": {
      fetchedAt: new Date().toISOString(),
      ttlMs: 60_000,
      authoritative: true,
      models: [freeModel("authless-model", "Authless Model")],
    },
  });
  const config = createVerifierConfig(dir, [provider({ apiKey: "" })]);

  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ id: "authless-model" }] }), { status: 200, headers: { "content-type": "application/json" } }));

  const { logger } = captureLogger();
  const result = await verifyFreeModels({ config, cacheManager, logger, strict: true });

  // Strict mode must surface unverifiable entries as a failure signal on the
  // result (e.g. a `success:false` / `failed` / `exitCode`-equivalent field).
  const resultRecord = asRecord(result);
  const failureSignal = resultRecord.success === false ||
    resultRecord.failed === true ||
    resultRecord.exitCode === 1 ||
    resultRecord.strict === false;
  assert.ok(failureSignal, "strict:true must surface a failure signal on the result when unverifiable entries exist");
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Cast a typed result to a loose record to read optional UX-only fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
