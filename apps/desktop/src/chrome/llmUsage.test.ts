import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowanceWatchKey,
  amountLeft,
  parseAgyUsageScreen,
  usageChips,
  usageTone,
  type LlmUsage,
  type UsageBar,
} from "./llmUsage.ts";

const ZONE = "America/Los_Angeles";
const GROK_RESET = Date.parse("2026-10-13T21:22:33.541Z");
const NOW = Date.parse("2026-10-10T20:00:00Z");

function bar(partial: Partial<UsageBar> & Pick<UsageBar, "percent" | "direction">): UsageBar {
  return {
    group: null,
    label: "Weekly",
    resets_at_ms: null,
    ...partial,
  };
}

function usage(partial: Partial<LlmUsage>): LlmUsage {
  return {
    cli: null,
    bars: [],
    fetched_at_ms: null,
    plan: null,
    credits_usd: null,
    ...partial,
  };
}

test("a shell pane and a cli with no payload show nothing", () => {
  assert.deepEqual(usageChips(null, NOW), []);
  assert.deepEqual(usageChips(usage({ cli: null }), NOW), []);
  assert.deepEqual(usageChips(usage({ cli: "claude" }), NOW), []);
  assert.deepEqual(usageChips(usage({ cli: "antigravity" }), NOW), []);
});

test("grok shows weekly used percent and the local reset", () => {
  const chips = usageChips(
    usage({
      cli: "grok",
      plan: "SuperGrok Plus",
      credits_usd: 10,
      fetched_at_ms: NOW - 2 * 60 * 1000,
      bars: [bar({ percent: 70, direction: "used", resets_at_ms: GROK_RESET })],
    }),
    NOW,
    ZONE,
  );
  assert.equal(chips.length, 1);
  assert.equal(chips[0].text, "Grok 30% Remaining - Resets:3d 1h 22m 33s");
  assert.equal(chips[0].fill, 30);
  assert.equal(chips[0].tone, "warn");
  assert.match(chips[0].title, /SuperGrok Plus/);
  assert.match(chips[0].title, /Weekly 30% Remaining, resets Oct 13, 14:22/);
  assert.match(chips[0].title, /Credits \$10\.00/);
  assert.match(chips[0].title, /fetched 2m ago/);
});

test("a grok window inside a day uses a relative reset", () => {
  const chips = usageChips(
    usage({
      cli: "grok",
      bars: [
        bar({
          percent: 12,
          direction: "used",
          resets_at_ms: NOW + (3 * 60 + 55) * 60 * 1000,
        }),
      ],
    }),
    NOW,
  );
  assert.equal(chips[0].text, "Grok 88% Remaining - Resets:3h 55m 0s");
  assert.equal(chips[0].tone, "ok");
});

test("claude shows the five hour and weekly used meters", () => {
  const chips = usageChips(
    usage({
      cli: "claude",
      bars: [
        bar({ label: "5 hour", percent: 12, direction: "used", resets_at_ms: NOW + 3_600_000 }),
        bar({ label: "Week", percent: 40, direction: "used", resets_at_ms: GROK_RESET }),
        bar({ label: "Week Sonnet", percent: 8, direction: "used", resets_at_ms: GROK_RESET }),
      ],
    }),
    NOW,
    ZONE,
  );
  assert.equal(chips.length, 1);
  assert.equal(
    chips[0].text,
    "Claude 5h 88% Remaining - Resets:1h 0m 0s · wk 60% Remaining - Resets:3d 1h 22m 33s",
  );
  assert.equal(chips[0].fill, 60);
  assert.equal(chips[0].tone, "ok");
  assert.match(chips[0].title, /Week Sonnet 92% Remaining/);
});

