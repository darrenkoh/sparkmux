// Shift+Return at an agent prompt starts a new line instead of submitting.

/** ESC CR. Claude, Grok, and Gemini read it as a newline in the prompt. */
export const PROMPT_NEWLINE_BYTES: readonly number[] = [0x1b, 0x0d];

export interface ReturnKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

/**
 * `pass`: not ours, the terminal handles the key as usual.
 * `newline`: swallow the key and send PROMPT_NEWLINE_BYTES.
 * `swallow`: swallow the key and send nothing. An input method is mid-word
 * and its own Return commits the text.
 */
export type ReturnAction = "pass" | "newline" | "swallow";

export function shiftReturnAction(ev: ReturnKey): ReturnAction {
  if (ev.key !== "Enter" || !ev.shiftKey) return "pass";
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return "pass";
  return ev.isComposing ? "swallow" : "newline";
}
