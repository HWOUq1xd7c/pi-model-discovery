import type { CacheManager } from "../cache/manager.js";
import type { CacheEntry, DiscoveredModel } from "../cache/types.js";
import type { ExtensionConfig, ProviderConfigEntry } from "../config/types.js";
import { buildProviderHeaders, buildUrl, createFetchTimeout } from "../discovery/helpers.js";
import { getBuiltInProviderProfile } from "../discovery/builtin-profiles.js";
import { resolveOpenAICompatibleModelsEndpoint } from "../discovery/provider-quirks.js";
import { isRecord, readBooleanValue } from "../shared/validation.js";
import { readPricingIsFree } from "../shared/pricing.js";

const MAX_CONCURRENT_PROBES = 4;
const VERIFIER_SOURCE = "freeModelVerifier";
const SUPPORTED_DISCOVERY_TYPES = new Set(["openai-compat"]);
const VERIFICATION_CATEGORIES: readonly FreeModelVerificationCategory[] = [
  "confirmed-free",
  "confirmed-paid",
  "downgraded-to-paid",
  "upgraded-to-free",
  "unverifiable",
  "skipped",
];

export type FreeModelVerificationCategory = "confirmed-free" | "confirmed-paid" | "downgraded-to-paid" | "upgraded-to-free" | "unverifiable" | "skipped";

export interface FreeModelVerificationEntry {
  providerId: string;
  modelId: string;
  category: FreeModelVerificationCategory;
  reason?: string;
}

export interface FreeModelVerifierLogEntry {
  timestamp: string;
  level: "debug" | "warn" | "error";
  extension: "pi-model-discovery";
  event: string;
  providerId?: string;
  modelId?: string;
  category?: FreeModelVerificationCategory;
  reason?: string;
  status?: number;
  cacheUpdated?: boolean;
  cacheWouldUpdate?: boolean;
  modelCount?: number;
  verifiedCount?: number;
  providerCount?: number;
  durationMs?: number;
  counts?: Record<FreeModelVerificationCategory, number>;
  dryRun?: boolean;
  strict?: boolean;
  success?: boolean;
  message?: string;
}

export interface FreeModelVerifierLogger {
  debug(event: string, details?: unknown): void;
  warn(event: string, details?: unknown): void;
  error(event: string, details?: unknown): void;
}

export interface VerifyFreeModelsOptions {
  config: ExtensionConfig;
  cacheManager: CacheManager;
  logger?: FreeModelVerifierLogger;
  concurrency?: number;
  sendCredentials?: boolean;
  dryRun?: boolean;
  provider?: string;
  model?: string;
  strict?: boolean;
  json?: boolean;
}

export interface FreeModelVerificationSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  providerCount: number;
  modelCount: number;
  verifiedCount: number;
  definitiveCount: number;
  unverifiableCount: number;
  cacheUpdated: boolean;
  cacheWouldUpdate: boolean;
  dryRun: boolean;
  strict: boolean;
  sendCredentials: boolean;
  filters: {
    provider?: string;
    model?: string;
  };
  counts: Record<FreeModelVerificationCategory, number>;
}

export interface VerifyFreeModelsResult {
  verified: FreeModelVerificationEntry[];
  cacheUpdated: boolean;
  logs: FreeModelVerifierLogEntry[];
  summary: FreeModelVerificationSummary;
  success: boolean;
  failed: boolean;
  exitCode: 0 | 1;
}

interface ProviderVerificationContext {
  provider: ProviderConfigEntry;
  entry: CacheEntry;
  modelIdsFromEndpoint: ReadonlySet<string> | undefined;
  endpointPricingById: ReadonlyMap<string, boolean>;
}

interface ProbeDecision {
  status: "free" | "paid" | "unverifiable" | "skipped";
  reason: string;
  httpStatus?: number;
}

