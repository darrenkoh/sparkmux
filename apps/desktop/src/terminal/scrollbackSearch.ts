/** Buffer line and column for a match index in text joined by newlines. */
export function matchLineColumn(text: string, index: number): { line: number; column: number } {
  let line = 0;
  let column = 0;
  const end = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < end; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** Next case-insensitive match in pane scrollback text. An empty needle matches nothing. */
export function findScrollback(
  text: string,
  needle: string,
  fromIndex = 0,
): { index: number; length: number } | null {
  if (needle.length === 0) return null;
  const hay = text.toLowerCase();
  const pin = needle.toLowerCase();
  const start = Math.max(0, fromIndex);
  const found = hay.indexOf(pin, start);
  if (found < 0) return null;
  return { index: found, length: needle.length };
}

/** Next match, wrapping once to the start of the text. */
export function findNext(
  text: string,
  needle: string,
  fromIndex: number,
): { index: number; length: number } | null {
  return (
    findScrollback(text, needle, fromIndex) ??
    (fromIndex > 0 ? findScrollback(text, needle, 0) : null)
  );
}

/** Previous match, wrapping once to the end of the text. */
export function findPrevious(
  text: string,
  needle: string,
  fromIndex: number,
): { index: number; length: number } | null {
  if (needle.length === 0) return null;
  const hay = text.toLowerCase();
  const pin = needle.toLowerCase();
  const start = Math.max(0, fromIndex);
  const found = hay.lastIndexOf(pin, Math.max(0, start - 1));
  if (found >= 0) return { index: found, length: needle.length };
  if (start <= 0) return null;
  const wrapped = hay.lastIndexOf(pin);
  if (wrapped < 0 || wrapped === found) return null;
  return { index: wrapped, length: needle.length };
}
