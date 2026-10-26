export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Wall-clock span for a turn or a tool call: `850ms`, `11s`, `1m 54s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remain = minutes % 60;
  return remain ? `${hours}h ${remain}m` : `${hours}h`;
}

export function formatUsd(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return "< $0.01";
  return `$${cost.toFixed(2)}`;
}

/**
 * Session cost the way Claude `/usage` prints it.
 * Above $0.50 rounds to cents. A smaller positive amount keeps four decimals.
 * An omitted total is an em dash, not `$0.00` and not `< $0.01`.
 */
export function formatSessionUsd(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "—";
  if (cost <= 0) return "$0.00";
  if (cost > 0.5) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
}

export interface ModelPricing {
  inRate: number; // USD per 1M tokens
  outRate: number;
  cacheReadRate: number;
  cacheWriteRate: number;
}

/**
 * Returns exact pricing rates (USD per 1M tokens) matching model catalogs:
 * - Claude 3.5 Haiku: $0.80 in, $4.00 out, $0.08 cache read, $1.00 cache write
 * - Claude Haiku 4.5: $1.00 in, $5.00 out, $0.10 cache read, $1.25 cache write
 * - Claude Haiku 5.5: $0.10 in, $0.50 out, $0.01 cache read, $0.125 cache write
 * - Claude Sonnet 3.5/3.7/4.0/4.5/4.6: $3.00 in, $15.00 out, $0.30 cache read, $3.75 cache write
 * - Claude Sonnet 5: $2.00 in, $10.00 out, $0.20 cache read, $2.50 cache write
 * - Claude Sonnet 5.5: $2.00 in, $10.00 out, $0.10 cache read, $2.50 cache write
 * - Claude Opus 4.0/4.1: $15.00 in, $75.00 out, $1.50 cache read, $18.75 cache write
 * - Claude Opus 4.5/4.6/4.7/4.8/5.0: $5.00 in, $25.00 out, $0.50 cache read, $6.25 cache write
 * - Claude Opus 5.5: $4.00 in, $20.00 out, $0.20 cache read, $5.00 cache write
 * - Grok: $2.00 in, $10.00 out, $0.20 cache read, $2.50 cache write
 * - Gemini Flash / Mini / Light: $0.25 in, $1.25 out, $0.03 cache read, $0.25 cache write
 */
export function getModelPricing(model: string | undefined): ModelPricing {
  const m = (model || "").toLowerCase();

  // Haiku family
  if (m.includes("haiku-5-5") || m.includes("haiku-5.5") || m.includes("haiku_55")) {
    return { inRate: 0.1, outRate: 0.5, cacheReadRate: 0.01, cacheWriteRate: 0.125 };
  }
  if (m.includes("haiku-4-5") || m.includes("haiku-4.5") || m.includes("haiku_45")) {
    return { inRate: 1.0, outRate: 5.0, cacheReadRate: 0.1, cacheWriteRate: 1.25 };
  }
  if (m.includes("3-5-haiku") || m.includes("3.5-haiku") || m.includes("haiku-3-5") || m.includes("haiku-3.5") || m.includes("haiku_35")) {
    return { inRate: 0.8, outRate: 4.0, cacheReadRate: 0.08, cacheWriteRate: 1.0 };
  }
  if (m.includes("haiku")) {
    return { inRate: 1.0, outRate: 5.0, cacheReadRate: 0.1, cacheWriteRate: 1.25 };
  }

  // Sonnet family
  if (m.includes("sonnet-5-5") || m.includes("sonnet-5.5")) {
    return { inRate: 2.0, outRate: 10.0, cacheReadRate: 0.1, cacheWriteRate: 2.5 };
  }
  if (m.includes("sonnet-5") || m.includes("sonnet 5")) {
    return { inRate: 2.0, outRate: 10.0, cacheReadRate: 0.2, cacheWriteRate: 2.5 };
  }
  if (m.includes("sonnet")) {
    return { inRate: 3.0, outRate: 15.0, cacheReadRate: 0.3, cacheWriteRate: 3.75 };
  }

  // Opus family
  if (m.includes("opus-5-5") || m.includes("opus-5.5")) {
    return { inRate: 4.0, outRate: 20.0, cacheReadRate: 0.2, cacheWriteRate: 5.0 };
  }
  if (
    m.includes("opus-4-5") ||
    m.includes("opus-4-6") ||
    m.includes("opus-4-7") ||
    m.includes("opus-4-8") ||
    m.includes("opus-5") ||
    m.includes("opus 5")
  ) {
    return { inRate: 5.0, outRate: 25.0, cacheReadRate: 0.5, cacheWriteRate: 6.25 };
  }
  if (m.includes("opus-4-0") || m.includes("opus-4-1") || m.includes("3-opus") || m.includes("opus")) {
    return { inRate: 15.0, outRate: 75.0, cacheReadRate: 1.5, cacheWriteRate: 18.75 };
  }

  // Gemini. "gemini" contains the letters "mini", so a substring check
  // would price every Gemini model on the legacy $0.25 Flash table.
  const gemini = geminiListPricing(m);
  if (gemini) return gemini;
  const mini = /(^|[^a-z])mini([^a-z]|$)/.test(m);
  if (m.includes("flash") || mini || m.includes("8b") || m.includes("nano")) {
    return { inRate: 0.25, outRate: 1.25, cacheReadRate: 0.03, cacheWriteRate: 0.25 };
  }

  // Grok
  if (m.includes("grok")) {
    if (m.includes("4.6") || m.includes("4-6")) {
      return { inRate: 1.36, outRate: 4.08, cacheReadRate: 0.34, cacheWriteRate: 1.36 };
    }
    // Grok 4.7, grok-4.7-build, default grok ($0.68 in, $2.04 out, $0.17 cache read)
    return { inRate: 0.68, outRate: 2.04, cacheReadRate: 0.17, cacheWriteRate: 0.68 };
  }

  // Default / fallback standard pricing (e.g. Sonnet tier 3/15)
  return { inRate: 3.0, outRate: 15.0, cacheReadRate: 0.3, cacheWriteRate: 3.75 };
}

/** UTC calendar day `YYYY-MM-DD`, for list prices that change on a published date. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Gemini 3.8 Flash list price. Introductory through 2026-12-31, then the
 * standard rate. Cache read is one tenth of input. Output includes thinking.
 */
function flash38Rates(now: Date): ModelPricing {
  if (utcDay(now) < "2027-01-01") {
    return { inRate: 0.75, outRate: 3.75, cacheReadRate: 0.075, cacheWriteRate: 0.75 };
  }
  return { inRate: 1.5, outRate: 7.5, cacheReadRate: 0.15, cacheWriteRate: 1.5 };
}

/**
 * Gemini 4 Argon list price. Introductory through 2026-11-30, then double.
 * Cache read is 95% off input. Output includes thinking.
 */
function argonRates(now: Date): ModelPricing {
  if (utcDay(now) < "2026-12-01") {
    return { inRate: 2, outRate: 10, cacheReadRate: 0.1, cacheWriteRate: 0 };
  }
  return { inRate: 4, outRate: 20, cacheReadRate: 0.2, cacheWriteRate: 0 };
}

/**
 * List price for a Gemini model name. Returns null for an older Flash / Mini
 * name so the legacy $0.25 table can still handle `gemini-2.0-flash`.
 * Antigravity's default, when the transcript names no model, is 3.8 Flash.
 */
function geminiListPricing(model: string): ModelPricing | null {
  const argon =
    model.includes("argon") ||
    model.includes("gemini-4") ||
    model.includes("gemini 4");
  if (argon) return argonRates(new Date());
  if (model.includes("3.8") || model.includes("3-8")) return flash38Rates(new Date());
  if (!model.includes("gemini")) return null;
  const mini = /(^|[^a-z])mini([^a-z]|$)/.test(model);
  if (model.includes("flash") || mini) return null;
  return flash38Rates(new Date());
}

export function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number = 0,
): number {
  const { inRate, outRate, cacheReadRate, cacheWriteRate } = getModelPricing(model);
  return (
    (Math.max(0, inputTokens) / 1_000_000) * inRate +
    (Math.max(0, outputTokens) / 1_000_000) * outRate +
    (Math.max(0, cacheReadTokens) / 1_000_000) * cacheReadRate +
    (Math.max(0, cacheWriteTokens) / 1_000_000) * cacheWriteRate
  );
}

export interface ModelUsageTokens {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
}

/**
 * Calculates total session cost across all models utilized (matching `/usage` Breakdown).
 */
export function estimateTotalCost(
  models: ModelUsageTokens[] | undefined,
  fallbackModel: string | undefined,
  totalInputTokens: number,
  totalOutputTokens: number,
  totalCacheReadTokens: number,
  totalCacheWriteTokens: number = 0,
): number {
  if (models && models.length > 0) {
    let sum = 0;
    for (const m of models) {
      sum += estimateCost(
        m.model,
        m.input_tokens,
        m.output_tokens,
        m.cache_read_tokens,
        m.cache_write_tokens ?? 0,
      );
    }
    return sum;
  }
  return estimateCost(
    fallbackModel,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
  );
}

/**
 * Calculates estimated dollar savings from prompt caching
 * (cost of cache reads at uncached input pricing minus actual cache read cost).
 */
export function estimateCostSavings(
  models: ModelUsageTokens[] | undefined,
  fallbackModel: string | undefined,
  totalCacheReadTokens: number,
): number {
  if (models && models.length > 0) {
    let savings = 0;
    for (const m of models) {
      const { inRate, cacheReadRate } = getModelPricing(m.model);
      const discount = Math.max(0, inRate - cacheReadRate);
      savings += (Math.max(0, m.cache_read_tokens) / 1_000_000) * discount;
    }
    return savings;
  }
  const { inRate, cacheReadRate } = getModelPricing(fallbackModel);
  const discount = Math.max(0, inRate - cacheReadRate);
  return (Math.max(0, totalCacheReadTokens) / 1_000_000) * discount;
}

/** 10^10 ticks = 1 USD. Grok `/usage` divides `costUsdTicks` by this. */
export const GROK_USD_TICKS = 10_000_000_000;

export interface LedgerModelRow {
  costUSD?: number | null;
  costUsdTicks?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cacheReadTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface LedgerCategory {
  tokens?: number;
  estimatedCostUsd?: number | null;
}

/**
 * One CLI usage ledger, in the shape `/usage` reads.
 * Grok `inputTokens` include `cachedReadTokens` when `inputIncludesCache` is set.
 * Claude `inputTokens` are already uncached.
 */
export interface UsageLedger {
  provider?: "grok" | "claude" | "antigravity" | string;
  model?: string;
  /** Grok session `costUsdTicks`. Absent when the CLI omitted the total. */
  costUsdTicks?: number | null;
  costIsPartial?: boolean;
  usageIsIncomplete?: boolean;
  /** Claude `cost-state.totalCostUSD`, including a recorded zero. */
  totalCostUSD?: number | null;
  hasUnknownModelCost?: boolean;
  /**
   * Antigravity conversation cost summary cumulative total
   * (`total.cumulative_total.estimated_cost_usd`).
   */
  estimatedCostUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  toolTokens?: number;
  /** True when `inputTokens` already include cached reads (Grok `usage.json`). */
  inputIncludesCache?: boolean;
  modelUsage?: Record<string, LedgerModelRow>;
  categories?: {
    input?: LedgerCategory;
    cacheRead?: LedgerCategory;
    output?: LedgerCategory;
    thinking?: LedgerCategory;
    tools?: LedgerCategory;
  };
  pricing?: {
    inputPricePerMillionTokens?: number;
    outputPricePerMillionTokens?: number;
    cacheReadPricePerMillionTokens?: number;
    modelName?: string;
  };
  /** Quota percent from Antigravity `/usage`. Never a dollar amount. */
  quotaPercent?: number | null;
}

export interface SessionCostModel {
  model: string;
  usd: number;
}

export interface SessionCost {
  /** Null when the CLI omitted the total. Not a rate-table stand-in. */
  usd: number | null;
  /** True when `usd` is the CLI's recorded stamp. */
  stamped: boolean;
  models: SessionCostModel[];
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNeg(value: unknown): number {
  if (!finiteNumber(value) || value <= 0) return 0;
  return value;
}

function ledgerProvider(ledger: UsageLedger): string {
  const named = (ledger.provider || "").toLowerCase();
  if (named === "grok" || named === "claude" || named === "antigravity" || named === "agy") {
    return named === "agy" ? "antigravity" : named;
  }
  if (finiteNumber(ledger.totalCostUSD) || ledger.hasUnknownModelCost === true) return "claude";
  if (
    finiteNumber(ledger.estimatedCostUsd) ||
    ledger.categories != null ||
    ledger.pricing != null
  ) {
    return "antigravity";
  }
  if (
    finiteNumber(ledger.costUsdTicks) ||
    ledger.costIsPartial === true ||
    ledger.usageIsIncomplete === true
  ) {
    return "grok";
  }
  const model = (ledger.model || "").toLowerCase();
  if (model.includes("grok")) return "grok";
  if (model.includes("claude")) return "claude";
  if (model.includes("gemini") || model.includes("argon")) return "antigravity";
  return "";
}

function rowCacheRead(row: LedgerModelRow): number {
  return nonNeg(row.cachedReadTokens ?? row.cacheReadTokens ?? row.cacheReadInputTokens);
}

function rowCacheWrite(row: LedgerModelRow): number {
  return nonNeg(row.cacheCreationTokens ?? row.cacheCreationInputTokens ?? row.cacheWriteTokens);
}

/** Fresh input once. Grok's inclusive counter loses its cached reads here. */
function freshInput(row: LedgerModelRow, inputIncludesCache: boolean): number {
  const input = nonNeg(row.inputTokens);
  if (!inputIncludesCache) return input;
  return Math.max(0, input - rowCacheRead(row));
}

function priceTokenRow(model: string | undefined, row: LedgerModelRow, inputIncludesCache: boolean): number {
  return estimateCost(
    model,
    freshInput(row, inputIncludesCache),
    nonNeg(row.outputTokens),
    rowCacheRead(row),
    rowCacheWrite(row),
  );
}

function fallbackFromRates(ledger: UsageLedger, inputIncludesCache: boolean): number {
  const rows = ledger.modelUsage;
  if (rows && Object.keys(rows).length > 0) {
    let sum = 0;
    let priced = false;
    for (const [name, row] of Object.entries(rows)) {
      const hasTokens =
        nonNeg(row.inputTokens) > 0 ||
        nonNeg(row.outputTokens) > 0 ||
        rowCacheRead(row) > 0 ||
        rowCacheWrite(row) > 0;
      if (!hasTokens) continue;
      priced = true;
      sum += priceTokenRow(name, row, inputIncludesCache);
    }
    if (priced) return sum;
  }
  return priceTokenRow(
    ledger.model,
    {
      inputTokens: ledger.inputTokens,
      outputTokens: ledger.outputTokens,
      cachedReadTokens: ledger.cachedReadTokens ?? ledger.cacheReadTokens,
      cacheCreationTokens: ledger.cacheCreationTokens,
    },
    inputIncludesCache,
  );
}

function grokModelCosts(ledger: UsageLedger): SessionCostModel[] {
  const rows = ledger.modelUsage;
  if (!rows) return [];
  const models: SessionCostModel[] = [];
  for (const [name, row] of Object.entries(rows)) {
    if (!finiteNumber(row.costUsdTicks)) continue;
    models.push({ model: name, usd: row.costUsdTicks / GROK_USD_TICKS });
  }
  return models;
}

function claudeModelCosts(ledger: UsageLedger): SessionCostModel[] {
  const rows = ledger.modelUsage;
  if (!rows) return [];
  const models: SessionCostModel[] = [];
  for (const [name, row] of Object.entries(rows)) {
    if (!finiteNumber(row.costUSD)) continue;
    models.push({ model: name, usd: row.costUSD });
  }
  return models;
}

function categoryTokens(category: LedgerCategory | undefined, fallback: unknown): number {
  if (category && finiteNumber(category.tokens)) return Math.max(0, category.tokens);
  return nonNeg(fallback);
}

function categoryAmount(
  category: LedgerCategory | undefined,
  tokens: number,
  rate: number | undefined,
): number | null {
  if (category && finiteNumber(category.estimatedCostUsd)) return category.estimatedCostUsd;
  if (!finiteNumber(rate)) return null;
  return (Math.max(0, tokens) / 1_000_000) * rate;
}

/**
 * Antigravity fallback when the cumulative stamp is absent.
 * Each category is priced once from its own `estimatedCostUsd`, then the
 * ledger pricing block, then that model's list price. An unnamed model uses
 * Gemini 3.8 Flash, which is what `agy` runs when settings do not say
 * otherwise. Thinking uses the output rate and is not folded into the output
 * token count. Tools are not dropped. The legacy $0.25 Flash table and the
 * Sonnet table are not used for Gemini 3.8 or Argon.
 */
function antigravityFallback(ledger: UsageLedger): number | null {
  const pricing = ledger.pricing;
  const table = geminiListPricing((ledger.model || "").toLowerCase()) ?? flash38Rates(new Date());
  const inRate = finiteNumber(pricing?.inputPricePerMillionTokens)
    ? pricing.inputPricePerMillionTokens
    : table.inRate;
  const outRate = finiteNumber(pricing?.outputPricePerMillionTokens)
    ? pricing.outputPricePerMillionTokens
    : table.outRate;
  const cacheRate = finiteNumber(pricing?.cacheReadPricePerMillionTokens)
    ? pricing.cacheReadPricePerMillionTokens
    : table.cacheReadRate;
  const cats = ledger.categories;
  const parts: Array<[LedgerCategory | undefined, number, number | undefined]> = [
    [cats?.input, categoryTokens(cats?.input, ledger.inputTokens), inRate],
    [
      cats?.cacheRead,
      categoryTokens(cats?.cacheRead, ledger.cachedReadTokens ?? ledger.cacheReadTokens),
      cacheRate,
    ],
    [cats?.output, categoryTokens(cats?.output, ledger.outputTokens), outRate],
    [cats?.thinking, categoryTokens(cats?.thinking, ledger.reasoningTokens), outRate],
    [cats?.tools, categoryTokens(cats?.tools, ledger.toolTokens), outRate],
  ];
  let sum = 0;
  let any = false;
  for (const [category, tokens, rate] of parts) {
    const amount = categoryAmount(category, tokens, rate);
    if (amount == null) continue;
    if (amount === 0 && !(category && finiteNumber(category.estimatedCostUsd)) && tokens === 0) {
      continue;
    }
    any = true;
    sum += amount;
  }
  return any ? sum : null;
}

/**
 * Session USD for one CLI ledger. The HUD and the mini-stat both call this.
 * A complete stamp wins. A partial or incomplete Grok total with no ticks is
 * left empty. Token rates run only when that CLI recorded no stamp.
 */
export function sessionCost(ledger: UsageLedger): SessionCost {
  const provider = ledgerProvider(ledger);
  if (provider === "grok") {
    const partial = ledger.costIsPartial === true || ledger.usageIsIncomplete === true;
    if (finiteNumber(ledger.costUsdTicks)) {
      return {
        usd: ledger.costUsdTicks / GROK_USD_TICKS,
        stamped: true,
        models: partial ? [] : grokModelCosts(ledger),
      };
    }
    if (partial) return { usd: null, stamped: false, models: [] };
    return {
      usd: fallbackFromRates(ledger, ledger.inputIncludesCache !== false),
      stamped: false,
      models: [],
    };
  }
  if (provider === "claude") {
    if (finiteNumber(ledger.totalCostUSD)) {
      return {
        usd: ledger.totalCostUSD,
        stamped: true,
        models: claudeModelCosts(ledger),
      };
    }
    return {
      usd: fallbackFromRates(ledger, ledger.inputIncludesCache === true),
      stamped: false,
      models: [],
    };
  }
  if (provider === "antigravity") {
    if (finiteNumber(ledger.estimatedCostUsd)) {
      return { usd: ledger.estimatedCostUsd, stamped: true, models: [] };
    }
    return { usd: antigravityFallback(ledger), stamped: false, models: [] };
  }
  return {
    usd: fallbackFromRates(ledger, ledger.inputIncludesCache === true),
    stamped: false,
    models: [],
  };
}

export interface SessionCostLedgerStats {
  cost_ledger?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_write_tokens?: number;
  total_reasoning_tokens?: number;
  active_model?: string;
  models?: ModelUsageTokens[];
}

/** The stats object the HUD holds, reduced to the ledger `sessionCost` reads. */
export function sessionCostFromStats(
  stats: SessionCostLedgerStats | null | undefined,
  cli?: string | null,
): SessionCost {
  if (!stats) return { usd: 0, stamped: false, models: [] };
  const raw = stats.cost_ledger?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as UsageLedger;
      if (parsed && typeof parsed === "object") {
        if (!parsed.model && stats.active_model) parsed.model = stats.active_model;
        return sessionCost(parsed);
      }
    } catch {
      // A torn ledger falls through to the token totals.
    }
  }
  const modelUsage: Record<string, LedgerModelRow> = {};
  for (const row of stats.models ?? []) {
    if (!row?.model) continue;
    modelUsage[row.model] = {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens ?? 0,
    };
  }
  return sessionCost({
    provider: cli || undefined,
    model: stats.active_model,
    inputTokens: stats.total_input_tokens,
    outputTokens: stats.total_output_tokens,
    cacheReadTokens: stats.total_cache_read_tokens,
    cacheCreationTokens: stats.total_cache_write_tokens,
    // Antigravity `output_tokens` already includes thinking. The stats
    // reasoning total is a text estimate and must not be billed again.
    reasoningTokens:
      cli === "antigravity" || cli === "agy" ? undefined : stats.total_reasoning_tokens,
    inputIncludesCache: false,
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined,
  });
}


