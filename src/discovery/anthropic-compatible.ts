import type { ProviderConfigEntry } from "../config/types.js";
import { isRecord } from "../shared/validation.js";
import { applyModelFilters, fetchDiscoveryPayload } from "./helpers.js";
import type { RawDiscoveredModel } from "./types.js";

interface AnthropicModelEntry {
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  created?: unknown;
}

interface AnthropicModelsResponse {
  data?: AnthropicModelEntry[];
  models?: AnthropicModelEntry[];
}

function readAnthropicModelEntries(payload: unknown): AnthropicModelEntry[] {
  if (!isRecord(payload)) {
    throw new Error("Malformed Anthropic-compatible discovery payload: expected an object with data[] or models[].");
  }
  if (Array.isArray(payload.data)) return payload.data as AnthropicModelEntry[];
  if (Array.isArray(payload.models)) return payload.models as AnthropicModelEntry[];
  throw new Error("Malformed Anthropic-compatible discovery payload: expected data[] or models[] model list.");
}

export function parseAnthropicModelsResponse(payload: AnthropicModelsResponse, provider: ProviderConfigEntry): RawDiscoveredModel[] {
  const data = readAnthropicModelEntries(payload);
  const parsed: RawDiscoveredModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id) continue;
    const model: RawDiscoveredModel = { id: entry.id };
    const displayName = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (displayName && displayName !== entry.id) model.name = displayName;
    else if (name && name !== entry.id) model.name = name;
    if (typeof entry.created === "number") model.created = entry.created;
    parsed.push(model);
  }
  const allowedIds = new Set(applyModelFilters(parsed.map((model) => model.id), provider));
  return parsed.filter((model) => allowedIds.has(model.id));
}

export async function discoverAnthropicCompatible(provider: ProviderConfigEntry): Promise<RawDiscoveredModel[]> {
  const endpointPath = provider.discovery.endpointPath ?? "models";
  const payload = await fetchDiscoveryPayload<AnthropicModelsResponse>(provider, endpointPath, "Anthropic-compatible model discovery failed");
  return parseAnthropicModelsResponse(payload, provider);
}
