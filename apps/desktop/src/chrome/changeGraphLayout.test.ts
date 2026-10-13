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

