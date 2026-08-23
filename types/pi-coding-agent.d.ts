/**
 * Self-contained ambient type declarations for Pi Coding Agent extension host APIs.
 *
 * This provides the minimal type surface required by pi-model-discovery at compile time
 * without depending on the heavy Pi CLI runtime package in devDependencies.
 */

declare module "@earendil-works/pi-coding-agent" {
  export interface ModelCost {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }

  export interface ProviderModelConfig {
    id: string;
    name: string;
    api?: string;
    baseUrl?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
    input: ("text" | "image")[];
    cost: ModelCost;
    contextWindow?: number;
    maxTokens?: number;
    samplingParams?: Record<string, unknown>;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
  }

  export interface ProviderConfig {
    baseUrl: string;
    apiKey?: string;
    api?: string;
    authHeader?: boolean;
    headers?: Record<string, string>;
    models: ProviderModelConfig[];
  }

  export interface ModelRegistryEntry {
    id: string;
    name: string;
    provider: string;
    api: string;
    baseUrl: string;
    reasoning?: boolean;
    input?: string[];
    cost: ModelCost;
    contextWindow?: number;
    maxTokens?: number;
  }

  export interface ModelRegistryLike {
    getAll(): ReadonlyArray<ModelRegistryEntry>;
  }

  export interface ExtensionContext {
    modelRegistry: ModelRegistryLike;
    hasUI?: boolean;
    ui: {
      notify(message: string, level?: "info" | "warning" | "error" | string): void;
      custom<T = void>(
        component: (
          tui: { terminal: { rows?: number; columns?: number }; requestRender(): void },
          theme: unknown,
          keybindings: unknown,
          done: () => void
        ) => {
          render(width: number): string[];
          invalidate?(): void;
          handleInput?(input: string): void;
        },
        options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> }
      ): Promise<T>;
    };
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface CommandDefinition {
    description?: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  }

  export interface ExtensionAPI {
    registerProvider(id: string, config: ProviderConfig): void;
    unregisterProvider(id: string): void;
    registerCommand(name: string, definition: CommandDefinition): void;
    events?: {
      emit(event: string, payload?: unknown): void;
      on(event: string, handler: (payload?: unknown) => void): void;
    };
    on(event: string, handler: (...args: any[]) => void): void;
  }
}

declare module "@mariozechner/pi-coding-agent" {
  export * from "@earendil-works/pi-coding-agent";
}

declare module "@earendil-works/pi-tui" {
  export interface ThemeLike {
    fg?(name: string, text: string): string;
    bold?(text: string): string;
  }
}
