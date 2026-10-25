import { useEffect, useState } from "react";

import { pasteIntoPane, splitPane } from "../api";
import { getTerm } from "../terminal/XtermView";
import type { FormFactorPosture } from "./posture";
import {
  arrowBytes,
  consumeLatchedModifiers,
  encodeCtrlLetter,
  escBytes,
  shiftTabBytes,
  tabBytes,
  textBytes,
  TMUX_CTRL,
} from "./touchKeys";

export interface TouchKeyBarProps {
  paneId: string | null;
  zoomedPaneId: string | null;
  onToggleZoomPane: (paneId: string) => void;
  posture: FormFactorPosture;
  onChangePostureOverride: (next: FormFactorPosture | null) => void;
  postureOverride: FormFactorPosture | null;
  sendBytes: (paneId: string, bytes: number[]) => void;
}

export default function TouchKeyBar({
  paneId,
  zoomedPaneId,
  onToggleZoomPane,
  posture,
  onChangePostureOverride,
  postureOverride,
  sendBytes,
}: TouchKeyBarProps) {
  const [ctrlLatched, setCtrlLatched] = useState(false);
  const [altLatched, setAltLatched] = useState(false);
  const [tmuxBarOpen, setTmuxBarOpen] = useState(false);

  function sendRaw(bytes: number[]) {
    if (!paneId) return;
    sendBytes(paneId, bytes);
    setCtrlLatched(false);
    setAltLatched(false);
    getTerm(paneId)?.focus();
  }

  function sendText(text: string) {
    if (!paneId) return;
    if (ctrlLatched && text.length === 1) {
      const code = encodeCtrlLetter(text);
      if (code !== null) {
        sendRaw([code]);
        return;
      }
    }
    sendRaw(textBytes(text, altLatched));
  }

  function sendArrow(dir: "A" | "B" | "C" | "D") {
    if (!paneId) return;
    const appCursor = Boolean(getTerm(paneId)?.modes?.applicationCursorKeysMode);
    sendRaw(arrowBytes(dir, appCursor));
  }

  useEffect(() => {
    const consume = (data: string) => {
      const next = consumeLatchedModifiers(data, ctrlLatched, altLatched);
      if (next.used) {
        setCtrlLatched(false);
        setAltLatched(false);
      }
      return next.text;
    };
    const host = window as Window & { __sparkmuxConsumeModifiers?: (data: string) => string };
    host.__sparkmuxConsumeModifiers = consume;
    return () => {
      if (host.__sparkmuxConsumeModifiers === consume) {
        delete host.__sparkmuxConsumeModifiers;
      }
    };
  }, [ctrlLatched, altLatched]);

  const preventFocusLoss = (event: React.PointerEvent) => {
    event.preventDefault();
  };

  return (
    <div className="touch-keybar-wrap" onPointerDown={preventFocusLoss}>
      {tmuxBarOpen && paneId && (
        <div className="touch-keybar-sub" role="toolbar" aria-label="Pane and tmux actions">
          <button type="button" className="tk-btn tk-accent" onClick={() => void splitPane(paneId, false)}>
            Split horizontal
          </button>
          <button type="button" className="tk-btn tk-accent" onClick={() => void splitPane(paneId, true)}>
            Split vertical
          </button>
          <button
            type="button"
            className={`tk-btn ${zoomedPaneId === paneId ? "latched" : ""}`}
            onClick={() => onToggleZoomPane(paneId)}
          >
            {zoomedPaneId === paneId ? "Unzoom Pane" : "Zoom Pane"}
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
          </select>
        </div>
      )}

      <div className="touch-keybar" role="toolbar" aria-label="Terminal extra keys">
        <button type="button" className="tk-btn" onClick={() => sendRaw(escBytes())}>
          esc
        </button>
        <button
          type="button"
          className={`tk-btn ${ctrlLatched ? "latched" : ""}`}
          aria-pressed={ctrlLatched}
          onClick={() => setCtrlLatched((value) => !value)}
        >
          ctrl
        </button>
        <button
          type="button"
          className={`tk-btn ${altLatched ? "latched" : ""}`}
          aria-pressed={altLatched}
          onClick={() => setAltLatched((value) => !value)}
        >
          opt
        </button>
        <button type="button" className="tk-btn" onClick={() => sendRaw(tabBytes())}>
          tab
        </button>
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
        <span className="tk-sep" />
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
        <span className="tk-sep" />
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
  );
}
