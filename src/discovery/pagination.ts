import type { DiscoveryPaginationConfig } from "../config/types.js";
import { isRecord } from "../shared/validation.js";

export interface PaginationState {
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Path segments that traverse (or could traverse) an object's prototype chain.
 * Rejecting them in `readPath()` prevents prototype-pollution and prototype-chain
 * information leaks when pagination field paths are sourced from provider config.
 * See Semgrep `javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop`.
 */
const PROTOTYPE_POLLUTION_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function readPath(payload: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (PROTOTYPE_POLLUTION_SEGMENTS.has(segment)) return undefined;
    if (!isRecord(current)) return undefined;
    current = current[segment]; // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop — segment is denylisted against __proto__/constructor/prototype above (PROTOTYPE_POLLUTION_SEGMENTS) and current is type-narrowed to a record, so no prototype-chain write occurs.
  }
  return current;
}

export function appendPaginationCursor(url: string, cursorParam: string, cursor: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(cursorParam, cursor);
  return parsed.toString();
}

export function readPaginationState(payload: unknown, pagination: DiscoveryPaginationConfig): PaginationState {
  const rawHasMore = readPath(payload, pagination.hasMoreField);
  const rawNextCursor = readPath(payload, pagination.nextCursorField);
  const nextCursor = typeof rawNextCursor === "string" && rawNextCursor.length > 0 ? rawNextCursor : undefined;

  if (typeof rawHasMore === "boolean") {
    return { hasMore: rawHasMore, nextCursor };
  }

  return { hasMore: nextCursor !== undefined, nextCursor };
}
