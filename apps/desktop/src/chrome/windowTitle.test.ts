import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAppWindowTitle } from "./windowTitle.ts";

test("formatAppWindowTitle is the brand and the build version", () => {
  assert.equal(formatAppWindowTitle("0.1.64"), "SparkMux 0.1.64");
  assert.equal(formatAppWindowTitle(""), "SparkMux");
});
