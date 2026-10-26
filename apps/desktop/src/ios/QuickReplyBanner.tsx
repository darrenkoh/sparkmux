import { useState } from "react";

import { paneWrite } from "../api";
import {
  composerBytes,
  extractQuickOptions,
  quickOptionBytes,
  type QuickOption,
} from "./quickReplyLogic";

export interface QuickReplyBannerProps {
  paneId: string | null;
  title: string;
  pendingAsk: string;
  onDismiss: () => void;
}

export default function QuickReplyBanner({
  paneId,
  title,
  pendingAsk,
  onDismiss,
}: QuickReplyBannerProps) {
  const [draft, setDraft] = useState("");
  const options = extractQuickOptions(pendingAsk);

  async function writeBytes(bytes: number[]) {
    if (!paneId || bytes.length === 0) return;
    await paneWrite(paneId, bytes);
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(10);
    }
  }

  async function sendOption(option: QuickOption) {
    await writeBytes(quickOptionBytes(option));
  }

  async function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    await writeBytes(composerBytes(text));
    setDraft("");
  }

  return (
    <section className="quick-reply-banner" aria-label="Quick reply">
      <div className="quick-reply-head">
        <strong>{title || "WAITING FOR INPUT"}</strong>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {pendingAsk.trim() && <p className="quick-reply-ask">{pendingAsk}</p>}
      {options.length > 0 && (
        <div className="quick-reply-options" role="group" aria-label="Suggested replies">
          {options.map((option) => (
            <button key={option.label} type="button" onClick={() => void sendOption(option)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      <div className="quick-reply-compose">
        <textarea
          rows={1}
          value={draft}
          placeholder="Reply or dictate prompt…"
          aria-label="Reply or dictate prompt"
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck
          enterKeyHint="send"
          onChange={(event) => {
            setDraft(event.target.value);
            const el = event.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendDraft();
            }
          }}
        />
        <button type="button" className="quick-reply-send" onClick={() => void sendDraft()}>
          Send ↑
        </button>
      </div>
    </section>
  );
}
