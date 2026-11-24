import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canFocusTerminal } from "./terminalFocus.ts";

function makeClassList(...tokens: string[]) {
  const set = new Set(tokens);
  return {
    contains: (token: string) => set.has(token),
  };
}

test("canFocusTerminal allows terminal focus when no form control owns focus", () => {
  assert.equal(canFocusTerminal(null), true);
  assert.equal(canFocusTerminal(undefined), true);
  assert.equal(canFocusTerminal({ tagName: "BODY" }), true);
  assert.equal(canFocusTerminal({ tagName: "DIV" }), true);
  assert.equal(canFocusTerminal({ tagName: "BUTTON" }), true);
  assert.equal(
    canFocusTerminal({
      tagName: "TEXTAREA",
      classList: makeClassList("xterm-helper-textarea"),
    }),
    true,
  );
});

test("canFocusTerminal blocks terminal focus when an input, textarea, select, or contentEditable is active", () => {
  assert.equal(canFocusTerminal({ tagName: "INPUT" }), false);
  assert.equal(canFocusTerminal({ tagName: "input" }), false);
  assert.equal(canFocusTerminal({ tagName: "TEXTAREA" }), false);
  assert.equal(
    canFocusTerminal({ tagName: "TEXTAREA", classList: makeClassList("other") }),
    false,
  );
  assert.equal(canFocusTerminal({ tagName: "SELECT" }), false);
  assert.equal(
    canFocusTerminal({ tagName: "DIV", isContentEditable: true }),
    false,
  );
});

test("XtermView guards async seed and effect focus calls with canFocusTerminal", () => {
  const xterm = readFileSync(new URL("./XtermView.tsx", import.meta.url), "utf8");
  const matches = xterm.match(/canFocusTerminal\(document\.activeElement\)/g) ?? [];
  assert.equal(matches.length, 2);

  const paintNowStart = xterm.indexOf("const paintNow =");
  const paintSeedStart = xterm.indexOf("const paintSeed =", paintNowStart);
  const paintNowBody = xterm.slice(paintNowStart, paintSeedStart);
  assert.match(paintNowBody, /canFocusTerminal\(document\.activeElement\)/);

  const focusedEffectStart = xterm.indexOf("if (focused && !findOpen)");
  const focusedEffectEnd = xterm.indexOf("}, [focused, findOpen]);", focusedEffectStart);
  const focusedEffectBody = xterm.slice(focusedEffectStart, focusedEffectEnd);
  assert.match(focusedEffectBody, /canFocusTerminal\(document\.activeElement\)/);
});

test("App guards terminal focus calls and wires sidebar tab rename", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const matches = app.match(/canFocusTerminal\(document\.activeElement\)/g) ?? [];
  assert.equal(matches.length, 4);
  assert.match(app, /onRenameTab=\{\(windowId, name\) => \{\s*void renameTab\(windowId, name\);\s*\}\}/);
});

test("WindowTabs and Sidebar guard double-click rename and double-commit", () => {
  const tabs = readFileSync(new URL("../chrome/WindowTabs.tsx", import.meta.url), "utf8");
  assert.match(tabs, /editingIdRef/);
  assert.match(tabs, /if \(e\.detail > 1\) return;/);
  assert.match(tabs, /onDoubleClick=\{\(e\) => \{/);

  const sidebar = readFileSync(new URL("../sidebar/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /editingWindowIdRef/);
  assert.match(sidebar, /if \(e\.detail > 1\) return;/);
  assert.match(sidebar, /onDoubleClick=\{\(e\) => \{/);
  assert.match(sidebar, /className="win-rename-btn"/);
});
