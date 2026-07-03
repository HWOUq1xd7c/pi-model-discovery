import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const SUPPORTED_DISCOVERY_TYPES = ["openai-compat", "ollama", "anthropic-compatible", "openai-responses", "lm-studio", "llama-cpp", "static"] as const;
export type DiscoveryType = (typeof SUPPORTED_DISCOVERY_TYPES)[number];
export type PiInputModality = ProviderModelConfig["input"][number];
export type InputModality = PiInputModality | "audio" | "video";
export type OutputModality = "text" | "image" | "audio" | "video";
export type CapabilityFlags = Record<string, boolean>;
export type Cost = ProviderModelConfig["cost"];
export type Compat = ProviderModelConfig["compat"];
export type ThinkingLevelKey = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ThinkingLevelMap = Partial<Record<ThinkingLevelKey, string | null>>;

export interface DiscoveryDefaults {
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input?: InputModality[];
  output?: OutputModality[];
  capabilities?: CapabilityFlags;
  cost?: Partial<Cost>;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Compat;
}

export interface ModelDefaults extends DiscoveryDefaults {
  name?: string;
}

export interface DiscoveryPaginationConfig {
  enabled: boolean;
  cursorParam: string;
  nextCursorField: string;
  hasMoreField: string;
  maxPages?: number;
}

export type RegistrationImportMode = "replace" | "merge" | "sync";

export interface RegistrationConfig {
  importMode: RegistrationImportMode;
}

export interface ProviderDiscoveryConfig {
  type: DiscoveryType;
  enabled: boolean;
  endpointPath?: string;
  headers: Record<string, string>;
  timeoutMs: number;
  ttlMs?: number;
  includeDetails: boolean;
  allowModels: string[];
  blockModels: string[];
  pagination?: DiscoveryPaginationConfig;
}

/**
 * A resolved credential usable for provider discovery or verifier probes.
 * Mirrors the resolved shape produced by the auto-import credential resolver.
 */
export interface CredentialEntry {
  apiKey: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  /** Credential-provider id this key was resolved from (for rotation logging). */
  sourceId?: string;
}

export interface ProviderConfigEntry {
  id: string;
  baseUrl: string;
  apiKey: string;
  api: NonNullable<ProviderConfig["api"]>;
  authHeader: boolean;
  headers: Record<string, string>;
  maxModels?: number;
  discovery: ProviderDiscoveryConfig;
  defaults: DiscoveryDefaults;
  modelDefaults: Record<string, ModelDefaults>;
  fallbackModelIds?: string[];
  source: "explicit" | "auto-import";
  /**
   * Alternative credentials grouped under this provider during auto-import
   * (e.g. numbered aliases `provider-1` … `provider-N`). `apiKey` is always the
   * first entry; consumers that support rotation try remaining entries on
   * retryable probe failures. Optional and empty for explicit providers.
   */
  credentials?: CredentialEntry[];
}

export interface ModelsDevConfig {
  enabled: boolean;
  url: string;
  timeoutMs: number;
}

export interface OpenRouterConfig {
  enabled: boolean;
  url: string;
  timeoutMs: number;
}

export interface AutoImportDiscoveryConfig {
  enabled: boolean;
  headers: Record<string, string>;
  timeoutMs: number;
  ttlMs?: number;
  includeDetails: boolean;
  typeByProvider: Record<string, DiscoveryType>;
  endpointPathByProvider: Record<string, string>;
}

export interface AutoImportConfig {
  enabled: boolean;
  allowUnauthenticated: boolean;
  modelsJsonPath: string;
  authJsonPath: string;
  multiAuthJsonPath: string;
  includeProviders: string[];
  excludeProviders: string[];
  hiddenProviders: string[];
  externalStaticProviderIds: string[];
  discovery: AutoImportDiscoveryConfig;
}

export type RegistrationOwnershipConflictMode = "merge" | "skip";

export interface RegistrationOwnershipConfig {
  managedProviderIds: ReadonlySet<string>;
  manager: "pi-multi-auth";
  onConflict: RegistrationOwnershipConflictMode;
}

export interface ExtensionConfig {
  enabled: boolean;
  debug: boolean;
  cacheTTL: number;
  cacheFile: string;
  maxModels?: number;
  modelsDev: ModelsDevConfig;
  openRouter?: OpenRouterConfig;
  autoImport: AutoImportConfig;
  providers: ProviderConfigEntry[];
  registration?: RegistrationConfig;
  registrationOwnership?: RegistrationOwnershipConfig;
}

export interface ConfigLoadResult {
  config: ExtensionConfig;
  warnings: string[];
}
