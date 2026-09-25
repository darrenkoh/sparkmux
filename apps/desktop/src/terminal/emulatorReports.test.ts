import assert from "node:assert/strict";
import { test } from "node:test";

import { isEmulatorReport } from "./emulatorReports.ts";

const ESC = "\x1b";

test("cursor and device reports are not typed into the pane", () => {
  assert.equal(isEmulatorReport(`${ESC}[12;1R`), true);
  assert.equal(isEmulatorReport(`${ESC}[?12;1R`), true);
  assert.equal(isEmulatorReport(`${ESC}[0n`), true);
  assert.equal(isEmulatorReport(`${ESC}[?1;2c`), true);
  assert.equal(isEmulatorReport(`${ESC}[>0;276;0c`), true);
  assert.equal(isEmulatorReport(`${ESC}[?2026;0$y`), true);
  assert.equal(isEmulatorReport(`${ESC}[20;1$y`), true);
  assert.equal(isEmulatorReport(`${ESC}[8;40;80t`), true);
  assert.equal(isEmulatorReport(`${ESC}[4;400;800t`), true);
  assert.equal(isEmulatorReport(`${ESC}]11;rgb:0000/0000/0000${ESC}\\`), true);
  assert.equal(isEmulatorReport(`${ESC}P1$r0m${ESC}\\`), true);
});

test("keystrokes and mouse reports still go to the pane", () => {
  assert.equal(isEmulatorReport("a"), false);
  assert.equal(isEmulatorReport("\r"), false);
  assert.equal(isEmulatorReport("\x03"), false);
  assert.equal(isEmulatorReport(`${ESC}[A`), false);
  assert.equal(isEmulatorReport(`${ESC}[1;2B`), false);
  assert.equal(isEmulatorReport(`${ESC}[3~`), false);
  assert.equal(isEmulatorReport(`${ESC}OA`), false);
  assert.equal(isEmulatorReport(`${ESC}[I`), false);
  assert.equal(isEmulatorReport(`${ESC}[O`), false);
  assert.equal(isEmulatorReport(`${ESC}[<0;12;4M`), false);
  assert.equal(isEmulatorReport(`${ESC}[<0;12;4m`), false);
  assert.equal(isEmulatorReport(""), false);
});
