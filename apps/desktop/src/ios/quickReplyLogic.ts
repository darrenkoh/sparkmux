/** One-tap replies parsed from an agent question. The banner and the tests share this. */

export interface QuickOption {
  label: string;
  /** Characters written before Enter. Empty means a bare carriage return. */
  send: string;
  enter: boolean;
}

export function extractQuickOptions(pendingAsk: string): QuickOption[] {
  const text = pendingAsk ?? "";
  const options: QuickOption[] = [];
  if (/[\[(]\s*y\s*\/\s*n\s*[\])]/i.test(text)) {
    options.push({ label: "Yes (y)", send: "y", enter: true });
    options.push({ label: "No (n)", send: "n", enter: true });
  }
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?:^|\n)\s*(?:\(?(\d+)\)?[.)])\s+([^\n]+)/g)) {
    const n = match[1];
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const rest = match[2].trim().replace(/\s+/g, " ");
    if (!rest) continue;
    options.push({ label: `${n}: ${rest}`, send: n, enter: true });
  }
  if (/approve|press enter|confirmation required|allow this|\[enter\]/i.test(text)) {
    options.push({ label: "Approve (Enter)", send: "", enter: true });
  }
  return options;
}

export function quickReplyVisible(input: {
  composerOpen: boolean;
  attention: string | null | undefined;
  pendingAsk: string | null | undefined;
  agentState?: string | null;
}): boolean {
  if (input.composerOpen) return true;
  const attention = input.attention ?? "";
  if (attention === "needs_user" || attention === "waiting") return true;
  if ((input.pendingAsk ?? "").trim().length > 0) return true;
  const agent = input.agentState ?? "";
  return agent === "waiting" || agent === "needs_user";
}

/** Bytes for a choice pill: the choice, then a carriage return when it submits. */
export function quickOptionBytes(option: QuickOption): number[] {
  const text = option.enter ? `${option.send}\r` : option.send;
  return Array.from(new TextEncoder().encode(text));
}

export function composerBytes(draft: string): number[] {
  const normalized = draft.replace(/\r?\n/g, "\r");
  const payload = normalized.endsWith("\r") ? normalized : `${normalized}\r`;
  return Array.from(new TextEncoder().encode(payload));
}
