import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fileBasename,
  layoutConstellation,
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
