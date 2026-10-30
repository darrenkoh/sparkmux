import assert from "node:assert/strict";
import { test } from "node:test";

import { counters } from "./officeModel.ts";
import { createSim } from "./officeSim.ts";

test("simulation is deterministic and counters cover every agent", () => {
  const times: number[] = [];
  let now = 1_700_000_000_000;
  for (let index = 0; index < 30; index += 1) {
    times.push(now);
    now += 5_000;
  }
  const play = () => {
    const sim = createSim(42, 8);
    return times.map((tick) => sim.tick(tick));
  };
  const first = play();
  const second = play();
  assert.deepEqual(first, second);
  assert.equal(first[0]?.agents.length, 8);
  assert.equal(first[0]?.free_desks.length, 2);
  const clis = first[0]?.agents.map((agent) => agent.cli) ?? [];
  assert.equal(clis.filter((cli) => cli === "claude").length, 4);
  assert.equal(clis.filter((cli) => cli === "grok").length, 2);
  assert.equal(clis.filter((cli) => cli === "antigravity").length, 2);
  for (const snap of first) {
    const counted = counters(snap);
    assert.equal(counted.working + counted.needYou + counted.idle, snap.agents.length);
    assert.equal(counted.freeDesks, snap.free_desks.length);
  }
  const other = createSim(7, 8).tick(times[0] ?? 0);
  assert.notDeepEqual(
    other.agents.map((agent) => agent.activity),
    first[0]?.agents.map((agent) => agent.activity),
  );
});
