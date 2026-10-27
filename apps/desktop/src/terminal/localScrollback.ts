/** Phone-only scrollback. These bytes are written into the local xterm and are never sent to the pane. */

const ALT_MODES = new Set(["47", "1047", "1049"]);

export interface LocalScrollFilter {
  out: Uint8Array;
  /** An escape sequence cut off at the end of this chunk. Feed it back next time. */
  rest: Uint8Array;
}

export interface HistoryEntry {
  kind: string;
  body: string;
}

/**
 * Drop alternate-screen switches and erase-scrollback.
 * A phone can then keep a normal-buffer copy and scroll it without moving the Mac.
 * Mouse-tracking modes in the same sequence stay.
 */
export function filterLocalScrollback(bytes: Uint8Array): LocalScrollFilter {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0x1b) {
      out.push(bytes[i]);
      i += 1;
      continue;
    }
    if (i + 1 >= bytes.length) {
      return finish(out, bytes.subarray(i));
    }
    if (bytes[i + 1] !== 0x5b) {
      out.push(bytes[i], bytes[i + 1]);
      i += 2;
      continue;
    }
    let j = i + 2;
    while (j < bytes.length && bytes[j] >= 0x20 && bytes[j] <= 0x3f) j += 1;
    if (j >= bytes.length) {
      return finish(out, bytes.subarray(i));
    }
    const final = bytes[j];
    if (final < 0x40 || final > 0x7e) {
      out.push(bytes[i]);
      i += 1;
      continue;
    }
    const kept = rewriteCsi(bytes.subarray(i, j + 1));
    if (kept) {
      for (let n = 0; n < kept.length; n += 1) out.push(kept[n]);
    }
    i = j + 1;
  }
  return finish(out, new Uint8Array());
}

function finish(out: number[], rest: Uint8Array): LocalScrollFilter {
  if (rest.length > 32) {
    for (let n = 0; n < rest.length; n += 1) out.push(rest[n]);
    return { out: Uint8Array.from(out), rest: new Uint8Array() };
  }
  return { out: Uint8Array.from(out), rest };
}

/** Null drops the sequence. */
function rewriteCsi(seq: Uint8Array): Uint8Array | null {
  const final = seq[seq.length - 1];
  const params = latin1(seq.subarray(2, seq.length - 1));
  if (final === 0x4a && params === "3") return null;
  if ((final === 0x68 || final === 0x6c) && params.startsWith("?")) {
    const numbers = params.slice(1).split(";").filter((part) => part.length > 0);
    const kept = numbers.filter((part) => !ALT_MODES.has(part));
    if (kept.length === numbers.length) return seq;
    if (kept.length === 0) return null;
    return latin1Bytes(`\x1b[?${kept.join(";")}${String.fromCharCode(final)}`);
  }
  return seq;
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}

function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Grok, Claude, and Antigravity keep the conversation in a transcript file. */
export function commandHasTranscript(command: string): boolean {
  return /grok|claude|antigravity|\bagy\b/i.test(command);
}

/**
 * Conversation lines for the phone's own scrollback, oldest first.
 * Tool logs stay out so a drag reads the prompts and replies.
 * The live screen is drawn underneath these lines and is not included here.
 */
export function independentHistoryLines(entries: HistoryEntry[], maxLines = 400): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "user" && entry.kind !== "assistant") continue;
    const body = plain(entry.body);
    if (!body) continue;
    lines.push(entry.kind === "user" ? "— You —" : "— Agent —");
    for (const line of body.split("\n")) lines.push(line);
    lines.push("");
  }
  if (lines.length <= maxLines) return lines;
  return lines.slice(lines.length - maxLines);
}

/** xterm.write would honor escapes inside a transcript. History is plain text. */
function plain(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
}
