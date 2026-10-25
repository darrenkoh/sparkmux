import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canInsertRecipe,
  recipeCommand,
  recipeProblem,
  recipeById,
  shellName,
} from "./recipes.ts";

const folder = "/Users/darrenkoh/github/sparkmux";

test("folder recipes quote the pane path and do not run a pager", () => {
  assert.equal(recipeCommand("folder-size", folder, ""), `du -sh '${folder}'`);
  assert.equal(recipeCommand("folder-usage", folder, ""), `du -hd 1 '${folder}'`);
  assert.equal(recipeCommand("free-space", folder, ""), `df -h '${folder}'`);
  assert.equal(recipeCommand("folder-size", "", ""), "du -sh .");
  assert.equal(recipeCommand("folder-size", "  .  ", ""), "du -sh .");
});

test("a space or quote in the folder stays one argument", () => {
  assert.equal(
    recipeCommand("folder-size", "/Users/me/My Files", ""),
    "du -sh '/Users/me/My Files'",
  );
  assert.equal(
    recipeCommand("free-space", "/tmp/it's", ""),
    "df -h '/tmp/it'\\''s'",
  );
});

test("find quotes the name so the shell does not expand a star", () => {
  assert.equal(
    recipeCommand("find-name", folder, "*.log"),
    `find '${folder}' -name '*.log'`,
  );
  assert.equal(
    recipeCommand("find-name", folder, "  notes.txt  "),
    `find '${folder}' -name 'notes.txt'`,
  );
  assert.equal(recipeCommand("find-name", folder, ""), null);
  assert.equal(recipeCommand("find-name", folder, "a\nb"), null);
});

test("listing, counts, recent files, and git use the pane folder", () => {
  assert.equal(recipeCommand("list-folder", folder, ""), `ls -lah '${folder}'`);
  assert.equal(recipeCommand("file-count", folder, ""), `find '${folder}' -type f | wc -l`);
  assert.equal(
    recipeCommand("changed-today", folder, ""),
    `find '${folder}' -type f -mtime -1`,
  );
  assert.equal(recipeCommand("git-status", folder, ""), `git -C '${folder}' status -sb`);
  assert.equal(recipeCommand("git-diff", ".", ""), "git -C . diff --stat");
  assert.equal(
    recipeCommand("find-iname", folder, "*.LOG"),
    `find '${folder}' -iname '*.LOG'`,
  );
  assert.equal(
    recipeCommand("grep-text-i", folder, "Todo"),
    `grep -R -n -F -i -- 'Todo' '${folder}'`,
  );
  assert.equal(recipeCommand("find-iname", folder, ""), null);
  assert.equal(
    recipeProblem(recipeById("find-iname")!, folder, ""),
    "Type a name.",
  );
});

test("text search is a fixed-string grep", () => {
  assert.equal(
    recipeCommand("grep-text", folder, "TODO"),
    `grep -R -n -F -- 'TODO' '${folder}'`,
  );
  assert.equal(
    recipeCommand("grep-text", ".", "it's"),
    "grep -R -n -F -- 'it'\\''s' .",
  );
  assert.equal(
    recipeProblem(recipeById("grep-text")!, folder, "   "),
    "Type the text to find.",
  );
  assert.equal(
    recipeProblem(recipeById("find-name")!, folder, ""),
    "Type a name.",
  );
});

test("a newline in the folder is refused", () => {
  assert.equal(recipeCommand("folder-size", "/tmp/a\nb", ""), null);
  assert.equal(
    recipeProblem(recipeById("folder-size")!, "/tmp/a\nb", ""),
    "This folder path cannot go into a command.",
  );
});

test("insert is only for a normal shell", () => {
  assert.equal(shellName("/bin/zsh"), "zsh");
  assert.equal(shellName("-bash"), "bash");
  assert.equal(canInsertRecipe("zsh", false), true);
  assert.equal(canInsertRecipe("/bin/zsh", false), true);
  assert.equal(canInsertRecipe("-bash", false), true);
  assert.equal(canInsertRecipe("fish", false), true);
  assert.equal(canInsertRecipe("dash", false), true);
  assert.equal(canInsertRecipe("sh", false), true);
  assert.equal(canInsertRecipe("zsh", true), false);
  assert.equal(canInsertRecipe("vim", false), false);
  assert.equal(canInsertRecipe("grok-1.0.62", false), false);
  assert.equal(canInsertRecipe("", false), false);
});