interface FetchJsonOutcome {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

function isTruthyCredential(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAuthMaterial(provider: ProviderConfigEntry): boolean {
  if (!provider.authHeader) return true;
  return isTruthyCredential(provider.apiKey);
}

interface ProbeCredential {
  apiKey: string;
  authHeader: boolean;
  headers?: Record<string, string>;
}

/**
 * Collect the credentials a probe should try, in rotation order. The provider's
 * primary key is always first; additional pool entries (grouped during
 * auto-import) follow so the verifier can rotate on retryable failures. When
 * credentials are stripped (--no-credentials) or no auth header is used, a
 * single anonymous entry is returned.
 */
function resolveProbeCredentials(provider: ProviderConfigEntry, sendCredentials: boolean): ProbeCredential[] {
  if (!sendCredentials || !provider.authHeader) return [{ apiKey: "", authHeader: false }];
  const primary: ProbeCredential = { apiKey: provider.apiKey, authHeader: true, headers: provider.discovery.headers };
  const pool = provider.credentials ?? [];
  if (pool.length <= 1) return [primary];
  const credentials: ProbeCredential[] = [primary];
  const seen = new Set<string>([provider.apiKey]);
  for (const entry of pool) {
    if (entry.authHeader && isTruthyCredential(entry.apiKey) && !seen.has(entry.apiKey)) {
      seen.add(entry.apiKey);
      credentials.push({ apiKey: entry.apiKey, authHeader: true, headers: { ...provider.discovery.headers, ...(entry.headers ?? {}) } });
    }
  }
  // Shuffle so each probe starts from a random credential, distributing load
  // across the full pool instead of always hitting the primary key first.
  return credentials.length > 1 ? shuffled(credentials) : credentials;
}

/**
 * Build request headers for a specific probe credential, using the supplied
 * credential's key and headers instead of the provider's primary key.
 */
function buildVerificationHeadersForCredential(provider: ProviderConfigEntry, credential: ProbeCredential, options: { jsonBody?: boolean; sendCredentials: boolean }): Record<string, string> {
  return buildProviderHeaders(provider, {
    jsonBody: options.jsonBody,
    sendCredentials: options.sendCredentials,
    mergedHeaders: credential.headers ?? {},
    auth: { authHeader: credential.authHeader, apiKey: credential.apiKey },
  });
}

/**
 * Whether an unverifiable decision is worth rotating to the next credential for.
 * Rate-limiting and auth failures are often credential-specific, so a different
 * key may succeed; network/availability and ambiguous errors are not helped by
 * rotation.
 */
function isRotationWorthy(decision: ProbeDecision): boolean {
  return decision.reason === "rate-limited" || decision.reason === "auth-missing";
}

/**
 * Fisher-Yates shuffle returning a new randomly-ordered array. Used so each
 * verification probe starts from a random credential in the pool, distributing
 * load across all available keys instead of always hammering the first one.
 */
function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function isWholeProviderFree(provider: ProviderConfigEntry): boolean {
  if (getBuiltInProviderProfile(provider.id)?.allDiscoveredModelsFree === true) return true;
  if ((provider as { allDiscoveredModelsFree?: unknown }).allDiscoveredModelsFree === true) return true;
  return /(^|[-_])whole[-_]free($|[-_])/.test(provider.id);
}

function isSupportedProvider(provider: ProviderConfigEntry): boolean {
  return SUPPORTED_DISCOVERY_TYPES.has(provider.discovery.type) && provider.api === "openai-completions";
}

function logEntry(
  logs: FreeModelVerifierLogEntry[],
  logger: FreeModelVerifierLogger | undefined,
  level: "debug" | "warn" | "error",
  event: string,
  details: Omit<FreeModelVerifierLogEntry, "timestamp" | "level" | "extension" | "event">,
): void {
  const entry: FreeModelVerifierLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    extension: "pi-model-discovery",
    event,
    ...details,
  };
  logs.push(entry);
  logger?.[level](event, details);
}

function createEmptyCategoryCounts(): Record<FreeModelVerificationCategory, number> {
  return Object.fromEntries(VERIFICATION_CATEGORIES.map((category) => [category, 0])) as Record<FreeModelVerificationCategory, number>;
}

function summarizeVerification(
  verified: readonly FreeModelVerificationEntry[],
  options: VerifyFreeModelsOptions,
  timing: { startedAt: string; finishedAt: string; durationMs: number },
  cacheUpdated: boolean,
  cacheWouldUpdate: boolean,
): FreeModelVerificationSummary {
  const counts = createEmptyCategoryCounts();
  const providerIds = new Set<string>();
  for (const entry of verified) {
    counts[entry.category] += 1;
    providerIds.add(entry.providerId);
  }
  const definitiveCount = counts["confirmed-free"] + counts["confirmed-paid"] + counts["downgraded-to-paid"] + counts["upgraded-to-free"];
  return {
    ...timing,
    providerCount: providerIds.size,
    modelCount: verified.length,
    verifiedCount: verified.length,
    definitiveCount,
    unverifiableCount: counts.unverifiable,
    cacheUpdated,
    cacheWouldUpdate,
    dryRun: options.dryRun === true,
    strict: options.strict === true,
    sendCredentials: options.sendCredentials === true,
    filters: {
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
    },
    counts,
  };
}

function isStrictFailure(summary: FreeModelVerificationSummary): boolean {
  return summary.strict && (summary.unverifiableCount > 0 || summary.verifiedCount === 0);
}

function actionableReason(reason: string): string {
  switch (reason) {
    case "generation-succeeded-no-billing-signal":
      return "Generation succeeded, but the response carried no billing or pricing signal; free providers also return usage payloads, so the cached classification was left unchanged.";
    case "provider-unavailable":
      return "The provider endpoint was unavailable or timed out; check network access, base URL, and provider status, then retry.";
    case "auth-missing":
      return "Set or provide a valid API key credential for this provider so the verifier can complete the probe.";
    case "quota-limited-free":
      return "The provider reported a quota-limited free response, so the cached free classification was confirmed.";
    case "rate-limited":
      return "The provider rate-limited the probe; wait for the limit to reset or lower concurrency, then retry.";
    case "paid-or-quota-required":
      return "The provider requires billing, payment, or a paid plan for this model, so it appears paid.";
    case "ambiguous-provider-response":
      return "The provider returned an ambiguous error; inspect the provider response or credentials before changing the cached classification.";
    case "endpoint-pricing":
      return "The provider model endpoint advertised explicit pricing metadata for this model.";
    case "model-not-listed-by-provider":
      return "The provider model endpoint does not list or advertise this model; check that the model ID is still available.";
    case "unsupported-api":
      return "This provider uses an unsupported discovery API for verifier probes; configure an OpenAI-compatible discovery endpoint to verify it.";
    case "whole-provider-free":
      return "This provider is configured as whole-provider-free, so generation probes were skipped intentionally.";
    default:
      return reason.includes("-") ? `The verifier could not classify this model (${reason}); check provider configuration and retry.` : reason;
  }
}

function readErrorText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";
  const parts: string[] = [];
  const error = payload.error;
  if (typeof error === "string") parts.push(error);
  if (isRecord(error)) {
    for (const key of ["message", "type", "code", "error", "reason"] as const) {
      const value = error[key];
      if (typeof value === "string") parts.push(value);
    }
  }
  for (const key of ["message", "type", "code", "error", "reason"] as const) {
    const value = payload[key];
    if (typeof value === "string") parts.push(value);
  }
  return parts.join(" ").toLowerCase();
}

