// A file dropped on a pane is inserted as its path. The prompt is not submitted.
//
// Newlines and other controls are rejected: in a terminal a newline is Enter,
// and an escape would be a control sequence. Shell metacharacters are
// single-quoted so a path with spaces still pastes as one path. A plain path
// is inserted unchanged.

const MAX_PATHS = 64;
const MAX_PATH_CHARS = 4096;
const MAX_TOTAL_CHARS = 16_384;

const PANE_ID = /^%\d+$/;

const SHELL_META = new Set([
  "\"",
  "\\",
  "$",
  "'",
  "`",
  "!",
  "#",
  "&",
  "*",
  ";",
  "<",
  ">",
  "?",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "|",
  "^",
  "~",
]);

export interface DropViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface PathInserter {
  paste(text: string): void;
  scrollToBottom(): void;
  focus(): void;
  clearSelection(): void;
}

interface CursorLine {
  isWrapped: boolean;
  length: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface CursorBuffer {
  cursorX: number;
  cursorY: number;
  baseY: number;
  getLine(y: number): CursorLine | null | undefined;
}

/** macOS reports logical points. A point outside the CSS viewport is physical. */
export function clientPointFromDrop(
  position: { x: number; y: number },
  viewport: DropViewport,
): { x: number; y: number } {
  const dpr = viewport.devicePixelRatio > 0 ? viewport.devicePixelRatio : 1;
  const inside =
    position.x >= -1 &&
    position.y >= -1 &&
    position.x <= viewport.width + 1 &&
    position.y <= viewport.height + 1;
  if (inside || dpr === 1) return { x: position.x, y: position.y };
  return { x: position.x / dpr, y: position.y / dpr };
}

export function paneIdFromHit(
  hit: {
    closest(selector: string): { getAttribute(name: string): string | null } | null;
  } | null,
): string | null {
  const id = hit?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? "";
  return PANE_ID.test(id) ? id : null;
}

export function charBeforeCursor(buffer: CursorBuffer): string | null {
  let x = buffer.cursorX;
  let index = buffer.baseY + buffer.cursorY;
  let line = buffer.getLine(index);
  if (!line) return null;
  if (x <= 0) {
    if (!line.isWrapped || index <= 0) return null;
    index -= 1;
    const prev = buffer.getLine(index);
    if (!prev || prev.length <= 0) return null;
    line = prev;
    x = prev.length;
  }
  const chunk = line.translateToString(false, Math.max(0, x - 2), x);
  const chars = Array.from(chunk);
  const last = chars[chars.length - 1];
  return last ? last : null;
}

/**
 * Text to insert at the prompt, or null when nothing safe remains.
 * `prevChar` is the cell before the cursor; a non-space gets a separating space.
 * The result ends in a space and never contains CR or LF.
 */
export function formatDroppedPaths(
  paths: readonly string[],
  prevChar: string | null = null,
): string | null {
  const parts: string[] = [];
  let total = 0;
  for (const raw of paths) {
    if (parts.length >= MAX_PATHS) break;
    const path = acceptPath(raw);
    if (!path) continue;
    const quoted = quotePath(path);
    const sep = parts.length > 0 ? 1 : 0;
    if (total + sep + quoted.length > MAX_TOTAL_CHARS) break;
    parts.push(quoted);
    total += sep + quoted.length;
  }
  if (parts.length === 0) return null;
  const lead = prevChar && !isSpace(prevChar) ? " " : "";
  return `${lead}${parts.join(" ")} `;
}

export function insertDroppedPaths(
  term: PathInserter,
  paths: readonly string[],
  prevChar: string | null,
): boolean {
  const text = formatDroppedPaths(paths, prevChar);
  if (!text) return false;
  term.clearSelection();
  term.scrollToBottom();
  term.focus();
  term.paste(text);
  return true;
}

function acceptPath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.length > MAX_PATH_CHARS) return null;
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return null;
  }
  return raw;
}

function quotePath(path: string): string {
  if (!Array.from(path).some(needsQuote)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function needsQuote(ch: string): boolean {
  return SHELL_META.has(ch) || isSpace(ch);
}

function isSpace(ch: string): boolean {
  return /\s/u.test(ch);
}
