import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatBytes,
  formatNum,
  formatMs,
  formatDuration,
  formatUsd,
  formatSessionUsd,
  estimateCost,
  estimateTotalCost,
  estimateCostSavings,
  getModelPricing,
  GROK_USD_TICKS,
  sessionCost,
  sessionCostFromStats,
} from "./analyticsFormat.ts";

test("formatBytes formats small and large bytes correctly", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(1048576 * 3.5), "3.50 MB");
});

test("formatNum formats metric counts with suffixes", () => {
  assert.equal(formatNum(42), "42");
  assert.equal(formatNum(1200), "1.2k");
  assert.equal(formatNum(3500000), "3.50M");
});

test("formatMs formats milliseconds and seconds", () => {
  assert.equal(formatMs(50), "50ms");
  assert.equal(formatMs(1200), "1.2s");
});

test("formatDuration reads as a clock span", () => {
  assert.equal(formatDuration(50), "50ms");
  assert.equal(formatDuration(10530), "11s");
  assert.equal(formatDuration(113540), "1m 54s");
  assert.equal(formatDuration(3_600_000), "1h");
});

test("formatUsd formats dollar values correctly", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.004), "< $0.01");
  assert.equal(formatUsd(0.143), "$0.14");
  assert.equal(formatUsd(2.5), "$2.50");
});

test("estimateCost computes cost for standard and light models", () => {
  const standardCost = estimateCost("claude-3-5-sonnet", 10_000, 2_000, 50_000);
  // (10000 / 1M) * 3 + (2000 / 1M) * 15 + (50000 / 1M) * 0.3 = 0.03 + 0.03 + 0.015 = 0.075
  assert.ok(Math.abs(standardCost - 0.075) < 0.0001);

  const flashCost = estimateCost("gemini-2.0-flash", 100_000, 10_000, 200_000);
  // (100k / 1M) * 0.25 + (10k / 1M) * 1.25 + (200k / 1M) * 0.03 = 0.025 + 0.0125 + 0.006 = 0.0435
  assert.ok(Math.abs(flashCost - 0.0435) < 0.0001);
});

test("estimateCost accurately calculates Claude Haiku 4.5 pricing", () => {
  const pricing = getModelPricing("claude-haiku-4-5-20251001");
  assert.equal(pricing.inRate, 1.0);
  assert.equal(pricing.outRate, 5.0);
  assert.equal(pricing.cacheReadRate, 0.1);
  assert.equal(pricing.cacheWriteRate, 1.25);

  // Haiku 4.5 with 803 in, 23 out, 12M cache read, 600k cache write
  const haikuCost = estimateCost("claude-haiku-4-5-20251001", 803, 23, 12_000_000, 600_000);
  // 803/1e6*1 + 23/1e6*5 + 12*0.1 + 0.6*1.25 = 0.000803 + 0.000115 + 1.20 + 0.75 = 1.9509
  assert.ok(Math.abs(haikuCost - 1.950918) < 0.001);
});

test("estimateTotalCost calculates cost per model breakdown", () => {
  const models = [
    {
      model: "claude-haiku-4-5-20251001",
      input_tokens: 803,
      output_tokens: 23,
      cache_read_tokens: 12_000_000,
      cache_write_tokens: 600_000,
    },
  ];
  const totalCost = estimateTotalCost(models, "claude-haiku-4-5", 803, 23, 12_000_000, 600_000);
  assert.ok(Math.abs(totalCost - 1.950918) < 0.001);
});

test("estimateCost accurately calculates Grok 4.7 pricing matching /usage ticks", () => {
  const pricing47 = getModelPricing("grok-4.7-build");
  assert.equal(pricing47.inRate, 0.68);
  assert.equal(pricing47.outRate, 2.04);
  assert.equal(pricing47.cacheReadRate, 0.17);
  assert.equal(pricing47.cacheWriteRate, 0.68);

  // Exact real Grok session: 275,458 uncached input, 8,007,040 cached read, 104,402 output
  // costUsdTicks = 17,614,883,200 ($1.76148832)
  const grokCost = estimateCost("grok-4.7-build", 275_458, 104_402, 8_007_040);
  assert.ok(Math.abs(grokCost - 1.761488) < 0.0001);

  const pricing46 = getModelPricing("grok-4.6-build");
  assert.equal(pricing46.inRate, 1.36);
  assert.equal(pricing46.outRate, 4.08);
  assert.equal(pricing46.cacheReadRate, 0.34);
});

