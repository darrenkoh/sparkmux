import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRelativeTime,
  formatCommitDate,
  statusBadgeColor,
  statusBadgeLabel,
  filterCommits,
  buildFileTree,
  getAllDirPaths,
  filterTreeNodes,
} from "./gitHistoryModel.ts";
import type { GitCommitItem } from "../api.ts";

test("formatRelativeTime produces compact relative timestamps", () => {
  const now = 1700000000;
  assert.equal(formatRelativeTime(now - 10, now), "just now");
  assert.equal(formatRelativeTime(now - 60, now), "1m ago");
  assert.equal(formatRelativeTime(now - 300, now), "5m ago");
  assert.equal(formatRelativeTime(now - 7200, now), "2h ago");
  assert.equal(formatRelativeTime(now - 86400 * 3, now), "3d ago");
  assert.equal(formatRelativeTime(now - 86400 * 45, now), "1mo ago");
  assert.equal(formatRelativeTime(now - 86400 * 400, now), "1y ago");
  assert.equal(formatRelativeTime(0, now), "");
});

test("formatCommitDate formats valid timestamps", () => {
  const ts = 1792541866;
  const formatted = formatCommitDate(ts);
  assert.ok(formatted.length > 5);
  assert.equal(formatCommitDate(0), "");
});

test("statusBadgeColor and statusBadgeLabel map git dirty states", () => {
  assert.equal(statusBadgeColor("added"), "#34d399");
  assert.equal(statusBadgeLabel("added"), "A");
  assert.equal(statusBadgeColor("deleted"), "#f87171");
  assert.equal(statusBadgeLabel("deleted"), "D");
  assert.equal(statusBadgeColor("renamed"), "#fbbf24");
  assert.equal(statusBadgeLabel("renamed"), "R");
  assert.equal(statusBadgeColor("modified"), "#38bdf8");
  assert.equal(statusBadgeLabel("modified"), "M");
});

test("filterCommits filters by summary, author, email, or hash", () => {
  const commits: GitCommitItem[] = [
    {
      hash: "a78f5f294f0fd62f09917b6b32922b590b703544",
      short_hash: "a78f5f2",
      author_name: "Darren Koh",
      author_email: "darrenkoh@gmail.com",
      timestamp: 1792541866,
      summary: "Ship 0.1.49",
      body: "Release version bump",
      parents: ["5e842b85c252de9fb0512ce1e3723950b43077df"],
      files_changed: 7,
      insertions: 18,
      deletions: 9,
    },
    {
      hash: "5e842b85c252de9fb0512ce1e3723950b43077df",
      short_hash: "5e842b8",
      author_name: "Agent Alice",
      author_email: "alice@example.com",
      timestamp: 1792541762,
      summary: "fix(gits): retain committed files",
      body: "Detailed change note",
      parents: [],
      files_changed: 5,
      insertions: 168,
      deletions: 3,
    },
  ];

  assert.equal(filterCommits(commits, "").length, 2);
  assert.equal(filterCommits(commits, "0.1.49").length, 1);
  assert.equal(filterCommits(commits, "0.1.49")[0].short_hash, "a78f5f2");
  assert.equal(filterCommits(commits, "alice").length, 1);
  assert.equal(filterCommits(commits, "a78f").length, 1);
  assert.equal(filterCommits(commits, "version bump").length, 1);
  assert.equal(filterCommits(commits, "nonexistent").length, 0);
});

test("buildFileTree builds nested hierarchy and aggregates line deltas", () => {
  const files = [
    { path: "apps/desktop/src/chrome/GitHistoryView.tsx", status: "added", added: 200, removed: 0 },
    { path: "apps/desktop/src-tauri/src/change_graph.rs", status: "modified", added: 12, removed: 4 },
    { path: "Cargo.toml", status: "modified", added: 1, removed: 1 },
  ];

  const tree = buildFileTree(files);
  assert.equal(tree.length, 2); // "apps" (dir) and "Cargo.toml" (file)
  assert.equal(tree[0].name, "apps");
  assert.equal(tree[0].isDir, true);
  assert.equal(tree[0].fileCount, 2);
  assert.equal(tree[0].added, 212);
  assert.equal(tree[0].removed, 4);

  assert.equal(tree[1].name, "Cargo.toml");
  assert.equal(tree[1].isDir, false);
  assert.equal(tree[1].added, 1);

  // Check nested dirs
  const appsChildren = tree[0].children;
  assert.equal(appsChildren.length, 1); // "desktop"
  const desktopChildren = appsChildren[0].children;
  assert.equal(desktopChildren.length, 2); // "src" and "src-tauri"

  const allDirs = getAllDirPaths(tree);
  assert.ok(allDirs.includes("apps"));
  assert.ok(allDirs.includes("apps/desktop"));
  assert.ok(allDirs.includes("apps/desktop/src"));
  assert.ok(allDirs.includes("apps/desktop/src/chrome"));
});

test("filterTreeNodes filters tree by search query preserving matching hierarchy", () => {
  const files = [
    { path: "apps/desktop/src/chrome/GitHistoryView.tsx", status: "added", added: 200, removed: 0 },
    { path: "apps/desktop/src-tauri/src/change_graph.rs", status: "modified", added: 12, removed: 4 },
    { path: "Cargo.toml", status: "modified", added: 1, removed: 1 },
  ];

  const tree = buildFileTree(files);
  const filtered = filterTreeNodes(tree, "change_graph");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, "apps");
  const subTree = filterTreeNodes(tree, "Cargo");
  assert.equal(subTree.length, 1);
  assert.equal(subTree[0].name, "Cargo.toml");
});
