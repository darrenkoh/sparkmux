import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parsePopoutWindowKind,
  readStoredActiveTarget,
  resolvePopoutTarget,
} from "./popoutModel.ts";
import type { Snapshot } from "../types.ts";

const sampleSnapshot: Snapshot = {
  sessions: [
    {
      id: "$0",
      name: "alpha",
      attached: true,
      windows: [
        {
          id: "@1",
          index: 0,
          name: "agent",
          active: true,
          layout: "",
          bell: false,
          activity: false,
          activity_epoch: 0,
          unread: false,
          panes: [
            {
              id: "%1",
              index: 0,
              active: true,
              width: 80,
              height: 24,
              top: 0,
              left: 0,
              command: "claude",
              title: "Claude Code",
              path: "/repo/alpha",
              pid: 1001,
              dead: false,
              alternate: false,
            },
          ],
        },
        {
          id: "@2",
          index: 1,
          name: "logs",
          active: false,
          layout: "",
          bell: false,
          activity: false,
          activity_epoch: 0,
          unread: false,
          panes: [
            {
              id: "%2",
              index: 0,
              active: true,
              width: 80,
              height: 24,
              top: 0,
              left: 0,
              command: "zsh",
              title: "zsh",
              path: "/repo/alpha/logs",
              pid: 1002,
              dead: false,
              alternate: false,
            },
          ],
        },
      ],
    },
  ],
};

test("parsePopoutWindowKind identifies stats and gits window modes", () => {
  assert.equal(parsePopoutWindowKind("?window=stats"), "stats");
  assert.equal(parsePopoutWindowKind("?window=gits"), "gits");
  assert.equal(parsePopoutWindowKind("window=STATS"), "stats");
  assert.equal(parsePopoutWindowKind("?window=unknown"), null);
  assert.equal(parsePopoutWindowKind(""), null);
});

test("resolvePopoutTarget follows main window active target and refreshes pane fields from snapshot", () => {
  const resolved = resolvePopoutTarget(
    sampleSnapshot,
    {
      session_name: "alpha",
      tab_id: "@2",
      tab_name: "old-name",
      focused_pane: "%2",
      command: "bash",
      cwd: "/old",
      title: "old",
      pid: 99,
    },
    null,
  );
  assert.equal(resolved.session_name, "alpha");
  assert.equal(resolved.tab_id, "@2");
  assert.equal(resolved.tab_name, "logs");
  assert.equal(resolved.command, "zsh");
  assert.equal(resolved.cwd, "/repo/alpha/logs");
  assert.equal(resolved.pid, 1002);
});

test("resolvePopoutTarget stays locked to pinned tab when main window switches tabs", () => {
  const resolved = resolvePopoutTarget(
    sampleSnapshot,
    {
      session_name: "alpha",
      tab_id: "@2",
      tab_name: "logs",
      focused_pane: "%2",
      command: "zsh",
      cwd: "/repo/alpha/logs",
      title: "zsh",
      pid: 1002,
    },
    {
      sessionName: "alpha",
      tabId: "@1",
      paneId: "%1",
    },
  );
  assert.equal(resolved.session_name, "alpha");
  assert.equal(resolved.tab_id, "@1");
  assert.equal(resolved.tab_name, "agent");
  assert.equal(resolved.command, "claude");
  assert.equal(resolved.cwd, "/repo/alpha");
  assert.equal(resolved.pid, 1001);
});

test("readStoredActiveTarget safely parses stored JSON", () => {
  assert.equal(readStoredActiveTarget(null), null);
  assert.equal(readStoredActiveTarget("invalid"), null);
  const parsed = readStoredActiveTarget(
    JSON.stringify({
      session_name: "alpha",
      tab_id: "@1",
      tab_name: "agent",
      focused_pane: "%1",
      command: "claude",
      cwd: "/repo/alpha",
      title: "Claude",
      pid: 1001,
    }),
  );
  assert.equal(parsed?.session_name, "alpha");
  assert.equal(parsed?.tab_id, "@1");
});
