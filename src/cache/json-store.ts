import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CacheSchema } from "./types.js";

export const CACHE_SCHEMA_VERSION = 5;

const CACHE_REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;
const TRANSIENT_CACHE_REPLACE_ERROR_CODES = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);

/**
 * Best-effort cache cleanup intentionally ignores secondary filesystem failures
 * (e.g. transient EBUSY/EACCES) so they never mask the original discovery or
 * write error. Routed through a named helper instead of an empty catch so the
 * decision is explicit rather than a silent swallow.
 */
function ignoreCleanupError(_error: unknown): void {
  // Intentionally empty: cleanup is best-effort and must not propagate.
}

export function createEmptyCache(now = new Date()): CacheSchema {
  return {
    version: CACHE_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    providers: {},
  };
}

function isCacheSchema(value: unknown): value is CacheSchema {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CacheSchema>;
  return candidate.version === CACHE_SCHEMA_VERSION && Boolean(candidate.providers) && typeof candidate.providers === "object";
}

export function readCacheFile(cachePath: string): CacheSchema {
  if (!existsSync(cachePath)) return createEmptyCache();
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as unknown;
    return isCacheSchema(parsed) ? parsed : createEmptyCache();
  } catch {
    try {
      rmSync(cachePath, { force: true });
    } catch (cleanupError) {
      ignoreCleanupError(cleanupError);
    }
    return createEmptyCache();
  }
}

function isTransientCacheReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_CACHE_REPLACE_ERROR_CODES.has(code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function replaceCacheFileWithRetry(tempPath: string, cachePath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CACHE_REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rename(tempPath, cachePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientCacheReplaceError(error) || attempt >= CACHE_REPLACE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(CACHE_REPLACE_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
  throw lastError;
}

export async function writeCacheFile(cachePath: string, cache: CacheSchema): Promise<void> {
  const tempPath = `${cachePath}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify({ ...cache, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  try {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await replaceCacheFileWithRetry(tempPath, cachePath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch (cleanupError) {
      ignoreCleanupError(cleanupError);
    }
    throw error;
  }
}

export function invalidateCacheFile(cachePath: string): void {
  rmSync(cachePath, { force: true });
}
