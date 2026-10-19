/** One row on the agent board. Field names match the Rust `BoardRow`. */
export interface AgentBoardRow {
  session: string;
  window_id: string;
  window_name: string;
  pane_id: string;
  state: string;
  model: string;
  detail: string;
}

const DETAIL_CAP = 160;

/** Board subtitle: the ask while waiting, otherwise the last assistant line. */
export function agentSubtitle(waiting: boolean, ask: string, assistant: string): string {
  return oneLine(waiting ? ask : assistant, DETAIL_CAP);
}

/** Selecting a row is only a pane target. It does not write to the terminal. */
export function boardSelectTarget(row: AgentBoardRow): {
  session: string;
  windowId: string;
  paneId: string;
} {
  return {
    session: row.session,
    windowId: row.window_id,
    paneId: row.pane_id,
  };
}

function oneLine(text: string, cap: number): string {
  const chars: string[] = [];
  let pendingSpace = false;
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      if (chars.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (chars.length >= cap) break;
      chars.push(" ");
      pendingSpace = false;
    }
    if (chars.length >= cap) break;
    chars.push(ch);
  }
  return chars.join("");
}
