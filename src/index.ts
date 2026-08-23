import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DebugLogger } from "./logging/logger.js";
import { syncModelsJson, type SyncModelsJsonOptions, type SyncModelsJsonResult } from "./sync/models-json-sync.js";

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MODEL_DISCOVERY_SYNCED_EVENT = "pi-model-discovery:synced";

export { syncModelsJson, toCleanProviderModelConfig, atomicWriteJson } from "./sync/models-json-sync.js";
export type { SyncModelsJsonOptions, SyncModelsJsonResult, SyncedProviderResult } from "./sync/models-json-sync.js";

function readConfigSafe(extensionRoot: string): Record<string, unknown> {
  const configPath = join(extensionRoot, "config.json");
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function registerSyncModelsCommand(pi: ExtensionAPI, extensionRoot: string): void {
  pi.registerCommand("sync-models", {
    description: "Discover and synchronize remote provider models directly into ~/.pi/agent/models.json",
    handler: async (args, ctx) => {
      const providerFilter = args ? args.trim() : undefined;
      ctx.ui.notify(
        providerFilter
          ? `Discovering models for provider '${providerFilter}'...`
          : "Discovering and synchronizing models for configured providers...",
        "info",
      );

      try {
        const result = await syncModelsJson({
          extensionRoot,
          providerId: providerFilter || undefined,
        });

        const totalModels = result.providers.reduce((sum, p) => sum + p.totalModels, 0);
        const providerCount = result.providers.length;

        if (totalModels === 0) {
          ctx.ui.notify(
            "No models discovered. Check auth.json credentials or models.json provider endpoints.",
            "warning",
          );
          return;
        }

        const details = result.providers.map((p) => `${p.providerId} (${p.totalModels} models)`).join(", ");
        ctx.ui.notify(
          `Successfully synchronized ${totalModels} models across ${providerCount} provider(s) to models.json: ${details}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Model discovery sync failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

async function refreshModels(pi: ExtensionAPI, extensionRoot: string, debug: boolean): Promise<void> {
  try {
    const result = await syncModelsJson({ extensionRoot });
    if (result.written) {
      pi.events?.emit(MODEL_DISCOVERY_SYNCED_EVENT, {
        timestamp: new Date().toISOString(),
        providers: result.providers,
        modelsJsonPath: result.modelsJsonPath,
      });
    }
  } catch (error) {
    const logger = new DebugLogger({ extensionRoot, debug });
    logger.warn("model_sync_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

export default function modelDiscoveryExtension(pi: ExtensionAPI): void {
  const config = readConfigSafe(EXTENSION_ROOT);
  if (config.enabled === false) {
    return;
  }

  registerSyncModelsCommand(pi, EXTENSION_ROOT);

  const refreshOnStart = config.refreshOnStart !== false;
  const refreshIntervalMs = typeof config.refreshIntervalMs === "number" && config.refreshIntervalMs > 0
    ? config.refreshIntervalMs
    : 0;

  if (refreshOnStart) {
    pi.on("session_start", () => refreshModels(pi, EXTENSION_ROOT, config.debug === true));
  }
  if (refreshIntervalMs > 0) {
    setInterval(() => void refreshModels(pi, EXTENSION_ROOT, config.debug === true), refreshIntervalMs);
  }
}
