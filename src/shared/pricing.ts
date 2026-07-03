import { isRecord } from "./validation.js";

/** Return the first finite, non-negative number among {@link values}, parsing numeric strings. */
export function readPricingNumberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
  }
  return undefined;
}

/** Whether a pricing record advertises free (zero-cost) input and output. */
export function readPricingIsFree(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const input = readPricingNumberValue(value.prompt, value.input);
  const output = readPricingNumberValue(value.completion, value.output);
  if (input === undefined || output === undefined) return undefined;
  return input === 0 && output === 0;
}