test("estimateCostSavings computes prompt caching discount correctly", () => {
  // Claude 3.5 Sonnet: inRate $3.00, cacheReadRate $0.30 -> discount is $2.70 per 1M tokens
  const savings = estimateCostSavings(undefined, "claude-3-5-sonnet", 1_000_000);
  assert.ok(Math.abs(savings - 2.70) < 0.0001);

  // With explicit models array: Haiku 4.5 inRate $1.00, cacheRead $0.10 -> discount is $0.90 per 1M tokens
  const models = [
    {
      model: "claude-haiku-4-5",
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 2_000_000,
    },
  ];
  const modelSavings = estimateCostSavings(models, undefined, 0);
  assert.ok(Math.abs(modelSavings - 1.80) < 0.0001);
});

const GROK_DIVERGE = {
  provider: "grok" as const,
  model: "grok-4.7",
  inputIncludesCache: true,
  inputTokens: 2_000_000,
  cachedReadTokens: 1_000_000,
  outputTokens: 1_000_000,
  reasoningTokens: 500_000,
  costUsdTicks: 12_345_000_000,
  modelUsage: {
    "grok-4.7": {
      costUsdTicks: 8_000_000_000,
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cachedReadTokens: 1_000_000,
      reasoningTokens: 500_000,
    },
  },
};

test("Grok session cost equals costUsdTicks and not the flat reprice", () => {
  const cost = sessionCost(GROK_DIVERGE);
  const stamped = GROK_DIVERGE.costUsdTicks / GROK_USD_TICKS;
  const uncached = estimateCost("grok-4.7", 1_000_000, 1_000_000, 1_000_000, 0);
  const doubleCounted = estimateCost("grok-4.7", 2_000_000, 1_000_000, 1_000_000, 0);
  const withReasoning = estimateCost("grok-4.7", 1_000_000, 1_500_000, 1_000_000, 0);
  assert.equal(cost.stamped, true);
  assert.equal(cost.usd, stamped);
  assert.notEqual(cost.usd, uncached);
  assert.notEqual(cost.usd, doubleCounted);
  assert.notEqual(cost.usd, withReasoning);
  assert.ok(Math.abs(uncached - 2.89) < 1e-9);
  assert.deepEqual(cost.models, [{ model: "grok-4.7", usd: 8_000_000_000 / GROK_USD_TICKS }]);
  assert.notEqual(cost.models[0].usd, uncached);

  const fromStats = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify(GROK_DIVERGE),
      total_input_tokens: 1_000_000,
      total_output_tokens: 1_000_000,
      total_cache_read_tokens: 1_000_000,
      total_reasoning_tokens: 500_000,
      active_model: "grok-4.7",
      models: [
        {
          model: "grok-4.7",
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_tokens: 1_000_000,
        },
      ],
    },
    "grok",
  );
  assert.equal(fromStats.usd, stamped);
  assert.equal(fromStats.stamped, true);
  assert.notEqual(fromStats.usd, uncached);
});

test("a partial Grok ledger is not a rate-table stand-in", () => {
  const partial = {
    provider: "grok" as const,
    model: "grok-4.7",
    inputIncludesCache: true,
    costIsPartial: true,
    usageIsIncomplete: true,
    inputTokens: 2_000_000,
    cachedReadTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
    modelUsage: {
      "grok-4.7": {
        costUsdTicks: 50_000_000_000,
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        cachedReadTokens: 1_000_000,
      },
    },
  };
  const cost = sessionCost(partial);
  const flat = estimateCost("grok-4.7", 1_000_000, 1_000_000, 1_000_000, 0);
  assert.equal(cost.usd, null);
  assert.equal(cost.stamped, false);
  assert.deepEqual(cost.models, []);
  assert.notEqual(cost.usd, flat);
  assert.notEqual(cost.usd, 50_000_000_000 / GROK_USD_TICKS);

  const fromStats = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify(partial),
      total_input_tokens: 1_000_000,
      total_output_tokens: 1_000_000,
      total_cache_read_tokens: 1_000_000,
      active_model: "grok-4.7",
    },
    "grok",
  );
  assert.equal(fromStats.usd, null);
  assert.notEqual(fromStats.usd, flat);

  const withTicks = sessionCost({ ...partial, costUsdTicks: 12_345_000_000 });
  assert.equal(withTicks.usd, 12_345_000_000 / GROK_USD_TICKS);
  assert.equal(withTicks.stamped, true);
  assert.deepEqual(withTicks.models, []);
});

