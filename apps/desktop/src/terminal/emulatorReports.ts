// xterm.js answers cursor, size, device, and mode queries that arrive in
// pane output. tmux has already answered those for the process in the pane.
// Sending the second reply back with send-keys arrives while a select prompt
// is laying out its options, and the list redraws against the wrong row.

const EMULATOR_REPORT =
  /^(?:\x1b\[\d+;\d+R|\x1b\[\?\d+;\d+R|\x1b\[0n|\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\??\d+;\d+\$y|\x1b\[\d+;\d+(?:;\d+)?t|\x1b\].*(?:\x07|\x1b\\)|\x1bP.*\x1b\\)$/;

export function isEmulatorReport(data: string): boolean {
  return EMULATOR_REPORT.test(data);
}
