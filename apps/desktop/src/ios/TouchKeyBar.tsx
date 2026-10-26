import { useEffect, useRef, useState } from "react";

import { pasteIntoPane, splitPane } from "../api";
import { getTerm } from "../terminal/XtermView";
import type { FormFactorPosture } from "./posture";
import {
  arrowBytes,
  consumeLatchedModifiers,
  consumeModifierPhase,
  encodeCtrlLetter,
  escBytes,
  nextModifierPhase,
  shiftTabBytes,
  tabBytes,
  textBytes,
  TMUX_CTRL,
  touchTrackpadSteps,
  trackpadMotionBytes,
  type ModifierPhase,
} from "./touchKeys";

export interface TouchKeyBarProps {
  paneId: string | null;
  zoomedPaneId: string | null;
  onToggleZoomPane: (paneId: string) => void;
  posture: FormFactorPosture;
  onChangePostureOverride: (next: FormFactorPosture | null) => void;
  postureOverride: FormFactorPosture | null;
  sendBytes: (paneId: string, bytes: number[]) => void;
  onToggleComposer?: () => void;
  onFind?: (paneId: string) => void;
  onRecipes?: () => void;
  onClosePane?: (paneId: string) => void;
}

const DOUBLE_TAP_MS = 320;

export default function TouchKeyBar({
  paneId,
  zoomedPaneId,
  onToggleZoomPane,
  posture,
  onChangePostureOverride,
  postureOverride,
  sendBytes,
  onToggleComposer,
  onFind,
  onRecipes,
  onClosePane,
}: TouchKeyBarProps) {
  const [ctrlPhase, setCtrlPhase] = useState<ModifierPhase>("idle");
  const [optPhase, setOptPhase] = useState<ModifierPhase>("idle");
  const [tmuxBarOpen, setTmuxBarOpen] = useState(false);
  const lastCtrlTap = useRef(0);
  const lastOptTap = useRef(0);
  const scrub = useRef({ active: false, x: 0, y: 0, rx: 0, ry: 0, moved: false });
  const landscape = posture === "phone-landscape";
  const ctrlOn = ctrlPhase !== "idle";
  const optOn = optPhase !== "idle";

  function releaseLatches() {
    setCtrlPhase((phase) => consumeModifierPhase(phase));
    setOptPhase((phase) => consumeModifierPhase(phase));
  }

  function sendRaw(bytes: number[]) {
    if (!paneId || bytes.length === 0) return;
    sendBytes(paneId, bytes);
    releaseLatches();
    getTerm(paneId)?.focus();
  }

  function sendText(text: string) {
    if (!paneId) return;
    if (ctrlOn && text.length === 1) {
      const code = encodeCtrlLetter(text);
      if (code !== null) {
        const prefixed = optOn ? [0x1b, code] : [code];
        sendRaw(prefixed);
        return;
      }
    }
    sendRaw(textBytes(text, optOn));
  }

  function sendArrow(dir: "A" | "B" | "C" | "D") {
    if (!paneId) return;
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
      if (host.__sparkmuxConsumeModifiers === consume) {
        delete host.__sparkmuxConsumeModifiers;
      }
    };
  }, [ctrlOn, optOn]);

  const preventFocusLoss = (event: React.PointerEvent) => {
    event.preventDefault();
  };

  function onTrackDown(event: React.PointerEvent<HTMLDivElement>) {
    scrub.current = {
      active: true,
      x: event.clientX,
      y: event.clientY,
      rx: 0,
      ry: 0,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onTrackMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!scrub.current.active || !paneId) return;
    const dx = event.clientX - scrub.current.x;
    const dy = event.clientY - scrub.current.y;
    if (!scrub.current.moved && Math.hypot(dx, dy) < 10) return;
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

  const keys = (
    <>
      <button type="button" className="tk-btn" onClick={() => sendRaw(escBytes())}>
        esc
      </button>
      <button
        type="button"
        className={`tk-btn ${modifierClass(ctrlPhase)}`}
        aria-pressed={ctrlOn}
        data-phase={ctrlPhase}
        onClick={() => tapModifier(ctrlPhase, setCtrlPhase, lastCtrlTap)}
      >
        ctrl{ctrlPhase === "locked" ? " ●" : ""}
      </button>
      <button
        type="button"
        className={`tk-btn ${modifierClass(optPhase)}`}
        aria-pressed={optOn}
        data-phase={optPhase}
        onClick={() => tapModifier(optPhase, setOptPhase, lastOptTap)}
      >
        opt{optPhase === "locked" ? " ●" : ""}
      </button>
      <button type="button" className="tk-btn" onClick={() => sendRaw(tabBytes())}>
        tab
      </button>
      <button
        type="button"
        className="tk-btn"
        aria-label="Compose reply"
        onClick={() => onToggleComposer?.()}
      >
        💬
      </button>
      <button type="button" className="tk-btn" onClick={() => sendRaw([...TMUX_CTRL.interrupt])}>
        ^C
      </button>
    </>
  );

  const arrows = (
    <>
      <button type="button" className="tk-btn" onClick={() => sendArrow("D")} aria-label="Left">
        ←
      </button>
      <button type="button" className="tk-btn" onClick={() => sendArrow("B")} aria-label="Down">
        ↓
      </button>
      <button type="button" className="tk-btn" onClick={() => sendArrow("A")} aria-label="Up">
        ↑
      </button>
      <button type="button" className="tk-btn" onClick={() => sendArrow("C")} aria-label="Right">
        →
      </button>
    </>
  );

  const symbols = (
    <>
      <button type="button" className="tk-btn" onClick={() => sendText("-")}>
        -
      </button>
      <button type="button" className="tk-btn" onClick={() => sendText("/")}>
        /
      </button>
      <button type="button" className="tk-btn" onClick={() => sendText("|")}>
        |
      </button>
      <button type="button" className="tk-btn" onClick={() => sendText("~")}>
        ~
      </button>
    </>
  );

  return (
    <div
      className={`touch-keybar-wrap touch-keybar-v2 ${landscape ? "landscape-rail" : "portrait-deck"}`}
      onPointerDown={preventFocusLoss}
    >
      {tmuxBarOpen && paneId && (
        <div className="touch-keybar-sub" role="toolbar" aria-label="Pane and tmux actions">
          <button type="button" className="tk-btn tk-accent" onClick={() => void splitPane(paneId, false)}>
            Split ⬌
          </button>
          <button type="button" className="tk-btn tk-accent" onClick={() => void splitPane(paneId, true)}>
            Split ⬍
          </button>
          <button
            type="button"
            className={`tk-btn ${zoomedPaneId === paneId ? "latched" : ""}`}
            onClick={() => onToggleZoomPane(paneId)}
          >
            {zoomedPaneId === paneId ? "Unzoom" : "Zoom"}
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() => {
              onFind?.(paneId);
              window.dispatchEvent(new CustomEvent("sparkmux-find", { detail: { paneId } }));
            }}
          >
            Find 🔍
          </button>
          <button type="button" className="tk-btn" onClick={() => onRecipes?.()}>
            Recipes ?
          </button>
          <button type="button" className="tk-btn" onClick={() => sendRaw([...TMUX_CTRL.interrupt])}>
            ^C
          </button>
          <button type="button" className="tk-btn" onClick={() => sendRaw([...TMUX_CTRL.eof])}>
            ^D
          </button>
          <button type="button" className="tk-btn" onClick={() => sendRaw([...TMUX_CTRL.suspend])}>
            ^Z
          </button>
          <button type="button" className="tk-btn" onClick={() => sendRaw([...TMUX_CTRL.clear])}>
            ^L
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() => {
              if (window.confirm("Close this pane?")) onClosePane?.(paneId);
            }}
          >
            Close
          </button>
          <select
            className="tk-posture-select"
            value={postureOverride ?? "auto"}
            aria-label="Form factor posture layout"
            onChange={(event) => {
              const value = event.target.value;
              onChangePostureOverride(value === "auto" ? null : (value as FormFactorPosture));
            }}
          >
            <option value="auto">Layout: Auto ({posture})</option>
            <option value="duo-book">Duo Book (Left/Right)</option>
            <option value="duo-clamshell">Duo Clamshell (Top/Bottom)</option>
            <option value="ipad-pro">iPad Pro (3-Col)</option>
            <option value="phone-compact">Phone Compact</option>
            <option value="phone-landscape">Phone Landscape</option>
          </select>
        </div>
      )}

      <div
        className={`touch-keybar ${landscape ? "split-thumb" : ""}`}
        role="toolbar"
        aria-label="Terminal extra keys"
      >
        <div className="tk-cluster left">{keys}</div>
        <div
          className="tk-trackpad"
          role="application"
          aria-label="Cursor trackpad"
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={onTrackUp}
        >
          {landscape ? "trackpad" : arrows}
        </div>
        <div className="tk-cluster right">
          {landscape && arrows}
          {symbols}
          <button type="button" className="tk-btn" onClick={() => sendRaw(shiftTabBytes())}>
            shift-tab
          </button>
          <button
            type="button"
            className={`tk-btn tk-tmux ${tmuxBarOpen ? "latched" : ""}`}
            onClick={() => setTmuxBarOpen((value) => !value)}
            title="Pane and tmux controls"
          >
            tmux
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() => {
              if (!paneId) return;
              const bracket = Boolean(getTerm(paneId)?.modes?.bracketedPasteMode);
              void pasteIntoPane(paneId, bracket);
            }}
          >
            paste
          </button>
          <button
            type="button"
            className="tk-btn"
            aria-label="Hide keyboard"
            onClick={() => {
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            hide
          </button>
        </div>
      </div>
    </div>
  );
}
