import type { CapabilityFlags, Cost, DiscoveryDefaults, InputModality, OutputModality } from "../config/types.js";
import { pushUnique, readPositiveNumber } from "../shared/arrays.js";
import { isRecord } from "../shared/validation.js";
import { assembleCost, normalizeOutput } from "./defaults.js";

const PI_MONO_INPUT_MODALITIES = new Set(["text", "image"]);

function readNonNegativeNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function toCamelCase(value: string): string {
  return value.replace(/[_-]([a-z0-9])/gi, (_match, char: string) => char.toUpperCase());
}

function readCost(value: unknown): Partial<Cost> | undefined {
  if (!isRecord(value)) return undefined;
  return assembleCost({
    input: readNonNegativeNumber(value, "input"),
    output: readNonNegativeNumber(value, "output"),
    cacheRead: readNonNegativeNumber(value, "cache_read") ?? readNonNegativeNumber(value, "cacheRead"),
    cacheWrite: readNonNegativeNumber(value, "cache_write") ?? readNonNegativeNumber(value, "cacheWrite"),
  });
}

function readContextPricingTierSize(value: unknown): number | undefined {
  if (!isRecord(value) || !Array.isArray(value.tiers)) return undefined;
  const sizes: number[] = [];
  for (const rawTier of value.tiers) {
    if (!isRecord(rawTier) || !isRecord(rawTier.tier)) continue;
    if (typeof rawTier.tier.type !== "string" || rawTier.tier.type.trim().toLowerCase() !== "context") continue;
    const size = readPositiveNumber(rawTier.tier, "size");
    if (size !== undefined) sizes.push(size);
  }
  return sizes.length > 0 ? Math.min(...sizes) : undefined;
}

function readContextWindow(candidate: Record<string, unknown>, limit: Record<string, unknown> | undefined): number | undefined {
  return readContextPricingTierSize(candidate.cost) ?? readPositiveNumber(limit, "input") ?? readPositiveNumber(limit, "context");
}

function readInputModalities(value: unknown, capabilities: CapabilityFlags): InputModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const input: InputModality[] = [];
  for (const rawEntry of value) {
    if (typeof rawEntry !== "string") continue;
    if (PI_MONO_INPUT_MODALITIES.has(rawEntry)) {
      pushUnique(input, rawEntry as InputModality);
      continue;
    }
    if (rawEntry === "audio") capabilities.audioInput = true;
    if (rawEntry === "video") capabilities.videoInput = true;
    if (rawEntry === "pdf") capabilities.attachments = true;
  }
  return input.length > 0 ? input : undefined;
}

function readModelsDevModalities(value: unknown, capabilities: CapabilityFlags): Pick<DiscoveryDefaults, "input" | "output"> {
  if (!isRecord(value)) return {};
  return {
    input: readInputModalities(value.input, capabilities),
    output: normalizeOutput(value.output),
  };
}

function mergeCapabilityFlagsInto(target: CapabilityFlags, value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "boolean") target[toCamelCase(key)] = rawValue;
  }
}

function applyBooleanCapability(target: CapabilityFlags, candidate: Record<string, unknown>, field: string, capability: string): void {
  const value = readOptionalBoolean(candidate, field);
  if (value !== undefined) target[capability] = value;
}

function readInterleavedCapability(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (isRecord(value)) return true;
  return undefined;
}

function normalizedModelIdentity(candidate: Record<string, unknown>, id: string): string {
  const name = typeof candidate.name === "string" ? candidate.name : "";
  return `${id} ${name}`.toLowerCase().replace(/[\s_/.]+/g, "-");
}

function claudeOpusXhighEffort(candidate: Record<string, unknown>, id: string): "xhigh" | "max" | undefined {
  const identity = normalizedModelIdentity(candidate, id);
  if (identity.includes("claude-opus-4-8")) return "xhigh";
  if (identity.includes("claude-opus-4-7")) return "xhigh";
  if (identity.includes("claude-opus-4-6")) return "max";
  return undefined;
}

export function mapModelsDevRecordToPiMetadata(candidate: Record<string, unknown>, fallbackId?: string): DiscoveryDefaults & { id: string; name?: string } | undefined {
  const id = typeof candidate.id === "string" ? candidate.id : fallbackId;
  if (!id) return undefined;

  const limit = isRecord(candidate.limit) ? candidate.limit : undefined;
  const contextWindow = readContextWindow(candidate, limit);
  const maxTokens = readPositiveNumber(limit, "output");
  const capabilities: CapabilityFlags = {};
  mergeCapabilityFlagsInto(capabilities, candidate.capabilities);
  applyBooleanCapability(capabilities, candidate, "attachment", "attachments");
  applyBooleanCapability(capabilities, candidate, "tool_call", "toolCalling");
  applyBooleanCapability(capabilities, candidate, "structured_output", "structuredOutputs");
  applyBooleanCapability(capabilities, candidate, "temperature", "temperature");
  applyBooleanCapability(capabilities, candidate, "open_weights", "openWeights");
  const interleaved = readInterleavedCapability(candidate.interleaved);
  if (interleaved !== undefined) capabilities.interleavedReasoning = interleaved;

  const metadata: DiscoveryDefaults & { id: string; name?: string } = { id };
  if (typeof candidate.name === "string") metadata.name = candidate.name;
  if (typeof candidate.reasoning === "boolean") metadata.reasoning = candidate.reasoning;
  const claudeOpusEffort = metadata.reasoning === true ? claudeOpusXhighEffort(candidate, id) : undefined;
  if (claudeOpusEffort) metadata.thinkingLevelMap = { xhigh: claudeOpusEffort };
  const modalities = readModelsDevModalities(candidate.modalities, capabilities);
  if (modalities.input) metadata.input = modalities.input;
  if (modalities.output) metadata.output = modalities.output as OutputModality[];
  if (Object.keys(capabilities).length > 0) metadata.capabilities = capabilities;
  const cost = readCost(candidate.cost);
  if (cost) metadata.cost = cost;
  if (contextWindow !== undefined) metadata.contextWindow = contextWindow;
  if (maxTokens !== undefined) metadata.maxTokens = maxTokens;
  return metadata;
}