test("Grok uncached input is billed once when the stamp is absent", () => {
  const ledger = {
    provider: "grok" as const,
    model: "grok-4.7",
    inputIncludesCache: true,
    inputTokens: 2_000_000,
    cachedReadTokens: 1_000_000,
    outputTokens: 100_000,
    reasoningTokens: 1_000_000,
  };
  const cost = sessionCost(ledger);
  const once = estimateCost("grok-4.7", 1_000_000, 100_000, 1_000_000, 0);
  const doubled = estimateCost("grok-4.7", 2_000_000, 100_000, 1_000_000, 0);
  const reasoningAsOutput = estimateCost("grok-4.7", 1_000_000, 1_100_000, 1_000_000, 0);
  assert.equal(cost.stamped, false);
  assert.equal(cost.usd, once);
  assert.notEqual(cost.usd, doubled);
  assert.notEqual(cost.usd, reasoningAsOutput);
});

test("Claude session cost equals totalCostUSD and per-model costUSD", () => {
  // costUSD is the stamp `/usage` prints. The sonnet row's cache-write
  // charge and the haiku row's web-search charge are already inside it.
  const ledger = {
    provider: "claude" as const,
    totalCostUSD: 1.48,
    hasUnknownModelCost: true,
    inputIncludesCache: false,
    modelUsage: {
      "claude-sonnet-4-5": {
        costUSD: 1.11,
        inputTokens: 100_000,
        outputTokens: 10_000,
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 20_000,
      },
      "claude-haiku-4-5": {
        costUSD: 0.22,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 4,
      },
    },
  };
  const cost = sessionCost(ledger);
  const list = estimateTotalCost(
    [
      {
        model: "claude-sonnet-4-5",
        input_tokens: 100_000,
        output_tokens: 10_000,
        cache_read_tokens: 50_000,
        cache_write_tokens: 20_000,
      },
      {
        model: "claude-haiku-4-5",
        input_tokens: 1_000,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    ],
    "claude-sonnet-4-5",
    101_000,
    10_100,
    50_000,
    20_000,
  );
  assert.equal(cost.stamped, true);
  assert.equal(cost.usd, 1.48);
  assert.notEqual(cost.usd, list);
  assert.notEqual(cost.usd, 1.11 + 0.22);
  assert.notEqual(cost.usd, 1.48 + list);
  assert.deepEqual(cost.models, [
    { model: "claude-sonnet-4-5", usd: 1.11 },
    { model: "claude-haiku-4-5", usd: 0.22 },
  ]);
  assert.notEqual(
    cost.models[0].usd,
    estimateCost("claude-sonnet-4-5", 100_000, 10_000, 50_000, 20_000),
  );

  const fromStats = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify(ledger),
      total_input_tokens: 100_000,
      total_output_tokens: 10_000,
      total_cache_read_tokens: 50_000,
      total_cache_write_tokens: 20_000,
      active_model: "claude-sonnet-4-5",
    },
    "claude",
  );
  assert.equal(fromStats.usd, 1.48);
  assert.equal(fromStats.models[1].usd, 0.22);

  const recordedZero = sessionCost({
    provider: "claude",
    totalCostUSD: 0,
    hasUnknownModelCost: false,
    inputTokens: 100_000,
    outputTokens: 10_000,
    model: "claude-sonnet-4-5",
  });
  assert.equal(recordedZero.usd, 0);
  assert.equal(recordedZero.stamped, true);
  assert.notEqual(recordedZero.usd, estimateCost("claude-sonnet-4-5", 100_000, 10_000, 0, 0));

  const bedrockUnpriced = sessionCost({
    provider: "claude",
    totalCostUSD: 0,
    hasUnknownModelCost: true,
    inputTokens: 100_000,
    outputTokens: 10_000,
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  });
  assert.equal(bedrockUnpriced.stamped, false);
  assert.equal(
    bedrockUnpriced.usd,
    estimateCost("anthropic.claude-3-5-sonnet-20241022-v2:0", 100_000, 10_000, 0, 0),
  );

  const bedrockFromStats = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify({
        provider: "claude",
        totalCostUSD: 0,
        hasUnknownModelCost: true,
      }),
      models: [
        {
          model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
          input_tokens: 100_000,
          output_tokens: 10_000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      ],
      total_input_tokens: 100_000,
      total_output_tokens: 10_000,
      active_model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    },
    "claude",
  );
  assert.equal(bedrockFromStats.stamped, false);
  assert.equal(
    bedrockFromStats.usd,
    estimateCost("anthropic.claude-3-5-sonnet-20241022-v2:0", 100_000, 10_000, 0, 0),
  );
});

