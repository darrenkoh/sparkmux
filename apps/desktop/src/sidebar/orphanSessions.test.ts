import assert from "node:assert/strict";
import { test } from "node:test";

import { offScreenHint, offScreenSessions, type OffScreenSession } from "./orphanSessions.ts";

function session(
  name: string,
  extra: Partial<OffScreenSession> = {},
): OffScreenSession {
  return {
    name,
    attached: false,
    windows: [
      {
        name: "shell",
        active: true,
        panes: [{ command: "zsh", active: true }],
      },
    ],
    ...extra,
  };
}

test("off-screen sessions are the ones the terminal is not showing", () => {
  const sessions = [session("SparkMux"), session("Imagine"), session("Notes")];
  assert.deepEqual(
    offScreenSessions(sessions, "SparkMux").map((item) => item.name),
    ["Imagine", "Notes"],
  );
});

test("every running session is off screen when the terminal shows none", () => {
  const sessions = [session("SparkMux"), session("Imagine")];
  assert.equal(offScreenSessions(sessions, null).length, 2);
  assert.equal(offScreenSessions(sessions, "").length, 2);
  assert.deepEqual(offScreenSessions([], "SparkMux"), []);
});

test("the visible session is omitted even when another client is attached to it", () => {
  const visible = session("SparkMux", { attached: true });
  const other = session("Imagine", { attached: true });
  assert.deepEqual(
    offScreenSessions([visible, other], "SparkMux").map((item) => item.name),
    ["Imagine"],
  );
});

test("the hint names the active window and command", () => {
  const running = session("Imagine", {
    windows: [
      {
        name: "shell",
        active: false,
        panes: [{ command: "zsh", active: true }],
      },
      {
        name: "Grok",
        active: true,
        panes: [
          { command: "zsh", active: false },
          { command: "grok-1.0.62", active: true },
        ],
      },
    ],
  });
  assert.equal(offScreenHint(running), "2w · Grok · grok-1.0.62");
  assert.equal(
    offScreenHint(session("Notes", { attached: true, windows: [] })),
    "0w · client attached",
  );
});
