import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlocks, splitInlineTokens } from "./markdownParser.ts";

test("parseBlocks extracts fenced code blocks and text", () => {
  const input = `Here is some text:
\`\`\`rust
fn main() {
    println!("hello");
}
\`\`\`
And closing text.`;

  const blocks = parseBlocks(input);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[1].type, "code");
  if (blocks[1].type === "code") {
    assert.equal(blocks[1].lang, "rust");
    assert.match(blocks[1].code, /println!/);
  }
  assert.equal(blocks[2].type, "markdown");
});

test("splitInlineTokens extracts code, bold, links, italic, and text", () => {
  const input = "Use `git status` to see **bold** and [link](https://sparkmux.dev) or *italic* text";
  const tokens = splitInlineTokens(input);

  assert.equal(tokens.length, 9);
  assert.deepEqual(tokens[0], { type: "text", val: "Use " });
  assert.deepEqual(tokens[1], { type: "code", val: "git status" });
  assert.deepEqual(tokens[2], { type: "text", val: " to see " });
  assert.deepEqual(tokens[3], { type: "bold", val: "bold" });
  assert.deepEqual(tokens[4], { type: "text", val: " and " });
  assert.deepEqual(tokens[5], { type: "link", val: "link", url: "https://sparkmux.dev" });
  assert.deepEqual(tokens[6], { type: "text", val: " or " });
  assert.deepEqual(tokens[7], { type: "italic", val: "italic" });
  assert.deepEqual(tokens[8], { type: "text", val: " text" });
});