test("antigravity shows each group and the tighter window", () => {
  const weekReset = NOW + 148 * 3_600_000 + 52 * 60_000;
  const chips = usageChips(
    usage({
      cli: "antigravity",
      bars: [
        bar({
          group: "Gemini",
          label: "Weekly",
          percent: 83.96,
          direction: "remaining",
          resets_at_ms: weekReset,
        }),
        bar({
          group: "Claude",
          label: "Weekly",
          percent: 48.91,
          direction: "remaining",
          resets_at_ms: weekReset,
        }),
        bar({
          group: "Claude",
          label: "5 hour",
          percent: 100,
          direction: "remaining",
          resets_at_ms: NOW + (3 * 60 + 55) * 60 * 1000,
        }),
      ],
    }),
    NOW,
  );
  assert.deepEqual(
    chips.map((item) => item.text),
    [
      "Gemini 84% Remaining - Resets:6d 4h 52m 0s",
      "Claude 49% Remaining - Resets:6d 4h 52m 0s",
    ],
  );
  assert.equal(chips[0].tone, "ok");
  assert.equal(chips[1].tone, "warn");
  assert.equal(chips[0].fill, 83.96);

  const tighter = usageChips(
    usage({
      cli: "antigravity",
      bars: [
        bar({
          group: "Gemini",
          percent: 84,
          direction: "remaining",
          resets_at_ms: weekReset,
        }),
        bar({
          group: "Gemini",
          label: "5 hour",
          percent: 40,
          direction: "remaining",
          resets_at_ms: NOW + (3 * 60 + 55) * 60 * 1000,
        }),
      ],
    }),
    NOW,
  );
  assert.equal(tighter[0].text, "Gemini 40% Remaining - Resets:3h 55m 0s");
  assert.equal(tighter[0].tone, "warn");
});

test("antigravity usage screen becomes the footer chips", () => {
  const screen = `
Models & Quota
GEMINI MODELS
  Weekly Limit Remaining
    [bar] 76.23%
    Refreshes in 134h 57m
  Five Hour Limit Remaining
    [bar] 96.10%
    Refreshes in 4h 50m
CLAUDE AND GPT MODELS
  Weekly Limit Remaining
    [bar] 48.91%
    Refreshes in 134h 54m
  Five Hour Limit Remaining
    [bar] 100.00%
    Quota available
`;
  const parsed = parseAgyUsageScreen(screen, NOW);
  assert.equal(parsed?.cli, "antigravity");
  assert.equal(parsed?.fetched_at_ms, NOW);
  const chips = usageChips(parsed, NOW);
  assert.deepEqual(
    chips.map((item) => item.text),
    [
      "Gemini 76% Remaining - Resets:5d 14h 57m 0s",
      "Claude 49% Remaining - Resets:5d 14h 54m 0s",
    ],
  );
  assert.equal(chips[0].fill, 76.23);
  assert.equal(chips[0].tone, "ok");
  assert.equal(chips[1].tone, "warn");

  const tighter = parseAgyUsageScreen(
    `
GEMINI MODELS
  Weekly Limit Remaining
    84%
    Refreshes in 149h
  Five Hour Limit Remaining
    40%
    Refreshes in 3h 55m
`,
    NOW,
  );
  assert.equal(usageChips(tighter, NOW)[0].text, "Gemini 40% Remaining - Resets:3h 55m 0s");
  assert.equal(parseAgyUsageScreen("just a shell prompt\n%", NOW), null);
});

test("the poll key ignores a changing agent title", () => {
  assert.equal(
    allowanceWatchKey("grok-1.0.50", "thinking - grok"),
    allowanceWatchKey("/usr/local/bin/grok-1.0.50", "editing - grok"),
  );
  assert.equal(allowanceWatchKey("zsh", "Claude Code"), "agent:shell:claude code");
  assert.equal(allowanceWatchKey("agy", "agy"), allowanceWatchKey("agy", "running - agy"));
  assert.equal(allowanceWatchKey("zsh", "zsh"), "shell");
  assert.notEqual(allowanceWatchKey("zsh", "zsh"), allowanceWatchKey("claude", "Claude Code"));
});

test("color follows how much allowance is left", () => {
  assert.equal(usageTone(50.1), "ok");
  assert.equal(usageTone(50), "warn");
  assert.equal(usageTone(20), "warn");
  assert.equal(usageTone(19.9), "hot");
  assert.equal(amountLeft(bar({ percent: 70, direction: "used" })), 30);
  assert.equal(amountLeft(bar({ percent: 84, direction: "remaining" })), 84);
});