test("formatSessionUsd matches Claude /usage decimals", () => {
  assert.equal(formatSessionUsd(1.234), "$1.23");
  assert.equal(formatSessionUsd(0.51), "$0.51");
  assert.equal(formatSessionUsd(0.5), "$0.5000");
  assert.equal(formatSessionUsd(0.143), "$0.1430");
  assert.equal(formatSessionUsd(0.004), "$0.0040");
  assert.notEqual(formatSessionUsd(0.004), "< $0.01");
  assert.notEqual(formatSessionUsd(0.143), "$0.14");
  assert.equal(formatSessionUsd(0), "$0.00");
  assert.equal(formatSessionUsd(null), "—");
  assert.equal(formatUsd(0.004), "< $0.01");
});

test("Claude uncached input is not reduced by cache reads", () => {
  const ledger = {
    provider: "claude" as const,
    model: "claude-sonnet-4-5",
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 5_000,
    cacheCreationTokens: 200,
    reasoningTokens: 50_000,
  };
  const cost = sessionCost(ledger);
  const once = estimateCost("claude-sonnet-4-5", 1_000, 100, 5_000, 200);
  const stripped = estimateCost("claude-sonnet-4-5", 0, 100, 5_000, 200);
  const reasoningAsOutput = estimateCost("claude-sonnet-4-5", 1_000, 50_100, 5_000, 200);
  assert.equal(cost.stamped, false);
  assert.equal(cost.usd, once);
  assert.notEqual(cost.usd, stripped);
  assert.notEqual(cost.usd, reasoningAsOutput);
});

const AGY_CUMULATIVE = {
  provider: "antigravity" as const,
  model: "gemini-4-argon",
  estimatedCostUsd: 0.87,
  reasoningTokens: 1_000_000,
  toolTokens: 10_000,
  quotaPercent: 40,
  categories: {
    input: { tokens: 100_000, estimatedCostUsd: 0.1 },
    cacheRead: { tokens: 200_000, estimatedCostUsd: 0.02 },
    output: { tokens: 50_000, estimatedCostUsd: 0.3 },
    thinking: { tokens: 1_000_000, estimatedCostUsd: 0.4 },
    tools: { tokens: 10_000, estimatedCostUsd: 0.05 },
  },
  pricing: {
    modelName: "gemini-4-argon",
    inputPricePerMillionTokens: 1.25,
    outputPricePerMillionTokens: 10,
    cacheReadPricePerMillionTokens: 0.125,
  },
};

test("Antigravity session cost equals the cumulative estimated_cost_usd", () => {
  const cost = sessionCost(AGY_CUMULATIVE);
  const thinkingAgain = 0.87 + (1_000_000 / 1_000_000) * 10;
  assert.equal(cost.stamped, true);
  assert.equal(cost.usd, 0.87);
  assert.notEqual(cost.usd, thinkingAgain);
  assert.notEqual(cost.usd, 40);
  assert.notEqual(cost.usd, 0.4);

  const fromStats = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify(AGY_CUMULATIVE),
      total_input_tokens: 100_000,
      total_output_tokens: 50_000,
      total_reasoning_tokens: 1_000_000,
      active_model: "gemini-4-argon",
    },
    "antigravity",
  );
  assert.equal(fromStats.usd, 0.87);
  assert.equal(fromStats.stamped, true);
  assert.notEqual(fromStats.usd, thinkingAgain);
});

test("Antigravity Argon fallback uses the pricing block", () => {
  const ledger = {
    provider: "antigravity" as const,
    model: "gemini-4-argon",
    inputTokens: 1_000_000,
    cacheReadTokens: 2_000_000,
    outputTokens: 100_000,
    reasoningTokens: 50_000,
    toolTokens: 10_000,
    pricing: {
      modelName: "gemini-4-argon",
      inputPricePerMillionTokens: 1.25,
      outputPricePerMillionTokens: 10,
      cacheReadPricePerMillionTokens: 0.125,
    },
  };
  const cost = sessionCost(ledger);
  const catalog = getModelPricing("gemini-4-argon");
  assert.notEqual(catalog.inRate, 0.25);
  assert.notEqual(catalog.outRate, 1.25);
  const sonnet = getModelPricing("claude-sonnet-4-5");
  assert.equal(sonnet.inRate, 3);
  assert.equal(sonnet.outRate, 15);
  const asList = estimateCost("gemini-4-argon", 1_000_000, 160_000, 2_000_000, 0);
  const asSonnet = estimateCost("claude-sonnet-4-5", 1_000_000, 160_000, 2_000_000, 0);
  const asLegacyFlash =
    (1_000_000 / 1_000_000) * 0.25 +
    (160_000 / 1_000_000) * 1.25 +
    (2_000_000 / 1_000_000) * 0.03;
  assert.equal(cost.stamped, false);
  assert.ok(cost.usd != null && Math.abs(cost.usd - 3.1) < 1e-9);
  assert.notEqual(cost.usd, asList);
  assert.notEqual(cost.usd, asSonnet);
  assert.notEqual(cost.usd, asLegacyFlash);
  assert.ok(Math.abs((cost.usd ?? 0) - 3.6) > 0.01);
  assert.ok(Math.abs((cost.usd ?? 0) - 3.0) > 0.01);
});

