import assert from "node:assert/strict";
import { test } from "node:test";

import { layoutOffice, routeBetween, type DeskSlot, type OfficeLayout } from "./officeLayout.ts";

function deskBoxes(layout: OfficeLayout): Array<{ key: string; x0: number; z0: number; x1: number; z1: number }> {
  const boxes = [];
  for (const pod of layout.pods) {
    for (const desk of pod.desks) {
      boxes.push({
        key: desk.key,
        x0: desk.pos[0] - 0.8,
        z0: desk.pos[1] - 0.4,
        x1: desk.pos[0] + 0.8,
        z1: desk.pos[1] + 0.4,
      });
    }
  }
  return boxes;
}

function overlaps(
  left: { x0: number; z0: number; x1: number; z1: number },
  right: { x0: number; z0: number; x1: number; z1: number },
): boolean {
  return left.x0 < right.x1 - 1e-6 && right.x0 < left.x1 - 1e-6 && left.z0 < right.z1 - 1e-6 && right.z0 < left.z1 - 1e-6;
}

test("layout is deterministic and desks stay inside the room without overlap", () => {
  const input = [
    { session: "zeta", keys: ["z:2", "z:1"] },
    { session: "alpha", keys: ["a:1", "a:2", "a:3"] },
    { session: "mid", keys: ["m:1"] },
  ];
  const first = layoutOffice(input);
  const second = layoutOffice([input[1]!, input[0]!, input[2]!]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.pods.map((pod) => pod.session),
    ["alpha", "mid", "zeta"],
  );
  assert.equal(first.pods[0]?.label, "ALPHA");
  const boxes = deskBoxes(first);
  assert.equal(boxes.length, 6);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.equal(overlaps(boxes[i]!, boxes[j]!), false, `${boxes[i]?.key} overlaps ${boxes[j]?.key}`);
    }
  }
  for (const pod of first.pods) {
    for (const desk of pod.desks) {
      assert.ok(desk.pos[0] - 0.8 >= 0 && desk.pos[0] + 0.8 <= first.room.w, desk.key);
      assert.ok(desk.pos[1] - 0.4 >= 0 && desk.pos[1] + 0.4 <= first.room.d, desk.key);
      assert.ok(desk.chair[0] >= 0 && desk.chair[0] <= first.room.w);
      assert.ok(desk.chair[1] >= 0 && desk.chair[1] <= first.room.d);
    }
  }
});

test("adding an agent to a later session does not move earlier desks", () => {
  const before = layoutOffice([
    { session: "alpha", keys: ["a:1", "a:2"] },
    { session: "beta", keys: ["b:1"] },
  ]);
  const after = layoutOffice([
    { session: "beta", keys: ["b:2", "b:1"] },
    { session: "alpha", keys: ["a:2", "a:1"] },
  ]);
  assert.deepEqual(
    before.pods.find((pod) => pod.session === "alpha")?.desks,
    after.pods.find((pod) => pod.session === "alpha")?.desks,
  );
  assert.equal(after.pods.find((pod) => pod.session === "beta")?.desks.length, 2);
});

test("routes connect every desk chair to every fixture anchor", () => {
  const layout = layoutOffice([
    { session: "alpha", keys: ["a:1", "a:2"] },
    { session: "beta", keys: ["b:1", "b:2", "b:3"] },
  ]);
  const edge = new Set(layout.waypoints.edges.map(([left, right]) => `${left}:${right}`));
  const indexOf = (point: [number, number]) =>
    layout.waypoints.nodes.findIndex((node) => node[0] === point[0] && node[1] === point[1]);
  const chairs: [number, number][] = layout.pods.flatMap((pod) => pod.desks.map((desk: DeskSlot) => desk.chair));
  const anchors = layout.fixtures.flatMap((fixture) => fixture.anchors);
  assert.ok(chairs.length >= 5);
  assert.ok(anchors.length >= 8);
  for (const chair of chairs) {
    for (const anchor of anchors) {
      const path = routeBetween(layout, chair, anchor);
      assert.ok(path.length >= 1);
      const start = indexOf(path[0]!);
      const end = indexOf(path[path.length - 1]!);
      assert.ok(start >= 0, "path starts on a node");
      assert.ok(end >= 0, "path ends on a node");
      const nearest = (point: [number, number]) => {
        let best = 0;
        let bestD = Infinity;
        layout.waypoints.nodes.forEach((node, index) => {
          const dist = (node[0] - point[0]) ** 2 + (node[1] - point[1]) ** 2;
          if (dist < bestD) {
            bestD = dist;
            best = index;
          }
        });
        return best;
      };
      assert.equal(start, nearest(chair));
      assert.equal(end, nearest(anchor));
      for (let step = 1; step < path.length; step += 1) {
        const left = indexOf(path[step - 1]!);
        const right = indexOf(path[step]!);
        const a = Math.min(left, right);
        const b = Math.max(left, right);
        assert.ok(edge.has(`${a}:${b}`), "path step is an edge");
      }
    }
  }
});