function readEndpointIsFree(modelEntry: unknown): boolean | undefined {
  if (!isRecord(modelEntry)) return undefined;
  return readBooleanValue(
    modelEntry.isFree,
    modelEntry.is_free,
    isRecord(modelEntry.endpointPricing) ? modelEntry.endpointPricing.isFree : undefined,
    readPricingIsFree(modelEntry.pricing),
  );
}

function readEndpointModelEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.result)) return payload.result;
  return [];
}

function readEndpointModelId(modelEntry: unknown): string | undefined {
  if (!isRecord(modelEntry)) return undefined;
  for (const key of ["id", "model", "name"] as const) {
    const value = modelEntry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<FetchJsonOutcome> {
  const timeout = createFetchTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: timeout.controller.signal });
    let data: unknown;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType || /(^|[;\s])application\/json\b|\+json\b/.test(contentType)) {
      try {
        data = await response.json();
      } catch {
        data = undefined;
      }
    } else {
      try {
        data = await response.text();
      } catch {
        data = undefined;
      }
    }
    return { ok: response.ok, status: response.status, data, error: response.ok ? undefined : readErrorText(data) || `HTTP ${response.status}` };
  } catch (error) {
    const isAbort = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    return {
      ok: false,
      status: 0,
      error: isAbort ? `request timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : "unknown fetch error",
    };
  } finally {
    timeout.clear();
  }
}

function decisionFromHttpResponse(response: FetchJsonOutcome): ProbeDecision {
  const errorText = `${response.error ?? ""} ${readErrorText(response.data)}`.toLowerCase();
  if (response.ok) {
    // A successful generation does not prove a model is paid: free providers
    // (Ollama, local runners, free-tier gateways) routinely return usage
    // payloads. Without explicit pricing metadata or a billing signal, the
    // probe is inconclusive rather than evidence of billing.
    return { status: "unverifiable", reason: "generation-succeeded-no-billing-signal", httpStatus: response.status };
  }

  if (response.status === 0) return { status: "unverifiable", reason: "provider-unavailable", httpStatus: response.status };
  if (response.status === 401 || /unauthori[sz]ed|invalid[_ -]?api[_ -]?key|invalid[_ -]?token|authentication/.test(errorText)) {
    return { status: "unverifiable", reason: "auth-missing", httpStatus: response.status };
  }
  if (response.status === 429) {
    if (/insufficient[_ -]?quota|billing[_ -]?error|free[_ -]?quota|quota[_ -]?exceeded/.test(errorText)) {
      return { status: "free", reason: "quota-limited-free", httpStatus: response.status };
    }
    return { status: "unverifiable", reason: "rate-limited", httpStatus: response.status };
  }
  if ((response.status === 402 || response.status === 403) && /payment|required|billing|paid|premium|upgrade|subscription|plan|quota/.test(errorText)) {
    return { status: "paid", reason: "paid-or-quota-required", httpStatus: response.status };
  }
  if (response.status >= 500) return { status: "unverifiable", reason: "provider-unavailable", httpStatus: response.status };
  return { status: "unverifiable", reason: "ambiguous-provider-response", httpStatus: response.status };
}

function categoryFromDecision(model: DiscoveredModel, decision: ProbeDecision): FreeModelVerificationCategory {
  if (decision.status === "skipped") return "skipped";
  if (decision.status === "unverifiable") return "unverifiable";
  if (decision.status === "free") return model.isFree === false ? "upgraded-to-free" : "confirmed-free";
  return model.isFree === true ? "downgraded-to-paid" : "confirmed-paid";
}

function updateModelForCategory(model: DiscoveredModel, category: FreeModelVerificationCategory): DiscoveredModel {
  if (category !== "downgraded-to-paid" && category !== "upgraded-to-free") return model;
  return {
    ...model,
    isFree: category === "upgraded-to-free",
    sources: { ...model.sources, [VERIFIER_SOURCE]: true },
    capabilityProvenance: { ...model.capabilityProvenance, isFree: VERIFIER_SOURCE },
  };
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]!);
    }
  }));
  return results;
}

async function loadProviderContext(provider: ProviderConfigEntry, entry: CacheEntry, options: VerifyFreeModelsOptions): Promise<ProviderVerificationContext> {
  const endpoint = resolveOpenAICompatibleModelsEndpoint(provider);
  const url = buildUrl(provider.baseUrl, endpoint);
  const sendCredentials = options.sendCredentials === true;
  const credentials = resolveProbeCredentials(provider, sendCredentials);
  let response: FetchJsonOutcome = { ok: false, status: 0, error: "no-credential-attempted" };
  for (const credential of credentials) {
    const headers = buildVerificationHeadersForCredential(provider, credential, { sendCredentials, jsonBody: false });
    response = await fetchJson(url, { method: "GET", headers }, provider.discovery.timeoutMs);
    if (response.ok || response.status !== 0) break;
  }
  if (!response.ok) {
    return { provider, entry, modelIdsFromEndpoint: undefined, endpointPricingById: new Map() };
  }

  const modelIds = new Set<string>();
  const endpointPricingById = new Map<string, boolean>();
  for (const modelEntry of readEndpointModelEntries(response.data)) {
    const id = readEndpointModelId(modelEntry);
    if (!id) continue;
    modelIds.add(id);
    const isFree = readEndpointIsFree(modelEntry);
    if (isFree !== undefined) endpointPricingById.set(id, isFree);
  }
  return { provider, entry, modelIdsFromEndpoint: modelIds, endpointPricingById };
}

async function probeModel(context: ProviderVerificationContext, model: DiscoveredModel, options: VerifyFreeModelsOptions): Promise<ProbeDecision> {
  const endpointPricing = context.endpointPricingById.get(model.id);
  if (endpointPricing !== undefined) {
    return { status: endpointPricing ? "free" : "paid", reason: "endpoint-pricing" };
  }
  if (context.modelIdsFromEndpoint !== undefined && !context.modelIdsFromEndpoint.has(model.id)) {
    return { status: "unverifiable", reason: "model-not-listed-by-provider" };
  }

  const url = buildUrl(context.provider.baseUrl, "chat/completions");
  const sendCredentials = options.sendCredentials === true;
  const credentials = resolveProbeCredentials(context.provider, sendCredentials);
  let lastDecision: ProbeDecision = { status: "unverifiable", reason: "no-credential-attempted" };
  for (let attempt = 0; attempt < credentials.length; attempt += 1) {
    const headers = buildVerificationHeadersForCredential(context.provider, credentials[attempt]!, { sendCredentials, jsonBody: true });
    const response = await fetchJson(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: `Verify free-model classification for ${model.id}. Reply with one short word.` }],
          max_tokens: 1,
          stream: false,
        }),
      },
      context.provider.discovery.timeoutMs,
    );
    const decision = decisionFromHttpResponse(response);
    if (decision.status !== "unverifiable" || !isRotationWorthy(decision)) {
      return decision;
    }
    lastDecision = decision;
  }
  return lastDecision;
}

function verificationCandidates(entry: CacheEntry, options: VerifyFreeModelsOptions): DiscoveredModel[] {
  return entry.models.filter((model) => (model.isFree === true || model.isFree === false) && (!options.model || model.id === options.model));
}

function readConcurrency(options: VerifyFreeModelsOptions): number {
  return typeof options.concurrency === "number" && Number.isInteger(options.concurrency) && options.concurrency > 0
    ? options.concurrency
    : MAX_CONCURRENT_PROBES;
}

function buildSkippedVerifications(
  candidates: DiscoveredModel[],
  provider: ProviderConfigEntry,
  category: FreeModelVerificationCategory,
  reason: string,
  level: "debug" | "warn",
  logs: FreeModelVerifierLogEntry[],
  options: VerifyFreeModelsOptions,
): FreeModelVerificationEntry[] {
  const verified = candidates.map((model) => ({ providerId: provider.id, modelId: model.id, category, reason: actionableReason(reason) }));
  for (const result of verified) logEntry(logs, options.logger, level, "free_model_verification_probe", result);
  return verified;
}

async function verifyProvider(
  provider: ProviderConfigEntry,
  entry: CacheEntry,
  options: VerifyFreeModelsOptions,
  logs: FreeModelVerifierLogEntry[],
): Promise<{ verified: FreeModelVerificationEntry[]; models: DiscoveredModel[]; changed: boolean }> {
  const candidates = verificationCandidates(entry, options);
  if (candidates.length === 0) return { verified: [], models: entry.models, changed: false };

  if (!isSupportedProvider(provider)) {
    return { verified: buildSkippedVerifications(candidates, provider, "unverifiable", "unsupported-api", "debug", logs, options), models: entry.models, changed: false };
  }

  if (!hasAuthMaterial(provider)) {
    return { verified: buildSkippedVerifications(candidates, provider, "unverifiable", "auth-missing", "warn", logs, options), models: entry.models, changed: false };
  }

  if (isWholeProviderFree(provider)) {
    return { verified: buildSkippedVerifications(candidates, provider, "skipped", "whole-provider-free", "debug", logs, options), models: entry.models, changed: false };
  }

  const context = await loadProviderContext(provider, entry, options);
  const byId = new Map(entry.models.map((model) => [model.id, model]));
  const verified = await mapWithConcurrency(candidates, readConcurrency(options), async (model) => {
    const decision = await probeModel(context, model, options);
    const category = categoryFromDecision(model, decision);
    const result: FreeModelVerificationEntry = { providerId: provider.id, modelId: model.id, category, reason: actionableReason(decision.reason) };
    logEntry(logs, options.logger, category === "unverifiable" ? "warn" : "debug", "free_model_verification_probe", {
      ...result,
      status: decision.httpStatus,
    });
    const updated = updateModelForCategory(model, category);
    if (updated !== model) byId.set(model.id, updated);
    return result;
  });

  const models = entry.models.map((model) => byId.get(model.id) ?? model);
  const changed = models.some((model, index) => model !== entry.models[index]);
  return { verified, models, changed };
}

export async function verifyFreeModels(options: VerifyFreeModelsOptions): Promise<VerifyFreeModelsResult> {
  const logs: FreeModelVerifierLogEntry[] = [];
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const cache = options.cacheManager.read();
  const providersById = new Map(options.config.providers.map((provider) => [provider.id, provider]));
  const verified: FreeModelVerificationEntry[] = [];
  let cacheUpdated = false;
  let cacheWouldUpdate = false;

  logEntry(logs, options.logger, "debug", "free_model_verification_started", {
    dryRun: options.dryRun === true,
    strict: options.strict === true,
    message: "Free-model verification started.",
  });

  if (options.sendCredentials !== false) {
    logEntry(logs, options.logger, "warn", "free_model_verification_credentials_notice", {
      message: "Credential notice: verifier probes may transmit configured API-key/auth headers; use --no-credentials or sendCredentials:false to opt out.",
    });
  }

  for (const [providerId, entry] of Object.entries(cache.providers)) {
    if (options.provider && providerId !== options.provider) continue;
    const provider = providersById.get(providerId);
    if (!provider) continue;
    const outcome = await verifyProvider(provider, entry, options, logs);
    verified.push(...outcome.verified);
    if (!outcome.changed) continue;
    cacheWouldUpdate = true;
    if (options.dryRun === true) continue;
    await options.cacheManager.writeProviderEntry(providerId, { ...entry, models: outcome.models });
    cacheUpdated = true;
  }

  const finishedAtMs = Date.now();
  const summary = summarizeVerification(verified, options, {
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
  }, cacheUpdated, cacheWouldUpdate);
  const failed = isStrictFailure(summary);
  const success = !failed;
  const exitCode: 0 | 1 = failed ? 1 : 0;

  logEntry(logs, options.logger, failed ? "warn" : "debug", "free_model_verification_summary", {
    cacheUpdated,
    cacheWouldUpdate,
    modelCount: summary.modelCount,
    verifiedCount: summary.verifiedCount,
    providerCount: summary.providerCount,
    durationMs: summary.durationMs,
    counts: summary.counts,
    dryRun: summary.dryRun,
    strict: summary.strict,
    success,
    message: failed
      ? "Strict mode failed because one or more models were unverifiable, or no models were verified."
      : "Free-model verification completed.",
  });

  return { verified, cacheUpdated, logs, summary, success, failed, exitCode };
}
