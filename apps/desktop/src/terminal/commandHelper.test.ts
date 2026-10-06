import assert from "node:assert/strict";
import { test } from "node:test";

import {
  insertPayload,
  invokeError,
  isDestructive,
  shellEligible,
  usageText,
} from "./commandHelper.ts";

test("shells on the primary screen can ask, and agents cannot", () => {
  for (const name of ["zsh", "bash", "fish", "sh", "dash"]) {
    assert.equal(shellEligible(name, false), true, name);
  }
  assert.equal(shellEligible("/bin/zsh", false), true);
  assert.equal(shellEligible("-bash", false), true);
  for (const name of ["claude", "grok", "node", "vim", "less", "ssh"]) {
    assert.equal(shellEligible(name, false), false, name);
  }
  assert.equal(shellEligible("zsh", true), false);
});

test("a delete command is marked destructive before insert, and insert does not press Enter", () => {
  assert.equal(isDestructive("rm *.log"), true);
  assert.equal(isDestructive("find . -name '*.log' -delete"), true);
  assert.equal(isDestructive("mv a.log b.log"), true);
  assert.equal(isDestructive("echo hi > notes.txt"), true);
  assert.equal(isDestructive("find . -name notes.txt"), false);
  assert.equal(isDestructive("grep TODO ."), false);
  assert.equal(isDestructive("du -sh ."), false);
  assert.equal(isDestructive("ls 2>&1"), false);

  const payload = insertPayload("rm *.log\n");
  assert.deepEqual(payload, Array.from(new TextEncoder().encode("rm *.log")));
  assert.equal(payload.includes(10), false);
  assert.equal(payload.includes(13), false);
  assert.equal(new TextDecoder().decode(Uint8Array.from(payload)), "rm *.log");
});

test("an enable failure shows its message", () => {
  assert.equal(invokeError("Not enough free disk (1 bytes)."), "Not enough free disk (1 bytes).");
  assert.equal(
    invokeError({ message: "download failed: redirect" }),
    "download failed: redirect",
  );
  assert.equal(invokeError({}), "Could not turn on the command helper.");
});

test("setup copy tells the user how to ask", () => {
  const text = usageText();
  assert.match(text, /Ask only at a bare shell/);
  assert.match(text, /plain-language request/);
  assert.match(text, /inserts the command/);
  assert.match(text, /You run it/);
});
