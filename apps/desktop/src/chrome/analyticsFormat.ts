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

export function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const m = (model || "").toLowerCase();
  let inRate = 3.0; // USD per 1M tokens
  let outRate = 15.0;
  let cacheRate = 0.30;

  if (m.includes("haiku") || m.includes("flash") || m.includes("mini") || m.includes("8b")) {
    inRate = 0.25;
    outRate = 1.25;
    cacheRate = 0.03;
  } else if (m.includes("opus")) {
    inRate = 15.0;
    outRate = 75.0;
    cacheRate = 1.50;
  } else if (m.includes("grok")) {
    inRate = 2.0;
    outRate = 10.0;
    cacheRate = 0.20;
  }

  return (
    (Math.max(0, inputTokens) / 1_000_000) * inRate +
    (Math.max(0, outputTokens) / 1_000_000) * outRate +
    (Math.max(0, cacheReadTokens) / 1_000_000) * cacheRate
  );
}
