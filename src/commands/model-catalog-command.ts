import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { isProviderCacheEntryFresh } from "../cache/manager.js";
import type { CacheEntry, CacheSchema, DiscoveredModel } from "../cache/types.js";
import type { ExtensionConfig, InputModality, ProviderConfigEntry } from "../config/types.js";
import { loadConfig } from "../config/loader.js";
import { classifyFreeModels } from "../enrichment/free-classifier.js";
import { applyModelDefaults, buildCatalogIdentityIndex, resolveModelsDevDefaults, type CatalogIdentityIndex } from "../enrichment/merger.js";
import { fetchModelsDevLookup, mergeModelsDevLookups, type ModelsDevLookup } from "../enrichment/models-dev.js";
import { fetchOpenRouterLookup } from "../enrichment/openrouter.js";
import { isTextCompletionModel } from "../shared/model-kind.js";

interface ThemeLike {
  fg?(name: string, text: string): string;
  bold?(text: string): string;
}

interface CatalogProvider {
  id: string;
  configured?: ProviderConfigEntry;
  entry?: CacheEntry;
  fresh: boolean;
  modelCount: number;
  runtimeOnly?: boolean;
}

interface CatalogModel {
  providerId: string;
  provider: CatalogProvider;
  model: DiscoveredModel;
}

type FreeFilter = "all" | "free" | "paid" | "unknown";
type CacheFilter = "all" | "fresh" | "expired" | "authoritative" | "non-authoritative";
type SortKey = "provider" | "name" | "free" | "context" | "max" | "cost" | "fetched";

interface CatalogData {
  config: ExtensionConfig;
  configWarnings: string[];
  cache?: CacheSchema;
  cacheError?: string;
  providers: CatalogProvider[];
  models: CatalogModel[];
}

const SORT_KEYS: SortKey[] = ["provider", "name", "free", "context", "max", "cost", "fetched"];
const FREE_FILTERS: FreeFilter[] = ["all", "free", "paid", "unknown"];
const CACHE_FILTERS: CacheFilter[] = ["all", "fresh", "expired", "authoritative", "non-authoritative"];
// Keep the master/detail layout only when there is enough room for a readable details pane.
// frameWidth 120 => contentWidth 118, so terminals below 120 columns snap to stacked mode.
const WIDE_LAYOUT_MIN_WIDTH = 118;
const BOX = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  leftTee: "├",
  rightTee: "┤",
  topTee: "┬",
  bottomTee: "┴",
  cross: "┼",
};

function readCache(cacheFile: string): { cache?: CacheSchema; error?: string } {
  try {
    return { cache: JSON.parse(readFileSync(cacheFile, "utf-8")) as CacheSchema };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildCatalogData(extensionRoot: string): CatalogData {
  const { config, warnings } = loadConfig({ extensionRoot });
  const { cache, error } = readCache(config.cacheFile);
  const configuredById = new Map(config.providers.map((provider) => [provider.id, provider]));
  const providerIds = new Set<string>([
    ...configuredById.keys(),
    ...Object.keys(cache?.providers ?? {}),
  ]);

  const providers = Array.from(providerIds)
    .sort((left, right) => left.localeCompare(right))
    .map((id): CatalogProvider => {
      const entry = cache?.providers[id];
      return {
        id,
        configured: configuredById.get(id),
        entry,
        fresh: entry ? isProviderCacheEntryFresh(id, entry) : false,
        modelCount: entry?.models.length ?? 0,
      };
    });

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const models = providers.flatMap((provider) =>
    (provider.entry?.models ?? []).map((model): CatalogModel => ({
      providerId: provider.id,
      provider: providerById.get(provider.id) ?? provider,
      model,
    })),
  );

  return {
    config,
    configWarnings: warnings,
    cache,
    cacheError: error,
    providers,
    models,
  };
}

function color(theme: ThemeLike, name: string, text: string): string {
  return theme.fg ? theme.fg(name, text) : text;
}

function bold(theme: ThemeLike, text: string): string {
  return theme.bold ? theme.bold(text) : text;
}

const ANSI_OSC_SEQUENCE_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
const ANSI_ESCAPE_SEQUENCE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
const WIDE_CODEPOINT_PATTERN = /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function stripAnsi(value: string): string {
  return value
    .replace(ANSI_OSC_SEQUENCE_PATTERN, "")
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "");
}

function charWidth(char: string): number {
  if (!char || COMBINING_MARK_PATTERN.test(char)) return 0;
  return WIDE_CODEPOINT_PATTERN.test(char) ? 2 : 1;
}

function visibleWidth(value: string): number {
  return Array.from(stripAnsi(value)).reduce((width, char) => width + charWidth(char), 0);
}

function truncateToWidth(value: string, width: number, ellipsis = "…"): string {
  const safeWidth = Math.max(0, width);
  if (visibleWidth(value) <= safeWidth) return value;
  const ellipsisWidth = visibleWidth(ellipsis);
  const targetWidth = Math.max(0, safeWidth - ellipsisWidth);
  let usedWidth = 0;
  let output = "";
  for (const char of Array.from(stripAnsi(value))) {
    const width = charWidth(char);
    if (usedWidth + width > targetWidth) break;
    output += char;
    usedWidth += width;
  }
  return `${output}${safeWidth >= ellipsisWidth ? ellipsis : ""}`;
}

function visibleLength(value: string): number {
  return visibleWidth(value);
}

function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(value, width, "…");
}

