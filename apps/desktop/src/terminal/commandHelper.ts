import type { Snapshot } from "../types";

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash"]);

export function invokeError(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Could not turn on the command helper.";
}

/** Shown after the helper is turned on. The setup dialog renders this string. */
export function usageText(): string {
  return "Ask only at a bare shell. Type a plain-language request. The app inserts the command. You run it.";
}

export function licenseNotice(): string {
  return "Qwen2.5-Coder-1.5B-Instruct, Apache-2.0, Copyright 2024 Alibaba Cloud. The weight downloads once from GitHub and stays out of the app package.";
}

export function shellEligible(command: string, alternate: boolean): boolean {
  if (alternate) return false;
  const base = command.split(/[/\\]/).pop() ?? command;
  const name = base.startsWith("-") ? base.slice(1) : base;
  return SHELLS.has(name);
}

export function focusedShell(
  snap: Snapshot,
  paneId: string | null,
): { command: string; alternate: boolean } | null {
  if (!paneId) return null;
  for (const session of snap.sessions) {
    for (const win of session.windows) {
      for (const pane of win.panes) {
        if (pane.id === paneId) {
          return { command: pane.command, alternate: pane.alternate };
        }
      }
    }
  }
  return null;
}

/** Delete, move, or redirection onto a file. Shown before the user runs the inserted command. */
export function isDestructive(command: string): boolean {
  if (hasFileRedirect(command)) return true;
  return command.split(/\s+/).some((token) => {
    const word = token.replace(/^["'`\\]+|["'`\\]+$/g, "");
    return word === "rm" || word === "mv" || word === "-delete";
  });
}

/** Bytes typed into the pane. No newline and no Enter key, so the shell does not run it. */
export function insertPayload(command: string): number[] {
  const line = command.split(/\r?\n/, 1)[0]?.replace(/\r$/, "") ?? "";
  return Array.from(new TextEncoder().encode(line));
}

function hasFileRedirect(command: string): boolean {
  for (let i = 0; i < command.length; i += 1) {
    if (command[i] !== ">") continue;
    const next = command[i + 1];
    if (next === ">") {
      const after = command.slice(i + 2).trimStart();
      if (after.length > 0 && !after.startsWith("&")) return true;
      continue;
    }
    if (next === "&") continue;
    const after = command.slice(i + 1).trimStart();
    if (after.length > 0) return true;
  }
  return false;
}