test("a quota percent is not a dollar cost", () => {
  const cost = sessionCost({
    provider: "antigravity",
    model: "gemini-4-argon",
    quotaPercent: 40,
  });
  assert.equal(cost.usd, null);
  assert.equal(cost.stamped, false);
  assert.equal(formatSessionUsd(cost.usd), "—");
  assert.notEqual(cost.usd, 40);
  assert.notEqual(cost.usd, 0.4);
});

test("Antigravity planner rows are priced from the model list until a stamp arrives", () => {
  const categories = {
    input: { tokens: 4842 },
    cacheRead: { tokens: 38177 },
    output: { tokens: 182 },
  };
  const tokensOnly = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify({
        provider: "antigravity",
        inputIncludesCache: false,
        categories,
      }),
      total_input_tokens: 4842,
      total_output_tokens: 182,
      total_cache_read_tokens: 38177,
      total_reasoning_tokens: 40,
      active_model: "gemini-4-argon",
    },
    "antigravity",
  );
  const listed = estimateCost("gemini-4-argon", 4842, 182, 38177, 0);
  const sonnet = estimateCost("claude-sonnet-4-5", 4842, 182 + 40, 38177, 0);
  const legacyFlash =
    (4842 / 1_000_000) * 0.25 + (222 / 1_000_000) * 1.25 + (38177 / 1_000_000) * 0.03;
  assert.equal(tokensOnly.stamped, false);
  assert.ok(tokensOnly.usd != null && Math.abs(tokensOnly.usd - listed) < 1e-9);
  assert.notEqual(formatSessionUsd(tokensOnly.usd), "—");
  assert.ok(Math.abs((tokensOnly.usd ?? 0) - sonnet) > 1e-6);
  assert.ok(Math.abs((tokensOnly.usd ?? 0) - legacyFlash) > 1e-6);

  const stamped = sessionCostFromStats(
    {
      cost_ledger: JSON.stringify({
        provider: "antigravity",
        inputIncludesCache: false,
        estimatedCostUsd: 0.5,
        categories,
      }),
      total_input_tokens: 4842,
      total_output_tokens: 182,
      total_cache_read_tokens: 38177,
      total_reasoning_tokens: 40,
      active_model: "gemini-4-argon",
    },
    "antigravity",
  );
  assert.equal(stamped.usd, 0.5);
  assert.equal(stamped.stamped, true);
  assert.notEqual(stamped.usd, 0.75);
  assert.equal(formatSessionUsd(stamped.usd), "$0.5000");
});

test("an unnamed Antigravity session is priced as Gemini 3.8 Flash", () => {
  const cost = sessionCostFromStats(
    {
      total_input_tokens: 1_508_764,
      total_output_tokens: 229_893,
      total_cache_read_tokens: 45_960_483,
      total_reasoning_tokens: 28_201,
      active_model: "",
    },
    "antigravity",
  );
  const listed = estimateCost("gemini-3.8-flash", 1_508_764, 229_893, 45_960_483, 0);
  const withThinking = estimateCost(
    "gemini-3.8-flash",
    1_508_764,
    229_893 + 28_201,
    45_960_483,
    0,
  );
  const sonnet = estimateCost("claude-sonnet-4-5", 1_508_764, 229_893, 45_960_483, 0);
  assert.equal(cost.stamped, false);
  assert.ok(cost.usd != null && Math.abs(cost.usd - listed) < 1e-6);
  assert.ok(Math.abs(cost.usd - withThinking) > 0.01);
  assert.ok(Math.abs(cost.usd - sonnet) > 1);
  assert.notEqual(formatSessionUsd(cost.usd), "—");
  const named = getModelPricing("Gemini 3.8 Flash (Medium)");
  assert.equal(named.inRate, getModelPricing("gemini-3.8-flash").inRate);
  assert.equal(named.outRate, getModelPricing("gemini-3.8-flash").outRate);
});


