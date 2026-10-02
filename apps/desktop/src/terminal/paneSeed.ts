import type { Terminal } from "@xterm/xterm";

import { screenDumpToXterm } from "../api.ts";

const HEADER = /^\x1ehistory:(\d+)\n/;

/** Peel a counted history prefix off the subscribe seed. No prefix means the
 * bytes are the visible screen only, which is also the fallback when the
 * prefix is truncated. */
export function parsePaneSeed(bytes: Uint8Array): { history: string[]; visible: Uint8Array } {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const match = HEADER.exec(decoded);
  if (!match) return { history: [], visible: bytes };
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 0) return { history: [], visible: bytes };
  const rest = decoded.slice(match[0].length);
  const history: string[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const nl = rest.indexOf("\n", pos);
    if (nl < 0) return { history: [], visible: bytes };
    history.push(rest.slice(pos, nl));
    pos = nl + 1;
  }
  return { history, visible: new TextEncoder().encode(rest.slice(pos)) };
}

/** Load tmux history into scrollback, then paint the visible screen.
 *
 * Scrollback only grows when a line feed happens on the bottom row. At one
 * row, every line feed scrolls that row into history. Growing back to the
 * real height would pull those lines onto the screen again, so `windowsMode`
 * is set for that resize: xterm pads with blank rows and leaves scrollback
 * put. The visible pane is then painted with absolute cursor positions.
 *
 * `onHistory` runs synchronously, before the one-row resize, so the caller
 * can hide the host and ignore fit until `done`.
 */
export function applyPaneSeed(
  term: Terminal,
  bytes: Uint8Array,
  done: () => void,
  onHistory?: () => void,
): void {
  term.reset();
  const { history, visible } = parsePaneSeed(bytes);
  const dump = screenDumpToXterm(visible);
  if (history.length === 0 || term.cols < 2 || term.rows < 1) {
    term.write(dump, done);
    return;
  }

  onHistory?.();
  const cols = term.cols;
  const rows = term.rows;
  term.resize(cols, 1);
  const payload = `${history.join("\r\n")}\r\n`;
  let restored = false;
  const restoreSize = () => {
    if (restored) return;
    restored = true;
    const previous = term.options.windowsMode;
    term.options.windowsMode = true;
    try {
      term.resize(cols, rows);
    } finally {
      term.options.windowsMode = previous ?? false;
    }
  };
  term.write(payload, restoreSize);
  // Reset SGR left over from the history rows before the screen erase.
  term.write(`\x1b[0m${dump}`, () => {
    restoreSize();
    done();
  });
}
