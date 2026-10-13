import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fileBasename,
  layoutConstellation,
  parseSideBySideDiff,
  statusLabel,
  type GraphEdge,
  type GraphRepo,
} from "./changeGraphLayout.ts";

function repo(id: string, name: string, primary: boolean, paths: string[]): GraphRepo {
  return {
    id,
    name,
    primary,
    files: paths.map((path) => ({
      path,
      status: "modified",
      agent_edited: path.endsWith("main.rs"),
      lines_added: 2,
      lines_removed: 1,
    })),
  };
}

test("one repo sits in the middle and its files stay inside the ring", () => {
  const layout = layoutConstellation([repo("/app", "app", true, ["src/main.rs", "src/lib.rs"])], [], 900, 560);
  assert.equal(layout.clusters.length, 1);
  const cluster = layout.clusters[0];
  assert.ok(cluster);
  assert.ok(Math.abs(cluster.x - 450) < 40);
  assert.ok(Math.abs(cluster.y - 280) < 40);
  for (const node of layout.nodes) {
    const distance = Math.hypot(node.x - cluster.x, node.y - cluster.y);
    assert.ok(distance <= cluster.r + 1, `${node.path} escaped the cluster`);
  }
});

test("two repos stay apart and a link joins them", () => {
  const repos = [
    repo("/app", "app", true, ["src/main.rs"]),
    repo("/lib", "lib", false, ["other-lib"]),
  ];
  const edges: GraphEdge[] = [
    { from_repo: "/app", to_repo: "/lib", label: "other-lib", via: "Cargo.toml" },
  ];
  const layout = layoutConstellation(repos, edges, 1000, 640);
  assert.equal(layout.clusters.length, 2);
  assert.equal(layout.links.length, 1);
  const [left, right] = layout.clusters;
  assert.ok(left && right);
  const gap = Math.hypot(left.x - right.x, left.y - right.y);
  assert.ok(gap > left.r + right.r, "clusters overlap");
  assert.equal(layout.links[0]?.label, "other-lib");
  assert.equal(statusLabel("modified"), "Modified");
  assert.equal(fileBasename("src/main.rs"), "main.rs");
});

test("parseSideBySideDiff aligns additions, deletions, context and hunks", () => {
  const diff = `diff --git a/file.ts b/file.ts
index 123..456 100644
--- a/file.ts
+++ b/file.ts
@@ -10,3 +10,4 @@
 context before
-old line 1
-old line 2
+new line 1
+new line 2
+new line 3
 context after`;

  const rows = parseSideBySideDiff(diff);
  assert.ok(rows.length > 0);

  // Meta rows
  assert.equal(rows[0]?.type, "meta");
  assert.ok(rows[0]?.metaText?.startsWith("diff --git"));

  // Hunk header
  const hunkRow = rows.find((r) => r.type === "hunk");
  assert.ok(hunkRow);
  assert.ok(hunkRow.metaText?.startsWith("@@"));

  // Context before
  const ctxBefore = rows.find((r) => r.oldText === "context before");
  assert.ok(ctxBefore);
  assert.equal(ctxBefore.oldKind, "context");
  assert.equal(ctxBefore.newKind, "context");
  assert.equal(ctxBefore.oldLineNo, 10);
  assert.equal(ctxBefore.newLineNo, 10);

  // Replacement pair 1: old line 1 <-> new line 1
  const pair1 = rows.find((r) => r.oldText === "old line 1");
  assert.ok(pair1);
  assert.equal(pair1.oldKind, "removed");
  assert.equal(pair1.newKind, "added");
  assert.equal(pair1.newText, "new line 1");

  // Replacement pair 2: old line 2 <-> new line 2
  const pair2 = rows.find((r) => r.oldText === "old line 2");
  assert.ok(pair2);
  assert.equal(pair2.oldKind, "removed");
  assert.equal(pair2.newKind, "added");
  assert.equal(pair2.newText, "new line 2");

  // Extra addition: new line 3 (left should be empty)
  const extraAdd = rows.find((r) => r.newText === "new line 3");
  assert.ok(extraAdd);
  assert.equal(extraAdd.oldKind, "empty");
  assert.equal(extraAdd.newKind, "added");
  assert.equal(extraAdd.oldLineNo, null);

  // Context after
  const ctxAfter = rows.find((r) => r.oldText === "context after");
  assert.ok(ctxAfter);
  assert.equal(ctxAfter.oldKind, "context");
  assert.equal(ctxAfter.newKind, "context");
});

