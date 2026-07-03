import type { DiscoveryDefaults, InputModality, OutputModality } from "../config/types.js";
import { safeFetchJson } from "../discovery/helpers.js";
import { readPositiveNumber, readStringArray } from "../shared/arrays.js";
import { isRecord } from "../shared/validation.js";
import { assembleCost } from "./defaults.js";
import { buildModelsDevLookup, type ModelsDevLookup } from "./models-dev.js";

const OPENROUTER_SOURCE = "openrouter";
const OPENROUTER_OUTPUT_MODALITIES_PARAM = "output_modalities";
const PROVIDER_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function parseNonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function pricePerTokenToPerMillion(value: unknown): number | undefined {
  const parsed = parseNonNegativeNumber(value);
  return parsed === undefined ? undefined : Number((parsed * 1_000_000).toFixed(12));
}

function readPricing(value: unknown): DiscoveryDefaults["cost"] | undefined {
  if (!isRecord(value)) return undefined;
  return assembleCost({
    input: pricePerTokenToPerMillion(value.prompt),
    output: pricePerTokenToPerMillion(value.completion),
    cacheRead: pricePerTokenToPerMillion(value.input_cache_read),
    cacheWrite: pricePerTokenToPerMillion(value.input_cache_write),
  });
}

function readOpenRouterModalities(architecture: unknown): Pick<DiscoveryDefaults, "input" | "output" | "capabilities"> {
  if (!isRecord(architecture)) return {};
  const capabilities: NonNullable<DiscoveryDefaults["capabilities"]> = {};
  const input: InputModality[] = readStringArray(architecture.input_modalities).flatMap((modality): InputModality[] => {
    if (modality === "text" || modality === "image") return [modality];
    if (modality === "file") capabilities.attachments = true;
    if (modality === "audio") capabilities.audioInput = true;
    if (modality === "video") capabilities.videoInput = true;
    return [];
  });
  const output = readStringArray(architecture.output_modalities).filter((modality): modality is OutputModality => ["text", "image", "audio", "video"].includes(modality));
  return {
    input: input.length > 0 ? Array.from(new Set(input)) : undefined,
    output: output.length > 0 ? Array.from(new Set(output)) : undefined,
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
  };
}

function readSupportedParameterCapabilities(value: unknown): DiscoveryDefaults["capabilities"] | undefined {
  const parameters = new Set(readStringArray(value));
  const capabilities: NonNullable<DiscoveryDefaults["capabilities"]> = {};
  if (parameters.has("tools")) capabilities.toolCalling = true;
  if (parameters.has("structured_outputs") || parameters.has("response_format")) capabilities.structuredOutputs = true;
  if (parameters.has("temperature")) capabilities.temperature = true;
  if (parameters.has("reasoning") || parameters.has("include_reasoning")) capabilities.reasoningControls = true;
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function combineCapabilities(...values: Array<DiscoveryDefaults["capabilities"] | undefined>): DiscoveryDefaults["capabilities"] | undefined {
  const merged: NonNullable<DiscoveryDefaults["capabilities"]> = {};
  for (const value of values) Object.assign(merged, value ?? {});
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function providerPrefixFromModelId(id: string): string | undefined {
  const [prefix] = id.split("/", 1);
  return prefix && PROVIDER_PREFIX_PATTERN.test(prefix) && id.includes("/") ? prefix : undefined;
}

function modelSlugFromId(id: string): string | undefined {
  const slug = id.split("/").at(-1);
  return slug && slug !== id ? slug : undefined;
}

function toModelsDevCompatibleModel(candidate: unknown): Record<string, unknown> | undefined {
  if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) return undefined;
  const id = candidate.id;
  const architecture = readOpenRouterModalities(candidate.architecture);
  const supportedCapabilities = readSupportedParameterCapabilities(candidate.supported_parameters);
  const topProvider = isRecord(candidate.top_provider) ? candidate.top_provider : undefined;
  const supportedParameters = readStringArray(candidate.supported_parameters);
  const providerPrefix = providerPrefixFromModelId(id);
  const slug = modelSlugFromId(id);
  const aliases = [candidate.canonical_slug, slug].filter((value): value is string => typeof value === "string" && value.length > 0 && value !== id);
  const providers: Record<string, { id: string }> = { openrouter: { id } };
  if (providerPrefix && slug) providers[providerPrefix] = { id: slug };

  const model: Record<string, unknown> = {
    id,
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    aliases: Array.from(new Set(aliases)),
    providers,
    reasoning: supportedParameters.length > 0 ? supportedParameters.some((parameter) => parameter === "reasoning" || parameter === "include_reasoning") : undefined,
    capabilities: combineCapabilities(architecture.capabilities, supportedCapabilities),
    cost: readPricing(candidate.pricing),
    limit: {
      context: readPositiveNumber(candidate, "context_length") ?? readPositiveNumber(topProvider, "context_length"),
      output: readPositiveNumber(topProvider, "max_completion_tokens"),
    },
    modalities: {
      input: architecture.input,
      output: architecture.output,
    },
  };

  return model;
}

export function buildOpenRouterLookup(payload: unknown): ModelsDevLookup {
  const root = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const models: Record<string, unknown> = {};
  for (const entry of root) {
    const model = toModelsDevCompatibleModel(entry);
    if (model && typeof model.id === "string") models[model.id] = model;
  }
  return buildModelsDevLookup({ models }, OPENROUTER_SOURCE);
}

function withOutputModalitiesAll(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has(OPENROUTER_OUTPUT_MODALITIES_PARAM)) {
    parsed.searchParams.set(OPENROUTER_OUTPUT_MODALITIES_PARAM, "all");
  }
  return parsed.toString();
}

export async function fetchOpenRouterLookup(url: string, timeoutMs: number): Promise<ModelsDevLookup> {
  const response = await safeFetchJson<unknown>(withOutputModalitiesAll(url), { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
  if (!response.ok || response.data === undefined) {
    throw new Error(`OpenRouter catalog fetch failed: ${response.error ?? `HTTP ${response.status}`}`);
  }
  return buildOpenRouterLookup(response.data);
}
