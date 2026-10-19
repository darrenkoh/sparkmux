import assert from "node:assert/strict";
import { test } from "node:test";

import { editorOpenRequest, toolRowPath } from "./openPath.ts";

test("tool row path is the recorded file and the open request does not write the pane", () => {
  assert.equal(toolRowPath("file_path: src/App.tsx\ncommand: cargo test"), "src/App.tsx");
  assert.equal(toolRowPath("target_file: crates/sparkmux-core/src/lib.rs"), "crates/sparkmux-core/src/lib.rs");
  assert.equal(toolRowPath("command: ls"), null);

  const request = editorOpenRequest("src/App.tsx", "/Users/darrenkoh/github/sparkmux");
  assert.equal(request.path, "/Users/darrenkoh/github/sparkmux/src/App.tsx");
  assert.equal(request.paneWrite, false);
  assert.equal(JSON.stringify(request).includes("pane_write"), false);
});