test("arrangeCards grid mode auto-arranges cards to fit viewport width", async () => {
  const cards: import("./changeGraphLayout.ts").CardLayoutInput[] = [
    {
      id: "1",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/a.ts",
      filename: "a.ts",
      dir: "src",
      extension: "ts",
      status: "modified",
      agentEdited: false,
      linesAdded: 10,
      linesRemoved: 2,
    },
    {
      id: "2",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/b.ts",
      filename: "b.ts",
      dir: "src",
      extension: "ts",
      status: "added",
      agentEdited: true,
      linesAdded: 45,
      linesRemoved: 0,
    },
    {
      id: "3",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/c.ts",
      filename: "c.ts",
      dir: "src",
      extension: "ts",
      status: "untracked",
      agentEdited: false,
      linesAdded: 12,
      linesRemoved: 4,
    },
  ];

  const { arrangeCards, computeFitCamera } = await import("./changeGraphLayout.ts");

  // In a wide 1200px viewport, cards fit side by side
  const wide = arrangeCards(cards, "grid", 1200, 800);
  assert.equal(Object.keys(wide.positions).length, 3);
  assert.ok(wide.positions["1"]);
  assert.ok(wide.positions["2"]);
  assert.ok(wide.positions["3"]);
  assert.equal(wide.positions["1"]!.y, wide.positions["2"]!.y); // same row

  // In a narrow 600px viewport, cards wrap into multiple rows
  const narrow = arrangeCards(cards, "grid", 600, 800);
  assert.equal(Object.keys(narrow.positions).length, 3);
  assert.ok(narrow.positions["1"]!.y < narrow.positions["3"]!.y); // stacked row

  // Test computeFitCamera
  const cam = computeFitCamera(wide.positions, 1200, 800);
  assert.ok(cam.zoom > 0.3 && cam.zoom <= 1.2);
});

test("arrangeCards pipeline mode groups cards into lifecycle kanban lanes", async () => {
  const { arrangeCards } = await import("./changeGraphLayout.ts");
  const cards: import("./changeGraphLayout.ts").CardLayoutInput[] = [
    {
      id: "ai-file",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/ai.ts",
      filename: "ai.ts",
      dir: "src",
      extension: "ts",
      status: "modified",
      agentEdited: true,
      linesAdded: 100,
      linesRemoved: 20,
    },
    {
      id: "mod-file",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/mod.ts",
      filename: "mod.ts",
      dir: "src",
      extension: "ts",
      status: "modified",
      agentEdited: false,
      linesAdded: 5,
      linesRemoved: 2,
    },
    {
      id: "new-file",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/new.ts",
      filename: "new.ts",
      dir: "src",
      extension: "ts",
      status: "added",
      agentEdited: false,
      linesAdded: 25,
      linesRemoved: 0,
    },
  ];

  const res = arrangeCards(cards, "pipeline", 1100, 700);
  assert.ok(res.laneHeaders.length >= 3);
  const agentHeader = res.laneHeaders.find((h) => h.id.includes("agent"));
  assert.ok(agentHeader);
  assert.equal(agentHeader.count, 1);

  // Each card is placed in a separate lane column
  const posAI = res.positions["ai-file"]!;
  const posMod = res.positions["mod-file"]!;
  const posNew = res.positions["new-file"]!;
  assert.notEqual(posAI.x, posMod.x);
  assert.notEqual(posMod.x, posNew.x);
});

test("arrangeCards modules mode groups cards by directory", async () => {
  const { arrangeCards } = await import("./changeGraphLayout.ts");
  const cards: import("./changeGraphLayout.ts").CardLayoutInput[] = [
    {
      id: "f1",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/chrome/a.ts",
      filename: "a.ts",
      dir: "src/chrome",
      extension: "ts",
      status: "modified",
      agentEdited: false,
      linesAdded: 5,
      linesRemoved: 1,
    },
    {
      id: "f2",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/chrome/b.ts",
      filename: "b.ts",
      dir: "src/chrome",
      extension: "ts",
      status: "modified",
      agentEdited: false,
      linesAdded: 3,
      linesRemoved: 0,
    },
    {
      id: "f3",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "crates/core/lib.rs",
      filename: "lib.rs",
      dir: "crates/core",
      extension: "rs",
      status: "modified",
      agentEdited: true,
      linesAdded: 20,
      linesRemoved: 10,
    },
  ];

  const res = arrangeCards(cards, "modules", 1000, 700);
  assert.ok(res.laneHeaders.length >= 2);
  const chromeCards = [res.positions["f1"]!, res.positions["f2"]!];
  // Same directory cluster cards share column x
  assert.equal(chromeCards[0].x, chromeCards[1].x);
  // And are stacked vertically
  assert.ok(chromeCards[1].y > chromeCards[0].y);
});

test("arrangeCards impact and radial modes organize cards distinctively", async () => {
  const { arrangeCards } = await import("./changeGraphLayout.ts");
  const cards: import("./changeGraphLayout.ts").CardLayoutInput[] = [
    {
      id: "low",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "readme.md",
      filename: "readme.md",
      dir: ".",
      extension: "md",
      status: "modified",
      agentEdited: false,
      linesAdded: 1,
      linesRemoved: 0,
    },
    {
      id: "high",
      repoId: "r1",
      repoName: "repo1",
      isPrimaryRepo: true,
      path: "src/core.ts",
      filename: "core.ts",
      dir: "src",
      extension: "ts",
      status: "modified",
      agentEdited: true,
      linesAdded: 120,
      linesRemoved: 40,
    },
  ];

  // Impact mode puts highest churn first
  const impact = arrangeCards(cards, "impact", 1000, 700);
  assert.ok(impact.laneHeaders.length > 0);
  assert.ok(impact.positions["high"]!.y <= impact.positions["low"]!.y);

  // Radial mode positions cards around center
  const radial = arrangeCards(cards, "radial", 1000, 800);
  assert.ok(radial.orbitRings.length > 0);
  const cx = 500;
  const cy = 410;
  const distHigh = Math.hypot(radial.positions["high"]!.x + 135 - cx, radial.positions["high"]!.y + 69 - cy);
  assert.ok(distHigh > 100);
});


