import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the sessions collapse chevron stacks above the splitter touch slop", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const slopStart = css.indexOf(".splitter::before,");
  const slopEnd = css.indexOf("}", slopStart);
  const slop = css.slice(slopStart, slopEnd);
  const toggleStart = css.indexOf(".splitter-toggle {");
  const toggleEnd = css.indexOf("}", toggleStart);
  const toggle = css.slice(toggleStart, toggleEnd);
  const slopZ = Number(slop.match(/z-index:\s*(\d+)/)?.[1]);
  const toggleZ = Number(toggle.match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(slopZ > 0, "touch slop keeps a stacking level");
  assert.ok(toggleZ > slopZ, `chevron z-index ${toggleZ} must beat touch slop ${slopZ}`);
});
