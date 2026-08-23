export interface BaseUrlValidationResult {
  ok: boolean;
  value?: string;
  reason?: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function uniqueNonEmptyStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized = values
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
  return Array.from(new Set(normalized));
}

export function readBooleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(normalized) || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isBlockedMetadataHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "169.254.169.254" || normalized === "metadata.google.internal";
}

export function validateBaseUrl(value: string, options: { allowLocalHttp?: boolean } = {}): BaseUrlValidationResult {
  return validateUrl(value, { ...options, rejectQuery: true });
}

export function validateEndpointUrl(value: string, options: { allowLocalHttp?: boolean; baseUrl?: string } = {}): BaseUrlValidationResult {
  return validateUrl(value, options);
}

function validateUrl(
  value: string,
  options: { allowLocalHttp?: boolean; baseUrl?: string; rejectQuery?: boolean },
): BaseUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "baseUrl must be a valid absolute URL" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "baseUrl must use http or https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "baseUrl must not contain credentials" };
  }
  if ((options.rejectQuery && parsed.search) || parsed.hash) {
    return { ok: false, reason: "baseUrl must not contain query strings or fragments" };
  }
  if (isBlockedMetadataHostname(parsed.hostname)) {
    return { ok: false, reason: "baseUrl host is not allowed for discovery" };
  }
  if (parsed.protocol === "http:" && !(options.allowLocalHttp && isLocalHostname(parsed.hostname))) {
    return { ok: false, reason: "baseUrl must use https unless the host is local development" };
  }
  if (options.baseUrl) {
    const baseValidation = validateBaseUrl(options.baseUrl, { allowLocalHttp: options.allowLocalHttp });
    if (!baseValidation.ok || !baseValidation.value) return baseValidation;
    if (parsed.origin !== new URL(baseValidation.value).origin) {
      return { ok: false, reason: "endpointUrl must use the provider baseUrl origin" };
    }
  }

  return { ok: true, value: parsed.toString().replace(/\/$/, "") };
}
