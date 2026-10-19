import { invoke } from "@tauri-apps/api/core";

export type NoteLabel = "needs_user" | "failed" | "succeeded" | "running";

/**
 * Same decision as `notification_allowed` in notify_attention.rs.
 * Rust re-checks focus before any system notification is posted.
 */
export function notificationAllowed(
  appFocused: boolean,
  hidden: boolean,
  previous: NoteLabel | null,
  next: NoteLabel | null,
): boolean {
  return (
    !appFocused &&
    hidden &&
    next === "needs_user" &&
    (previous === null || previous === "running")
  );
}

/**
 * One snapshot's attention fields. `attention_label` is the classifier result
 * and survives a visible visit. `unread` and `pending_ask` are blank on that
 * visit, including a fetch that started while the window was still tmux-active.
 */
export type AttentionSample = {
  active: boolean;
  attention_label: NoteLabel | null;
  unread: boolean;
  pending_ask: string;
};

/**
 * Store the classifier label. `window.active` is the tmux current window, which
 * stays true on a hidden session. A running label there must be stored so the
 * next wait can notify. Blank unread is not a label: a visible fetch keeps
 * `attention_label` of `needs_user`.
 */
export function trackAttention(
  previous: NoteLabel | null,
  hidden: boolean,
  sample: AttentionSample,
): { label: NoteLabel | null; notify: boolean } {
  return {
    label: sample.attention_label,
    notify: notificationAllowed(false, hidden, previous, sample.attention_label),
  };
}

export function postAttentionNotification(input: {
  hidden: boolean;
  previous: NoteLabel | null;
  next: NoteLabel | null;
  body: string;
}): Promise<void> {
  if (!notificationAllowed(false, input.hidden, input.previous, input.next)) {
    return Promise.resolve();
  }
  return invoke("post_attention_notification", {
    hidden: input.hidden,
    previous: input.previous,
    next: input.next,
    body: input.body,
  });
}
