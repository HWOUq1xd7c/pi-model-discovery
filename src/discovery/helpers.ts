import type { ProviderConfigEntry } from "../config/types.js";

export interface FetchJsonResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

/** Header names that carry secrets and must be stripped when credentials are withheld. */
const SENSITIVE_HEADER_PATTERN = /authorization|api[_-]?key|token|secret|password/i;

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name);
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function buildUrl(baseUrl: string, endpointPath: string): string {
  if (/^https?:\/\//i.test(endpointPath)) return endpointPath;
  const base = baseUrl.replace(/\/+$/g, "");
  const path = trimSlashes(endpointPath);
  return path ? `${base}/${path}` : base;
}

export interface ProviderHeaderOptions {
  /** Headers merged after provider.headers; defaults to provider.discovery.headers. */
  mergedHeaders?: Record<string, string>;
  /** When true, sets content-type: application/json. */
  jsonBody?: boolean;
  /** When false, strips sensitive headers and withholds the bearer token. */
  sendCredentials?: boolean;
  /** Override the auth material; defaults to the provider's authHeader/apiKey. */
  auth?: { authHeader: boolean; apiKey: string };
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

/**
 * Build discovery/verification request headers from a provider. Consolidates the
 * header construction shared by discovery (always send) and free-model
 * verification (json body, credential stripping, credential rotation).
 */
export function buildProviderHeaders(provider: ProviderConfigEntry, options: ProviderHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...provider.headers,
    ...(options.mergedHeaders ?? provider.discovery.headers),
  };
  if (options.jsonBody) headers["content-type"] = "application/json";
  if (options.sendCredentials === false) {
    for (const key of Object.keys(headers)) {
      if (isSensitiveHeaderName(key)) delete headers[key];
    }
  }
  const auth = options.auth ?? { authHeader: provider.authHeader, apiKey: provider.apiKey };
  if (auth.authHeader && options.sendCredentials !== false && !hasAuthorizationHeader(headers)) {
    headers.authorization = `Bearer ${auth.apiKey}`;
  }
  return headers;
}

export function buildDiscoveryHeaders(provider: ProviderConfigEntry): Record<string, string> {
  return buildProviderHeaders(provider);
}

/** Create an AbortController/timeout pair for a fetch; call `clear` in a finally block. */
export function createFetchTimeout(timeoutMs: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timeout) };
}

export async function safeFetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<FetchJsonResult<T>> {
  const { controller, clear } = createFetchTimeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !/(^|[;\s])application\/json\b|\+json\b/.test(contentType)) {
      return { ok: false, status: response.status, error: `expected JSON response but received ${contentType}` };
    }
    return { ok: true, status: response.status, data: (await response.json()) as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown fetch error";
    const isAbort = error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
    return { ok: false, status: 0, error: isAbort ? `request timed out after ${timeoutMs}ms` : message };
  } finally {
    clear();
  }
}

/** GET a discovery endpoint as JSON, throwing a contextual error on failure. */
export async function fetchDiscoveryPayload<T>(provider: ProviderConfigEntry, endpointPath: string, failureMessage: string): Promise<T> {
  const response = await safeFetchJson<T>(
    buildUrl(provider.baseUrl, endpointPath),
    { method: "GET", headers: buildDiscoveryHeaders(provider) },
    provider.discovery.timeoutMs,
  );
  if (!response.ok || !response.data) {
    throw new Error(response.error ?? failureMessage);
  }
  return response.data;
}

export function applyModelFilters(modelIds: string[], provider: ProviderConfigEntry): string[] {
  const allow = provider.discovery.allowModels;
  const block = provider.discovery.blockModels;
  const allowed = allow.length > 0 ? modelIds.filter((id) => allow.some((pattern) => id.includes(pattern))) : modelIds;
  const filtered = block.length > 0 ? allowed.filter((id) => !block.some((pattern) => id.includes(pattern))) : allowed;
  const unique = Array.from(new Set(filtered));
  return provider.maxModels !== undefined ? unique.slice(0, provider.maxModels) : unique;
}