function pad(value: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const truncated = truncateToWidth(value, safeWidth, "…");
  return `${truncated}${" ".repeat(Math.max(0, safeWidth - visibleLength(truncated)))}`;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "?";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${Math.floor(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.floor(value / 1_000)}k`;
  return String(value);
}

function formatCost(model: DiscoveredModel): string {
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  if (input === 0 && output === 0) return "$0";
  return `$${input}/${output}`;
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function freeLabel(model: DiscoveredModel): string {
  if (model.isFree === true) return "Yes";
  if (model.isFree === false) return "No";
  return "Unknown";
}

function freeFilterLabel(filter: FreeFilter): string {
  if (filter === "free") return "Yes";
  if (filter === "paid") return "No";
  return titleCase(filter);
}

function cacheStatus(provider: CatalogProvider): string {
  if (provider.runtimeOnly) return "Runtime";
  if (!provider.entry) return "No cache";
  return provider.fresh ? "Fresh" : "Expired";
}

function cacheFilterLabel(filter: CacheFilter): string {
  return filter === "all" ? "All" : titleCase(filter);
}

function authoritativeLabel(provider: CatalogProvider): string {
  if (provider.runtimeOnly) return "Runtime registry";
  if (!provider.entry) return "None";
  return provider.entry.authoritative ? "Authoritative" : "Non-authoritative";
}

function fetchedAge(provider: CatalogProvider, now = Date.now()): number {
  const fetchedAt = provider.entry ? Date.parse(provider.entry.fetchedAt) : Number.NaN;
  return Number.isFinite(fetchedAt) ? now - fetchedAt : Number.POSITIVE_INFINITY;
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "?";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatModalities(values: string[] | undefined, compact = false): string {
  const normalized = values ?? [];
  if (normalized.length === 0) return "?";
  if (!compact) return normalized.map(titleCase).join(", ");
  const aliases: Record<string, string> = { text: "Txt", image: "Img", audio: "Aud", video: "Vid" };
  return normalized.map((value) => aliases[value] ?? titleCase(value)).join(",");
}

function sortLabel(sortKey: SortKey, reverse: boolean): string {
  return `${titleCase(sortKey)} ${reverse ? "▼" : "▲"}`;
}

function searchableText(item: CatalogModel): string {
  const model = item.model;
  return [
    item.providerId,
    model.id,
    model.name,
    freeLabel(model),
    cacheStatus(item.provider),
    authoritativeLabel(item.provider),
    model.reasoning ? "reasoning" : "non-reasoning",
    ...(model.input ?? []),
    ...(model.output ?? []),
    ...Object.keys(model.sources ?? {}),
    ...Object.keys(model.capabilityProvenance ?? {}),
    ...Object.keys(model.compat ?? {}),
    ...Object.keys(model.capabilities ?? {}),
  ]
    .join(" ")
    .toLowerCase();
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  const a = left ?? -1;
  const b = right ?? -1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareModels(sortKey: SortKey, left: CatalogModel, right: CatalogModel): number {
  switch (sortKey) {
    case "name":
      return left.model.name.localeCompare(right.model.name) || left.model.id.localeCompare(right.model.id);
    case "free":
      return freeLabel(left.model).localeCompare(freeLabel(right.model)) || left.providerId.localeCompare(right.providerId) || left.model.id.localeCompare(right.model.id);
    case "context":
      return compareOptionalNumber(left.model.contextWindow, right.model.contextWindow) || left.model.id.localeCompare(right.model.id);
    case "max":
      return compareOptionalNumber(left.model.maxTokens, right.model.maxTokens) || left.model.id.localeCompare(right.model.id);
    case "cost":
      return compareOptionalNumber((left.model.cost?.input ?? 0) + (left.model.cost?.output ?? 0), (right.model.cost?.input ?? 0) + (right.model.cost?.output ?? 0)) || left.model.id.localeCompare(right.model.id);
    case "fetched":
      return fetchedAge(left.provider) - fetchedAge(right.provider) || left.model.id.localeCompare(right.model.id);
    case "provider":
    default:
      return left.providerId.localeCompare(right.providerId) || left.model.id.localeCompare(right.model.id);
  }
}

function borderColor(theme: ThemeLike, text: string): string {
  return color(theme, "border", text);
}

function border(theme: ThemeLike, width: number, position: "top" | "middle" | "bottom" = "middle"): string {
  const horizontal = BOX.horizontal.repeat(Math.max(0, width - 2));
  if (position === "top") return borderColor(theme, `${BOX.topLeft}${horizontal}${BOX.topRight}`);
  if (position === "bottom") return borderColor(theme, `${BOX.bottomLeft}${horizontal}${BOX.bottomRight}`);
  return borderColor(theme, `${BOX.leftTee}${horizontal}${BOX.rightTee}`);
}

function splitBorder(theme: ThemeLike, listWidth: number, detailWidth: number): string {
  return borderColor(theme, `${BOX.leftTee}${BOX.horizontal.repeat(Math.max(0, listWidth))}${BOX.cross}${BOX.horizontal.repeat(Math.max(0, detailWidth))}${BOX.rightTee}`);
}

function framedLine(theme: ThemeLike, content: string, width: number): string {
  return `${borderColor(theme, BOX.vertical)}${pad(` ${content}`, Math.max(0, width - 2))}${borderColor(theme, BOX.vertical)}`;
}

function splitLine(theme: ThemeLike, left: string, right: string, listWidth: number, detailWidth: number): string {
  return `${borderColor(theme, BOX.vertical)}${pad(` ${left}`, listWidth)}${borderColor(theme, BOX.vertical)}${pad(` ${right}`, detailWidth)}${borderColor(theme, BOX.vertical)}`;
}

function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

function printable(data: string): string | undefined {
  return data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class ModelCatalogModal {
  private query: string;
  private freeFilter: FreeFilter = "all";
  private cacheFilter: CacheFilter = "all";
  private providerFilter = "all";
  private sortKey: SortKey = "provider";
  private reverse = false;
  private selectedIndex = 0;
  private scrollTop = 0;
  private searchMode = false;
  private showFullDetails = false;
  private showHelp = false;

  constructor(
    private readonly data: CatalogData,
    private readonly theme: ThemeLike,
    initialQuery: string,
    private readonly done: () => void,
    private readonly getTerminalRows: () => number | undefined = () => undefined,
  ) {
    this.query = initialQuery.trim();
  }

  invalidate(): void {
    // Rendering is derived from current state; no cache to invalidate.
  }

  render(width: number): string[] {
    const frameWidth = Math.max(20, width);
    const contentWidth = frameWidth - 2;
    const filtered = this.filteredModels();
    const selected = filtered[this.selectedIndex];
    const total = this.data.models.length;
    const freeCount = this.data.models.filter((item) => item.model.isFree === true).length;
    const paidCount = this.data.models.filter((item) => item.model.isFree === false).length;
    const unknownCount = total - freeCount - paidCount;
    const wide = contentWidth >= WIDE_LAYOUT_MIN_WIDTH;
    const warningRows = (this.data.cacheError ? 1 : 0) + (this.data.configWarnings.length > 0 ? 1 : 0);
    const targetRows = this.targetRenderRows(wide);
    const listRows = wide
      ? clamp(targetRows - 11 - warningRows, 6, 22)
      : clamp(targetRows - (this.showFullDetails ? 16 : 14) - warningRows, 3, 8);
    const stackedDetailRows = this.showFullDetails ? clamp(targetRows - listRows - 12 - warningRows, 3, 10) : 2;
    this.ensureSelectionVisible(filtered.length, listRows);

    const lines: string[] = [];
    lines.push(border(this.theme, frameWidth, "top"));
    lines.push(this.renderTitleLine(frameWidth, filtered.length, total, freeCount, paidCount, unknownCount, wide));
    lines.push(border(this.theme, frameWidth));
    lines.push(this.renderControlsLine(frameWidth, wide));
    if (this.data.cacheError) lines.push(framedLine(this.theme, color(this.theme, "warning", `⚠  Cache read warning: ${this.data.cacheError}`), frameWidth));
    if (this.data.configWarnings.length > 0) {
      const warning = wide
        ? `⚠  ${this.data.configWarnings.length} config warning(s): enable debug or inspect config for details`
        : `⚠  ${this.data.configWarnings.length} config warning(s) - check logs`;
      lines.push(framedLine(this.theme, color(this.theme, "warning", warning), frameWidth));
    }

    if (wide) {
      lines.push(...this.renderWideBody(filtered, selected, contentWidth, listRows));
    } else {
      lines.push(...this.renderNarrowBody(filtered, selected, frameWidth, contentWidth, listRows, stackedDetailRows));
    }

    return lines;
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }

    if (data === "\x1b" || data === "q" || data === "\x03") {
      this.done();
      return;
    }
    if (data === "/") {
      this.searchMode = true;
      return;
    }
    if (data === "f") {
      this.freeFilter = this.nextValue(FREE_FILTERS, this.freeFilter);
      this.resetSelection();
      return;
    }
    if (data === "t") {
      this.cacheFilter = this.nextValue(CACHE_FILTERS, this.cacheFilter);
      this.resetSelection();
      return;
    }
    if (data === "p") {
      this.providerFilter = this.nextProviderFilter();
      this.resetSelection();
      return;
    }
    if (data === "s") {
      this.sortKey = this.nextValue(SORT_KEYS, this.sortKey);
      this.resetSelection();
      return;
    }
    if (data === "r") {
      this.reverse = !this.reverse;
      return;
    }
    if (data === "d") {
      this.showFullDetails = !this.showFullDetails;
      return;
    }
    if (data === "h") {
      this.showHelp = !this.showHelp;
      return;
    }
    if (data === "c") {
      this.query = "";
      this.freeFilter = "all";
      this.cacheFilter = "all";
      this.providerFilter = "all";
      this.resetSelection();
      return;
    }

    this.handleNavigationInput(data);
  }

  private renderTitleLine(frameWidth: number, visible: number, total: number, free: number, paid: number, unknown: number, wide: boolean): string {
    const title = wide ? "MODEL DISCOVERY CATALOG" : "MODEL DISCOVERY";
    const counts = wide
      ? `${visible}/${total} models | ${this.data.providers.length} providers | ${free} free | ${paid} paid${unknown > 0 ? ` | ${unknown} unknown` : ""}`
      : `${visible}/${total} models | ${this.data.providers.length} providers`;
    return framedLine(this.theme, `${bold(this.theme, title)} | ${color(this.theme, "dim", counts)}`, frameWidth);
  }

  private renderControlsLine(frameWidth: number, wide: boolean): string {
    const queryLabel = this.query || "<empty>";
    const query = `[🔍 Query${this.searchMode ? "*" : ""}: ${queryLabel}]`;
    const filters = wide
      ? `Filters: [Free: ${freeFilterLabel(this.freeFilter)}] [Cache: ${cacheFilterLabel(this.cacheFilter)}] [Provider: ${this.providerFilter}]`
      : `Filters: [${freeFilterLabel(this.freeFilter)}] [${cacheFilterLabel(this.cacheFilter)}]`;
    const sort = `Sort: [${sortLabel(this.sortKey, this.reverse)}]`;
    return framedLine(this.theme, `${query}  ${filters}  ${sort}`, frameWidth);
  }

  private renderWideBody(models: CatalogModel[], selected: CatalogModel | undefined, contentWidth: number, listRows: number): string[] {
    const detailWidth = Math.max(38, Math.floor(contentWidth * 0.42));
    const listWidth = contentWidth - detailWidth - 1;
    const lines: string[] = [];
    lines.push(splitBorder(this.theme, listWidth, detailWidth));
    lines.push(splitLine(this.theme, this.renderWideTableHeader(listWidth), `DETAILS: ${selected ? selected.model.name : "No selection"}`, listWidth, detailWidth));
    lines.push(splitBorder(this.theme, listWidth, detailWidth));

    const rows = this.renderWideRows(models, listWidth, listRows);
    const details = this.renderDetails(selected, detailWidth - 2, listRows);
    for (let index = 0; index < Math.max(rows.length, details.length); index += 1) {
      lines.push(splitLine(this.theme, rows[index] ?? "", details[index] ?? "", listWidth, detailWidth));
    }

    lines.push(splitBorder(this.theme, listWidth, detailWidth));
    lines.push(framedLine(this.theme, this.renderPageInfo(models.length, listRows), listWidth + detailWidth + 3));
    lines.push(framedLine(this.theme, color(this.theme, "dim", "[↑/↓/PgUp/PgDn] Navigate  [/] Query  [f] Free  [t] Cache  [p] Provider  [s] Sort  [r] Reverse  [c] Clear  [q] Close"), listWidth + detailWidth + 3));
    lines.push(border(this.theme, listWidth + detailWidth + 3, "bottom"));
    return lines;
  }

  private renderNarrowBody(models: CatalogModel[], selected: CatalogModel | undefined, frameWidth: number, contentWidth: number, listRows: number, detailRows: number): string[] {
    const lines: string[] = [];
    lines.push(border(this.theme, frameWidth));
    lines.push(framedLine(this.theme, this.renderNarrowTableHeader(contentWidth - 2), frameWidth));
    lines.push(border(this.theme, frameWidth));
    for (const row of this.renderNarrowRows(models, contentWidth - 2, listRows)) lines.push(framedLine(this.theme, row, frameWidth));
    lines.push(border(this.theme, frameWidth));
    for (const detail of this.renderStackedDetails(selected, contentWidth - 2, detailRows)) lines.push(framedLine(this.theme, detail, frameWidth));
    lines.push(border(this.theme, frameWidth));
    lines.push(framedLine(this.theme, color(this.theme, "dim", this.renderNarrowFooter(models.length, listRows, frameWidth)), frameWidth));
    lines.push(border(this.theme, frameWidth, "bottom"));
    return lines;
  }

  private wideColumnWidths(width: number): { freeWidth: number; cacheWidth: number; contextWidth: number; maxWidth: number; labelWidth: number } {
    return { freeWidth: 5, cacheWidth: 6, contextWidth: 5, maxWidth: 5, labelWidth: Math.max(12, width - 30) };
  }

  private renderWideTableHeader(width: number): string {
    const { freeWidth, cacheWidth, contextWidth, maxWidth, labelWidth } = this.wideColumnWidths(width);
    return bold(this.theme, `${pad("Provider / Model", labelWidth + 3)} ${pad("Free", freeWidth)} ${pad("Cache", cacheWidth)} ${pad("Ctx", contextWidth)} ${pad("Max", maxWidth)}`);
  }

  private renderNarrowTableHeader(width: number): string {
    const labelWidth = Math.max(12, width - 31);
    return bold(this.theme, `${pad("Provider / Model", labelWidth + 3)} ${pad("Free", 5)} ${pad("Ctx", 6)} ${pad("Max", 6)} ${pad("Cost", 6)}`);
  }

  private renderModelRows(models: CatalogModel[], rows: number, labelWidth: number, buildRow: (item: CatalogModel, marker: string, label: string, labelWidth: number) => string): string[] {
    if (models.length === 0) return [color(this.theme, "dim", "No models match the current query and filters.")];
    return models.slice(this.scrollTop, this.scrollTop + rows).map((item, offset) => {
      const index = this.scrollTop + offset;
      const marker = index === this.selectedIndex ? ">>" : "  ";
      const label = `${item.providerId}/${item.model.id}`;
      const row = buildRow(item, marker, label, labelWidth);
      return index === this.selectedIndex ? color(this.theme, "accent", row) : row;
    });
  }

  private renderWideRows(models: CatalogModel[], width: number, rows: number): string[] {
    const { freeWidth, cacheWidth, contextWidth, maxWidth, labelWidth } = this.wideColumnWidths(width);
    return this.renderModelRows(models, rows, labelWidth, (item, marker, label, lw) => `${marker} ${pad(label, lw)} ${pad(freeLabel(item.model), freeWidth)} ${pad(cacheStatus(item.provider), cacheWidth)} ${pad(formatCompactNumber(item.model.contextWindow), contextWidth)} ${pad(formatCompactNumber(item.model.maxTokens), maxWidth)}`);
  }

  private renderNarrowRows(models: CatalogModel[], width: number, rows: number): string[] {
    const labelWidth = Math.max(12, width - 31);
    return this.renderModelRows(models, rows, labelWidth, (item, marker, label, lw) => `${marker} ${pad(label, lw)} ${pad(freeLabel(item.model), 5)} ${pad(formatCompactNumber(item.model.contextWindow), 6)} ${pad(formatCompactNumber(item.model.maxTokens), 6)} ${pad(formatCost(item.model), 6)}`);
  }

  private renderDetails(item: CatalogModel | undefined, width: number, maxRows: number): string[] {
    if (!item) return [bold(this.theme, "Details"), color(this.theme, "dim", "Select a model to inspect metadata.")];
    const model = item.model;
    const provider = item.provider;
    const details = [
      `ID: ${model.id}`,
      `Provider: ${item.providerId} | Source: ${provider.runtimeOnly ? "runtime-registry" : provider.configured?.source ?? "cache-only"}`,
      `Free: ${freeLabel(model)} | Reasoning: ${model.reasoning ? "Yes" : "No"}`,
      `Context Window: ${formatNumber(model.contextWindow)}`,
      `Max Tokens: ${formatNumber(model.maxTokens)}`,
      `Input: ${formatModalities(model.input)}`,
      `Output: ${formatModalities(model.output)}`,
      `Cost: In $${model.cost?.input ?? 0} | Out $${model.cost?.output ?? 0} | Cache Read $${model.cost?.cacheRead ?? 0} | Cache Write $${model.cost?.cacheWrite ?? 0}`,
      `Cache: ${cacheStatus(provider)} (${authoritativeLabel(provider)} | Age: ${formatAge(fetchedAge(provider))} | TTL: ${formatAge(provider.entry?.ttlMs ?? Number.NaN)})`,
      `BaseUrl: ${model.baseUrl ?? provider.configured?.baseUrl ?? "provider default"}`,
      `API: ${model.api ?? provider.configured?.api ?? "provider default"}`,
      `Sources: ${Object.keys(model.sources ?? {}).filter((key) => model.sources[key]).join(", ") || "none"}`,
      `Provenance: ${Object.entries(model.capabilityProvenance ?? {}).map(([key, value]) => `${key}:${value}`).join(", ") || "none"}`,
      `Compat: ${JSON.stringify(model.compat ?? {})}`,
      `Capabilities: ${JSON.stringify(model.capabilities ?? {})}`,
    ];
    return details.slice(0, maxRows).map((detail) => truncate(detail, width));
  }

  private renderStackedDetails(item: CatalogModel | undefined, width: number, detailRows: number): string[] {
    if (!item) return [bold(this.theme, "SELECTED DETAILS"), color(this.theme, "dim", "Select a model to inspect metadata.")];
    if (this.showFullDetails) return [bold(this.theme, `SELECTED DETAILS: ${item.model.name}`), ...this.renderDetails(item, width, detailRows)];
    const model = item.model;
    return [
      bold(this.theme, `SELECTED DETAILS: ${model.name}`),
      `ID: ${model.id} | Free: ${freeLabel(model)} | Reasoning: ${model.reasoning ? "Yes" : "No"}`,
      `Ctx: ${formatNumber(model.contextWindow)} | Max: ${formatNumber(model.maxTokens)} | In: ${formatModalities(model.input, true)} | Out: ${formatModalities(model.output, true)}`,
    ].map((detail) => truncate(detail, width));
  }

  private renderPageInfo(totalRows: number, rowsPerPage: number, compact = false): string {
    const metrics = this.pageMetrics(totalRows, rowsPerPage);
    return compact ? `P${metrics.page}/${metrics.pages}` : `Page ${metrics.page}/${metrics.pages} (${metrics.start}-${metrics.end} of ${totalRows})`;
  }

  private renderNarrowFooter(totalRows: number, rowsPerPage: number, frameWidth: number): string {
    const page = this.renderPageInfo(totalRows, rowsPerPage, true);
    if (!this.showHelp) {
      return frameWidth < 56
        ? `${page} | [↑/↓] [/] Query [h] Help [q] Close`
        : `${page} | [↑/↓] Nav  [/] Query  [h] Help/More  [q] Close`;
    }
    if (frameWidth < 56) return `${page} | [f]Free [s]Sort [d]Detail [h]Back`;
    if (frameWidth < 80) return `${page} | [f] Free  [t] Cache  [s] Sort  [d] Details  [h] Back`;
    return `${page} | [f] Free  [t] Cache  [p] Provider  [s] Sort  [r] Reverse  [c] Clear  [d] Details  [h] Back`;
  }

  private pageMetrics(totalRows: number, rowsPerPage: number): { page: number; pages: number; start: number; end: number } {
    if (totalRows === 0) return { page: 0, pages: 0, start: 0, end: 0 };
    const page = Math.floor(this.scrollTop / rowsPerPage) + 1;
    const pages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
    const start = this.scrollTop + 1;
    const end = Math.min(totalRows, this.scrollTop + rowsPerPage);
    return { page, pages, start, end };
  }

  private targetRenderRows(wide: boolean): number {
    const terminalRows = this.getTerminalRows();
    if (terminalRows === undefined || !Number.isFinite(terminalRows) || terminalRows <= 0) return wide ? 34 : 23;
    return Math.max(12, Math.floor(terminalRows * 0.92));
  }

  private handleSearchInput(data: string): void {
    if (data === "\x1b" || data === "\r" || data === "\n" || data === "\r\n") {
      this.searchMode = false;
      return;
    }
    if (data === "\x15") {
      this.query = "";
      this.resetSelection();
      return;
    }
    if (isBackspace(data)) {
      this.query = this.query.slice(0, -1);
      this.resetSelection();
      return;
    }
    const char = printable(data);
    if (char !== undefined) {
      this.query += char;
      this.resetSelection();
    }
  }

  private handleNavigationInput(data: string): void {
    const count = this.filteredModels().length;
    if (count === 0) return;
    if (data === "\x1b[A") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (data === "\x1b[B") this.selectedIndex = Math.min(count - 1, this.selectedIndex + 1);
    if (data === "\x1b[5~") this.selectedIndex = Math.max(0, this.selectedIndex - 10);
    if (data === "\x1b[6~") this.selectedIndex = Math.min(count - 1, this.selectedIndex + 10);
    if (data === "\x1b[H" || data === "\x1b[1~") this.selectedIndex = 0;
    if (data === "\x1b[F" || data === "\x1b[4~") this.selectedIndex = count - 1;
  }

  private filteredModels(): CatalogModel[] {
    const normalizedQuery = this.query.toLowerCase().trim();
    const result = this.data.models.filter((item) => {
      if (this.providerFilter !== "all" && item.providerId !== this.providerFilter) return false;
      if (this.freeFilter === "free" && item.model.isFree !== true) return false;
      if (this.freeFilter === "paid" && item.model.isFree !== false) return false;
      if (this.freeFilter === "unknown" && item.model.isFree !== undefined) return false;
      if (this.cacheFilter === "fresh" && !item.provider.fresh) return false;
      if (this.cacheFilter === "expired" && item.provider.fresh) return false;
      if (this.cacheFilter === "authoritative" && item.provider.entry?.authoritative !== true) return false;
      if (this.cacheFilter === "non-authoritative" && item.provider.entry?.authoritative !== false) return false;
      return normalizedQuery.length === 0 || searchableText(item).includes(normalizedQuery);
    });

    result.sort((left, right) => compareModels(this.sortKey, left, right));
    if (this.reverse) result.reverse();
    if (this.selectedIndex >= result.length) this.selectedIndex = Math.max(0, result.length - 1);
    return result;
  }

  private ensureSelectionVisible(count: number, rows: number): void {
    if (count === 0) {
      this.selectedIndex = 0;
      this.scrollTop = 0;
      return;
    }
    if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
    if (this.selectedIndex >= this.scrollTop + rows) this.scrollTop = this.selectedIndex - rows + 1;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, count - rows)));
  }

  private resetSelection(): void {
    this.selectedIndex = 0;
    this.scrollTop = 0;
  }

  private nextValue<T extends string>(values: readonly T[], current: T): T {
    return values[(values.indexOf(current) + 1) % values.length] ?? values[0]!;
  }

  private nextProviderFilter(): string {
    const providers = ["all", ...this.data.providers.filter((provider) => provider.modelCount > 0).map((provider) => provider.id)];
    return providers[(providers.indexOf(this.providerFilter) + 1) % providers.length] ?? "all";
  }
}

export function fallbackSummary(data: CatalogData): string {
  const total = data.models.length;
  const free = data.models.filter((item) => item.model.isFree === true).length;
  const paid = data.models.filter((item) => item.model.isFree === false).length;
  const unknown = total - free - paid;
  const providers = data.providers.map((provider) => provider.runtimeOnly ? `${provider.id}: ${provider.modelCount} models, Runtime registry` : `${provider.id}: ${provider.modelCount} models, ${cacheStatus(provider)}, ${authoritativeLabel(provider)}`);
  return [`Pi Model Discovery Catalog: ${total} models across ${data.providers.length} providers (${free} free, ${paid} paid, ${unknown} unknown).`, ...providers].join("\n");
}

async function openCatalogModal(ctx: ExtensionCommandContext, data: CatalogData, initialQuery: string): Promise<void> {
  const overlayOptions = { anchor: "center" as const, width: "98%" as const, maxHeight: "92%" as const, margin: 1 };
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const modal = new ModelCatalogModal(data, theme as ThemeLike, initialQuery, done, () => tui.terminal.rows);
      return {
        render(width: number) {
          return modal.render(width);
        },
        invalidate() {
          modal.invalidate();
        },
        handleInput(input: string) {
          modal.handleInput(input);
          tui.requestRender();
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}

/** Minimal shape of a model returned by ModelRegistry.getAll(). */
interface RegistryModelLike {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

function registryProviderConfig(providerId: string, model: RegistryModelLike): ProviderConfigEntry {
  return {
    id: providerId,
    baseUrl: model.baseUrl,
    apiKey: "runtime-registry",
    api: model.api as ProviderConfigEntry["api"],
    authHeader: true,
    headers: {},
    discovery: {
      type: "static",
      enabled: false,
      headers: {},
      timeoutMs: 0,
      includeDetails: false,
      allowModels: [],
      blockModels: [],
    },
    defaults: {},
    modelDefaults: {},
    source: "auto-import",
  };
}

function registryModelToDiscovered(providerId: string, registryModel: RegistryModelLike, modelsDevLookup: ModelsDevLookup, catalogIdentityIndex: CatalogIdentityIndex): DiscoveredModel | undefined {
  const provider = registryProviderConfig(providerId, registryModel);
  let discovered: DiscoveredModel = {
    id: registryModel.id,
    name: registryModel.name,
    api: registryModel.api as DiscoveredModel["api"],
    baseUrl: registryModel.baseUrl,
    reasoning: registryModel.reasoning,
    input: registryModel.input as InputModality[],
    contextWindow: registryModel.contextWindow,
    maxTokens: registryModel.maxTokens,
    cost: registryModel.cost,
    sources: { modelRegistry: true },
    capabilityProvenance: {},
  };

  const catalogDefaults = resolveModelsDevDefaults(provider, { id: registryModel.id, name: registryModel.name }, modelsDevLookup, catalogIdentityIndex);
  discovered = applyModelDefaults(discovered, catalogDefaults, "modelsDev");
  return isTextCompletionModel(provider, discovered) ? discovered : undefined;
}

/**
 * Merge providers/models from pi's runtime model registry into the catalog data.
 * This ensures providers registered by other extensions (pi-multi-auth, built-in
 * provider managers, etc.) that pi-model-discovery doesn't know about still appear.
 */
export function mergeRegistryModels(data: CatalogData, registryModels: RegistryModelLike[], modelsDevLookup: ModelsDevLookup = new Map()): CatalogData {
  if (registryModels.length === 0) return data;

  const registryByProvider = new Map<string, RegistryModelLike[]>();
  for (const model of registryModels) {
    if (!model.provider || !model.id) continue;
    const pid = model.provider;
    if (!registryByProvider.has(pid)) registryByProvider.set(pid, []);
    registryByProvider.get(pid)!.push(model);
  }

  const knownProviderIds = new Set(data.providers.map((provider) => provider.id));
  const catalogIdentityIndex = buildCatalogIdentityIndex(modelsDevLookup);
  const newProviders: CatalogProvider[] = [];
  const newModels: CatalogModel[] = [];

  for (const [providerId, models] of [...registryByProvider.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (knownProviderIds.has(providerId)) continue;

    const discoveredModels = models
      .map((registryModel) => registryModelToDiscovered(providerId, registryModel, modelsDevLookup, catalogIdentityIndex))
      .filter((model): model is DiscoveredModel => model !== undefined);
    const classified = classifyFreeModels(discoveredModels, {
      providerId,
      wholeProviderFree: false,
    });
    if (classified.length === 0) continue;

    const catalogProvider: CatalogProvider = {
      id: providerId,
      fresh: false,
      modelCount: classified.length,
      runtimeOnly: true,
    };
    newProviders.push(catalogProvider);

    for (const model of classified) {
      newModels.push({ providerId, provider: catalogProvider, model });
    }
  }

  if (newProviders.length === 0) return data;

  return {
    ...data,
    providers: [...data.providers, ...newProviders],
    models: [...data.models, ...newModels],
  };
}

async function loadModalCatalogLookup(data: CatalogData): Promise<ModelsDevLookup> {
  const lookups: ModelsDevLookup[] = [];
  if (data.config.modelsDev.enabled) {
    try {
      lookups.push(await fetchModelsDevLookup(data.config.modelsDev.url, data.config.modelsDev.timeoutMs));
    } catch (error) {
      data.configWarnings.push(`models.dev catalog unavailable for runtime registry enrichment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (data.config.openRouter?.enabled) {
    try {
      lookups.push(await fetchOpenRouterLookup(data.config.openRouter.url, data.config.openRouter.timeoutMs));
    } catch (error) {
      data.configWarnings.push(`OpenRouter catalog unavailable for runtime registry enrichment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return mergeModelsDevLookups(lookups);
}

export function registerModelCatalogCommand(pi: ExtensionAPI, extensionRoot: string): void {
  pi.registerCommand("pi-model-discovery", {
    description: "Open the pi-model-discovery catalog with cache metadata, search, filters, and sorting",
    handler: async (args, ctx) => {
      let data = buildCatalogData(extensionRoot);

      // Merge in any providers/models from pi's runtime model registry that
      // were registered by other extensions (pi-multi-auth, etc.) but are
      // unknown to pi-model-discovery's own config/cache.
      try {
        const allModels = ctx.modelRegistry.getAll() as unknown as RegistryModelLike[];
        if (allModels.length > 0) {
          const runtimeCatalogLookup = await loadModalCatalogLookup(data);
          data = mergeRegistryModels(data, allModels, runtimeCatalogLookup);
        }
      } catch (error) {
        data.configWarnings.push(`Runtime model registry unavailable for catalog merge: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(fallbackSummary(data), data.cacheError ? "warning" : "info");
        return;
      }
      await openCatalogModal(ctx, data, args);
    },
  });
}
