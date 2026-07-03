import type { Cost, DiscoveryDefaults, InputModality, OutputModality } from "../config/types.js";

export const GLOBAL_COST: Cost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const GLOBAL_DEFAULTS: {
  reasoning: boolean;
  input: InputModality[];
  cost: Cost;
  contextWindow: number;
  maxTokens: number;
  compat: Record<string, never>;
} = {
  reasoning: false,
  input: ["text"],
  cost: GLOBAL_COST,
  contextWindow: 128_000,
  maxTokens: 16_384,
  compat: {},
};

export const SUPPORTED_MODALITIES = new Set(["text", "image", "audio", "video"]);

function normalizeModalityArray<T extends string>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const modalities = value.filter((entry): entry is T => typeof entry === "string" && SUPPORTED_MODALITIES.has(entry));
  return modalities.length > 0 ? Array.from(new Set(modalities)) : undefined;
}

export function normalizeInput(value: unknown): InputModality[] | undefined {
  return normalizeModalityArray<InputModality>(value);
}

export function normalizeOutput(value: unknown): OutputModality[] | undefined {
  return normalizeModalityArray<OutputModality>(value);
}

export function mergeCost(base: Cost, override: Partial<Cost> | undefined): Cost {
  return {
    input: override?.input ?? base.input,
    output: override?.output ?? base.output,
    cacheRead: override?.cacheRead ?? base.cacheRead,
    cacheWrite: override?.cacheWrite ?? base.cacheWrite,
  };
}

/** Assemble a {@link Cost} partial from individually-resolved price components. */
export function assembleCost(components: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): Partial<Cost> | undefined {
  const cost: Partial<Cost> = {};
  if (components.input !== undefined) cost.input = components.input;
  if (components.output !== undefined) cost.output = components.output;
  if (components.cacheRead !== undefined) cost.cacheRead = components.cacheRead;
  if (components.cacheWrite !== undefined) cost.cacheWrite = components.cacheWrite;
  return Object.keys(cost).length > 0 ? cost : undefined;
}
