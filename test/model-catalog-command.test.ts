import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CacheSchema } from "../src/cache/types.js";
import { fallbackSummary, mergeRegistryModels, registerModelCatalogCommand } from "../src/commands/model-catalog-command.js";
import type { ModelsDevLookup } from "../src/enrichment/models-dev.js";
import { writeJson } from "./support/fixtures.js";

function catalogData(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    configWarnings: [],
    cache: { version: 5, updatedAt: "2026-06-07T00:00:00.000Z", providers: {} } as CacheSchema,
    providers: [],
    models: [],
    ...overrides,
  } as never;
}

interface CapturedCatalogComponent {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(input: string): void;
}

interface CapturedOverlayOptions {
  width?: unknown;
  maxHeight?: unknown;
  minWidth?: unknown;
  margin?: unknown;
  anchor?: unknown;
}

function resolveCapturedOverlayOptions(value: unknown): CapturedOverlayOptions {
  const resolved = typeof value === "function" ? (value as () => unknown)() : value;
  assert.ok(resolved !== undefined && resolved !== null && typeof resolved === "object", "catalog modal should provide overlay sizing options");
  return resolved as CapturedOverlayOptions;
}

test("model catalog modal includes runtime-registry providers not owned by pi-model-discovery", () => {
  const data = mergeRegistryModels(
    catalogData(),
    [
      {
        provider: "opencode",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-completions",
        baseUrl: "https://opencode.example.invalid/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      },
    ],
    new Map(),
  );

  assert.equal(data.providers[0]?.id, "opencode");
  assert.equal(data.providers[0]?.runtimeOnly, true);
  assert.equal(data.models[0]?.providerId, "opencode");
  assert.match(fallbackSummary(data), /opencode: 1 models, Runtime registry/i);
});

test("model catalog modal enriches runtime-registry models with current catalog limits", () => {
  const lookup = new Map([
    [
      "gpt-5.5",
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        contextWindow: 272_000,
        maxTokens: 128_000,
        output: ["text"],
      },
    ],
  ]) as ModelsDevLookup;

  const data = mergeRegistryModels(
    catalogData(),
    [
      {
        provider: "opencode",
        id: "gpt-5.5",
        name: "GPT-5.5 Legacy",
        api: "openai-completions",
        baseUrl: "https://opencode.example.invalid/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      },
    ],
    lookup,
  );

  assert.deepEqual(
    {
      name: data.models[0]?.model.name,
      contextWindow: data.models[0]?.model.contextWindow,
      maxTokens: data.models[0]?.model.maxTokens,
      output: data.models[0]?.model.output,
      source: data.models[0]?.model.capabilityProvenance?.contextWindow,
    },
    {
      name: "GPT-5.5",
      contextWindow: 272_000,
      maxTokens: 128_000,
      output: ["text"],
      source: "modelsDev",
    },
  );
});

test("model catalog modal filters non-chat runtime-registry models", () => {
  const data = mergeRegistryModels(
    catalogData(),
    [
      {
        provider: "opencode",
        id: "gpt-image-2",
        name: "GPT Image 2",
        api: "openai-completions",
        baseUrl: "https://opencode.example.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
    new Map(),
  );

  assert.deepEqual(data.providers, []);
  assert.deepEqual(data.models, []);
});

test("model catalog modal uses reference responsive overlay sizing on large terminals", async () => {
  const extensionRoot = mkdtempSync(join(tmpdir(), "pi-model-discovery-modal-sizing-"));
  writeJson(join(extensionRoot, "config.json"), {
    autoImport: { enabled: false },
    modelsDev: { enabled: false },
    openRouter: { enabled: false },
    providers: [],
  });
  writeJson(join(extensionRoot, "cache.json"), {
    version: 5,
    updatedAt: "2026-06-09T00:00:00.000Z",
    providers: {
      reference: {
        fetchedAt: "2026-06-09T00:00:00.000Z",
        ttlMs: 7_200_000,
        authoritative: true,
        models: [
          {
            id: "chat-omega",
            name: "Chat Omega",
            reasoning: false,
            input: ["text"],
            output: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
            sources: { cache: true },
          },
        ],
      },
    },
  });

  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      assert.equal(name, "pi-model-discovery");
      commandHandler = options.handler;
    },
  } as unknown as ExtensionAPI;

  let capturedOverlayOptions: unknown;
  let capturedComponent: CapturedCatalogComponent | undefined;
  const ctx = {
    hasUI: true,
    modelRegistry: { getAll: () => [] },
    ui: {
      notify() {},
      custom: async (...args: unknown[]) => {
        const factory = args[0] as (
          tui: { terminal: { rows: number }; requestRender(): void },
          theme: unknown,
          keybindings: unknown,
          done: () => void,
        ) => CapturedCatalogComponent | Promise<CapturedCatalogComponent>;
        const options = args[1] as { overlayOptions?: unknown } | undefined;
        capturedOverlayOptions = options?.overlayOptions;
        capturedComponent = await factory({ terminal: { rows: 80 }, requestRender() {} }, {}, {}, () => {});
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;

  registerModelCatalogCommand(pi, extensionRoot);
  assert.ok(commandHandler, "pi-model-discovery command should be registered");
  await commandHandler("", ctx);

  const overlayOptions = resolveCapturedOverlayOptions(capturedOverlayOptions);
  assert.equal(overlayOptions.width, "98%", "catalog modal should use the pi-multi-auth reference 98% width overlay");
  assert.equal(overlayOptions.maxHeight, "92%", "catalog modal should use the pi-multi-auth reference 92% height overlay");

  assert.ok(capturedComponent, "catalog modal component should be created");
  const renderedWidth = Math.max(...capturedComponent.render(240).map((line) => line.length));
  assert.ok(renderedWidth >= 235, `catalog modal should render near full-width on a 240-column terminal, got ${renderedWidth}`);
});
