import { useEffect, useRef, useState } from "react";

import { pasteIntoPane, splitPane } from "../api";
import { getTerm } from "../terminal/XtermView";
import {
  composerBytes,
  extractQuickOptions,
  quickOptionBytes,
  quickReplyVisible,
  type QuickOption,
} from "./quickReplyLogic";
import {
  arrowBytes,
  consumeLatchedModifiers,
  consumeModifierPhase,
  escBytes,
  nextModifierPhase,
  shiftTabBytes,
  tabBytes,
  TMUX_CTRL,
  touchTrackpadSteps,
  trackpadMotionBytes,
  type ArrowDir,
  type ModifierPhase,
} from "./touchKeys";

export interface MobileInputDockProps {
  paneId: string | null;
  paneCommand: string;
  pendingAsk: string;
  detail: string;
  attention: string | null | undefined;
  agentState?: string | null;
  sendBytes: (paneId: string, bytes: number[]) => void;
  onFind: (paneId: string) => void;
}

const DOUBLE_TAP_MS = 320;

export default function MobileInputDock({
  paneId,
  paneCommand,
  pendingAsk,
  detail,
  attention,
  agentState,
  sendBytes,
  onFind,
}: MobileInputDockProps) {
  const [draft, setDraft] = useState("");
  const [ctrlPhase, setCtrlPhase] = useState<ModifierPhase>("idle");
  const [optPhase, setOptPhase] = useState<ModifierPhase>("idle");
  const [menuOpen, setMenuOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const lastCtrlTap = useRef(0);
  const lastOptTap = useRef(0);
  const scrub = useRef({ active: false, x: 0, y: 0, rx: 0, ry: 0, moved: false });
  const ctrlOn = ctrlPhase !== "idle";
  const optOn = optPhase !== "idle";
  const showChoices = quickReplyVisible({
    composerOpen: false,
    attention,
    pendingAsk,
    agentState,
  });
  const question = (pendingAsk || (showChoices ? detail : "")).trim();
  const options = showChoices ? extractQuickOptions(question) : [];

  function releaseLatches() {
    setCtrlPhase((phase) => consumeModifierPhase(phase));
    setOptPhase((phase) => consumeModifierPhase(phase));
  }

  function sendRaw(bytes: number[]) {
    if (!paneId || bytes.length === 0) return;
    sendBytes(paneId, bytes);
    releaseLatches();
  }

  function sendArrow(dir: ArrowDir) {
    if (!paneId || scrub.current.moved) return;
    const appCursor = Boolean(getTerm(paneId)?.modes?.applicationCursorKeysMode);
    sendRaw(arrowBytes(dir, appCursor));
  }

  function tapModifier(
    phase: ModifierPhase,
    setPhase: (next: ModifierPhase) => void,
    lastTap: React.MutableRefObject<number>,
  ) {
    const now = performance.now();
    const doubleTap = phase === "latched" && now - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = now;
    setPhase(nextModifierPhase(phase, doubleTap));
  }

  useEffect(() => {
    const consume = (data: string) => {
      const next = consumeLatchedModifiers(data, ctrlOn, optOn);
      if (next.used) releaseLatches();
      return next.text;
    };
    const host = window as Window & { __sparkmuxConsumeModifiers?: (data: string) => string };
    host.__sparkmuxConsumeModifiers = consume;
    return () => {
      if (host.__sparkmuxConsumeModifiers === consume) delete host.__sparkmuxConsumeModifiers;
    };
  }, [ctrlOn, optOn]);

  function grow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }

  function sendDraft() {
    if (!paneId || draft.trim().length === 0) return;
    sendBytes(paneId, composerBytes(draft));
    setDraft("");
    const el = areaRef.current;
    if (el) {
      el.style.height = "auto";
      el.focus();
    }
  }

  function sendOption(option: QuickOption) {
    if (!paneId) return;
    sendBytes(paneId, quickOptionBytes(option));
  }

  function keepFocus(event: React.PointerEvent) {
    event.preventDefault();
  }

  function onTrackDown(event: React.PointerEvent<HTMLDivElement>) {
    scrub.current = {
      active: true,
      x: event.clientX,
      y: event.clientY,
      rx: 0,
      ry: 0,
      moved: false,
    };
  }

  function onTrackMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!scrub.current.active || !paneId) return;
    const dx = event.clientX - scrub.current.x;
    const dy = event.clientY - scrub.current.y;
    if (!scrub.current.moved && Math.hypot(dx, dy) < 10) return;
    if (!scrub.current.moved) event.currentTarget.setPointerCapture(event.pointerId);
    scrub.current.moved = true;
    const step = touchTrackpadSteps(dx, dy, scrub.current.rx, scrub.current.ry);
    scrub.current.rx = step.residualX;
    scrub.current.ry = step.residualY;
    scrub.current.x = event.clientX;
    scrub.current.y = event.clientY;
    const appCursor = Boolean(getTerm(paneId)?.modes?.applicationCursorKeysMode);
    const bytes = trackpadMotionBytes(step.horizontal, step.vertical, appCursor, optOn);
    if (bytes.length) sendRaw(bytes);
  }

  function onTrackUp() {
    scrub.current.active = false;
  }

  const modifierClass = (phase: ModifierPhase) =>
    phase === "locked" ? "locked" : phase === "latched" ? "latched" : "";

  const placeholder = paneCommand
    ? `Message agent or type command… (${paneCommand})`
    : "Message agent or type command…";

  return (
    <section className="mobile-input-dock" aria-label="Terminal input">
      {showChoices && (
        <div className="mobile-choice-strip" aria-label="Quick choices">
          {question && <p>{question}</p>}
          <div className="mobile-choice-pills">
            {options.map((option) => (
              <button key={option.label} type="button" onClick={() => sendOption(option)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mobile-compose-row">
        <textarea
          ref={areaRef}
          rows={1}
          value={draft}
          placeholder={placeholder}
          aria-label="Message agent or type command"
          autoCorrect="on"
          autoCapitalize="sentences"
          spellCheck
          enterKeyHint="send"
          onChange={(event) => {
            setDraft(event.target.value);
            grow(event.target);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendDraft();
            }
          }}
        />
        <button type="button" className="mobile-send" onClick={sendDraft}>
          Send ↵
        </button>
      </div>

      {menuOpen && (
        <div className="mobile-util-pop" role="menu" aria-label="Pane actions">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              if (!paneId) return;
              const bracket = Boolean(getTerm(paneId)?.modes?.bracketedPasteMode);
              void pasteIntoPane(paneId, bracket);
            }}
          >
            Paste
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              if (!paneId) return;
              onFind(paneId);
            }}
          >
            Find 🔍
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              if (paneId) void splitPane(paneId, false);
            }}
          >
            Split ⬌
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              if (paneId) void splitPane(paneId, true);
            }}
          >
            Split ⬍
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              sendRaw(shiftTabBytes());
            }}
          >
            Shift-Tab
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              sendRaw([...TMUX_CTRL.eof]);
            }}
          >
            ^D
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              sendRaw([...TMUX_CTRL.clear]);
            }}
          >
            ^L
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              areaRef.current?.blur();
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            Hide ⌨
          </button>
        </div>
      )}

      <div className="mobile-key-row" role="toolbar" aria-label="Terminal keys">
        <button type="button" onPointerDown={keepFocus} onPointerUp={() => sendRaw(escBytes())}>
          esc
        </button>
        <button
          type="button"
          className={modifierClass(ctrlPhase)}
          aria-pressed={ctrlOn}
          data-phase={ctrlPhase}
          onPointerDown={keepFocus}
          onPointerUp={() => tapModifier(ctrlPhase, setCtrlPhase, lastCtrlTap)}
        >
          ctrl{ctrlPhase === "locked" ? " ●" : ""}
        </button>
        <button
          type="button"
          className={modifierClass(optPhase)}
          aria-pressed={optOn}
          data-phase={optPhase}
          onPointerDown={keepFocus}
          onPointerUp={() => tapModifier(optPhase, setOptPhase, lastOptTap)}
        >
          opt{optPhase === "locked" ? " ●" : ""}
        </button>
        <button type="button" onPointerDown={keepFocus} onPointerUp={() => sendRaw(tabBytes())}>
          tab
        </button>
        <button
          type="button"
          onPointerDown={keepFocus}
          onPointerUp={() => sendRaw([...TMUX_CTRL.interrupt])}
        >
          ^C
        </button>
        <div
          className="mobile-arrows"
          role="group"
          aria-label="Arrow keys"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
        >
          <button type="button" aria-label="Left" onClick={() => sendArrow("D")}>
            ←
          </button>
          <button type="button" aria-label="Down" onClick={() => sendArrow("B")}>
            ↓
          </button>
          <button type="button" aria-label="Up" onClick={() => sendArrow("A")}>
            ↑
          </button>
          <button type="button" aria-label="Right" onClick={() => sendArrow("C")}>
            →
          </button>
        </div>
        <button
          type="button"
          aria-label="Pane actions"
          aria-expanded={menuOpen}
          onPointerDown={keepFocus}
          onPointerUp={() => setMenuOpen((open) => !open)}
        >
          ⋯
        </button>
      </div>
    </section>
  );
}
