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

/** Phone-only lines above the tmux history. The visible screen bytes stay as captured. */
export function withExtraHistory(bytes: Uint8Array, extra: string[]): Uint8Array {
  if (extra.length === 0) return bytes;
  const lines = extra.map((line) => line.replace(/[\r\n\u001e]/g, ""));
  const { history, visible } = parsePaneSeed(bytes);
  const all = lines.concat(history);
  const header = new TextEncoder().encode(`\x1ehistory:${all.length}\n${all.join("\n")}\n`);
  const out = new Uint8Array(header.length + visible.length);
  out.set(header, 0);
  out.set(visible, header.length);
  return out;
}

interface PendingSeed {
  bytes: Uint8Array;
  done: () => void;
  onHistory?: () => void;
}

interface ActiveSeedState {
  busy: boolean;
  cols: number;
  rows: number;
  pending: PendingSeed | null;
}

const activeSeeds = new WeakMap<Terminal, ActiveSeedState>();

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
  let state = activeSeeds.get(term);
  if (!state) {
    state = { busy: false, cols: term.cols, rows: term.rows, pending: null };
    activeSeeds.set(term, state);
  }
  if (state.busy) {
    if (term.cols >= 2 && term.rows > 1) {
      state.cols = term.cols;
      state.rows = term.rows;
    }
    const { history } = parsePaneSeed(bytes);
    if (history.length > 0 && state.cols >= 2 && state.rows >= 1) {
      onHistory?.();
    }
    const superseded = state.pending;
    state.pending = { bytes, done, onHistory };
    superseded?.done();
    return;
  }

  state.busy = true;
  state.cols = term.cols;
  state.rows = term.rows;
  runPaneSeed(term, state, { bytes, done, onHistory });
}

function runPaneSeed(term: Terminal, state: ActiveSeedState, seed: PendingSeed): void {
  if (term.cols >= 2 && term.rows > 1) {
    state.cols = term.cols;
    state.rows = term.rows;
  }
  const cols = state.cols;
  const rows = state.rows;

  const finish = () => {
    const next = state.pending;
    if (next) {
      state.pending = null;
      seed.done();
      runPaneSeed(term, state, next);
      return;
    }
    state.busy = false;
    term.scrollToBottom?.();
    seed.done();
  };

  term.reset();
  const { history, visible } = parsePaneSeed(seed.bytes);
  const dump = screenDumpToXterm(visible);
  if (history.length === 0 || cols < 2 || rows < 1) {
    term.write(dump, finish);
    return;
  }

  seed.onHistory?.();
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
    finish();
  });
}
