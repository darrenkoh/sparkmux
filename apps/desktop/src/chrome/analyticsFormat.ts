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

export function formatUsd(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return "< $0.01";
  return `$${cost.toFixed(2)}`;
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

  // Gemini / Flash / Mini / Light
  if (m.includes("flash") || m.includes("mini") || m.includes("8b") || m.includes("nano")) {
    return { inRate: 0.25, outRate: 1.25, cacheReadRate: 0.03, cacheWriteRate: 0.25 };
  }

  // Grok
  if (m.includes("grok")) {
    return { inRate: 2.0, outRate: 10.0, cacheReadRate: 0.2, cacheWriteRate: 2.5 };
  }

  // Default / fallback standard pricing (e.g. Sonnet tier 3/15)
  return { inRate: 3.0, outRate: 15.0, cacheReadRate: 0.3, cacheWriteRate: 3.75 };
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

