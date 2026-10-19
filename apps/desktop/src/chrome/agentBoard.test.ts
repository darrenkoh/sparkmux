import assert from "node:assert/strict";
import { test } from "node:test";

import { agentSubtitle, boardSelectTarget, type AgentBoardRow } from "./agentBoard.ts";

test("agentSubtitle uses the ask while waiting and the assistant line otherwise", () => {
  assert.equal(agentSubtitle(true, "Continue?", "All done."), "Continue?");
  assert.equal(agentSubtitle(false, "Continue?", "All done."), "All done.");
  assert.equal(agentSubtitle(true, "  \n", "fallback"), "");
  assert.equal(agentSubtitle(false, "Continue?", "  "), "");
});

test("agentSubtitle is one line and caps at 160 characters", () => {
  assert.equal(agentSubtitle(false, "", "line one\n  line two"), "line one line two");
  assert.equal(agentSubtitle(true, "q".repeat(180), "assistant"), "q".repeat(160));
  const capped = agentSubtitle(false, "ask", "é".repeat(161));
  assert.equal([...capped].length, 160);
  assert.equal(capped, "é".repeat(160));
});

test("a board row selects the pane and does not carry a write", () => {
  const row: AgentBoardRow = {
    session: "Sparkmux",
    window_id: "@1",
    window_name: "agent",
    pane_id: "%3",
    state: "Waiting on you",
    model: "Grok",
    detail: "Approve the edit?",
  };
  const target = boardSelectTarget(row);
  assert.deepEqual(target, { session: "Sparkmux", windowId: "@1", paneId: "%3" });
  assert.equal(JSON.stringify(target).includes("pane_write"), false);
});
