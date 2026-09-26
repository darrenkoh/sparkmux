/** tmux `#{cursor_y}` / `#{cursor_x}` are 0-based; CSI CUP is 1-based. */
export function cursorCup(y: number, x: number): string {
  const row = Math.max(0, Math.floor(y)) + 1;
  const col = Math.max(0, Math.floor(x)) + 1;
  return `\x1b[${row};${col}H`;
}
