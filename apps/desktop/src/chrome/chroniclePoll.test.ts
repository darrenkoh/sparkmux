import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptHologram,
  generationFromSession,
  nextActive,
  resolveActiveAfterPoll,
  sameGeneration,
  shouldRefetchHologram,
  type ChronicleGenerationSource,
} from "./chroniclePoll.ts";

function source(outcomes: { id: string; outcome: string; ordinal: number }[]): ChronicleGenerationSource {
  return {
    transcript_len: 20,
    transcript_mtime_ms: 5,
    events_mtime_ms: 7,
    truncated_tail: false,
    stations: outcomes,
    now: [{ path: "a.ts", worktree_mtime_ms: 3 }],
  };
}

test("the same ids with a new outcome are a different generation and refetch", () => {
  const before = generationFromSession(source([{ id: "s1", outcome: "unknown", ordinal: 0 }]));
  const after = generationFromSession(
    source([
      { id: "s1", outcome: "error", ordinal: 1 },
      { id: "s0", outcome: "ok", ordinal: 0 },
    ]),
  );
  assert.equal(before.outcomes, "s1=unknown");
  assert.equal(after.outcomes, "s0=ok\ns1=error");
  assert.equal(sameGeneration(before, after), false);
  assert.equal(
    shouldRefetchHologram({ id: "s1", generation: before }, { id: "s1", generation: after }),
    true,
  );
  assert.equal(
    shouldRefetchHologram({ id: "s1", generation: before }, { id: "s1", generation: before }),
    false,
  );
  const moved = generationFromSession({
    ...source([{ id: "s1", outcome: "unknown", ordinal: 0 }]),
    events_mtime_ms: 8,
  });
  assert.equal(sameGeneration(before, moved), false);
});

test("a hologram response with the wrong station or generation is ignored", () => {
  const current = generationFromSession(source([{ id: "s1", outcome: "ok", ordinal: 0 }]));
  const stale = generationFromSession(source([{ id: "s1", outcome: "unknown", ordinal: 0 }]));
  assert.equal(acceptHologram("s1", "s1", current, current), true);
  assert.equal(acceptHologram("s2", "s1", current, current), false);
  assert.equal(acceptHologram("s1", "s1", stale, current), false);
});

test("nextActive keeps a missing id instead of selecting the last one", () => {
  const missing = nextActive("gone", ["a", "b", "c"]);
  assert.deepEqual(missing, { id: "gone", stale: true });
  assert.notEqual(missing.id, "c");
  assert.deepEqual(nextActive("b", ["a", "b", "c"]), { id: "b", stale: false });
});

test("follow-live advances only from the previous newest real station", () => {
  const advanced = resolveActiveAfterPoll("s1", "s1", ["s1", "s2"], ["now:a.ts"]);
  assert.deepEqual(advanced, { id: "s2", stale: false, newestRealId: "s2" });

  const scrubbed = resolveActiveAfterPoll("s0", "s1", ["s0", "s1", "s2"], []);
  assert.deepEqual(scrubbed, { id: "s0", stale: false, newestRealId: "s2" });

  const slid = resolveActiveAfterPoll("gone", "gone", ["s1", "s2"], []);
  assert.deepEqual(slid, { id: "gone", stale: true, newestRealId: "s2" });
  assert.notEqual(slid.id, "s2");

  const stayedOnNow = resolveActiveAfterPoll("now:a.ts", "s1", ["s1", "s2"], ["now:a.ts"]);
  assert.deepEqual(stayedOnNow, { id: "now:a.ts", stale: false, newestRealId: "s2" });
});
