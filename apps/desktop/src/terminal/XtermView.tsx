import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

import { focusPane, paneSubscribe, paneUnsubscribe, paneWrite, toBytes } from "../api";

const isMac = navigator.userAgent.includes("Mac");

const terms = new Map<string, Terminal>();

export function getTerm(paneId: string): Terminal | undefined {
  return terms.get(paneId);
}

export default function XtermView({
  paneId,
  focused,
  onFocus,
  onCellSize,
}: {
  paneId: string;
  focused: boolean;
  onFocus: (paneId: string) => void;
  onCellSize?: (w: number, h: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onFocusRef = useRef(onFocus);
  const onCellSizeRef = useRef(onCellSize);
  onFocusRef.current = onFocus;
  onCellSizeRef.current = onCellSize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      scrollback: 5000,
      fontFamily: "Menlo, 'Ubuntu Mono', 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    try {
      term.loadAddon(new CanvasAddon());
    } catch {
      /* default renderer */
    }
    term.open(host);
    fit.fit();
    termRef.current = term;
    terms.set(paneId, term);

    const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
    channel.onmessage = (msg) => {
      term.write(toBytes(msg));
    };
    void paneSubscribe(paneId, channel);

    const dataDisp = term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      void paneWrite(paneId, bytes);
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (isMac && ev.metaKey && ev.key === "c") {
        if (term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        void paneWrite(paneId, [3]);
        return false;
      }
      if (isMac && ev.metaKey && ev.key === "v") {
        void navigator.clipboard.readText().then((text) => {
          void paneWrite(paneId, Array.from(new TextEncoder().encode(text)));
        });
        return false;
      }
      if (!isMac && ev.ctrlKey && ev.shiftKey && (ev.key === "V" || ev.key === "v")) {
        void navigator.clipboard.readText().then((text) => {
          void paneWrite(paneId, Array.from(new TextEncoder().encode(text)));
        });
        return false;
      }
      return true;
    });

    const onMouse = () => {
      onFocusRef.current(paneId);
      void focusPane(paneId);
      term.focus();
    };
    host.addEventListener("mousedown", onMouse);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        reportCell(term, onCellSizeRef.current);
      } catch {
        /* layout not ready */
      }
    });
    ro.observe(host);
    reportCell(term, onCellSizeRef.current);

    return () => {
      host.removeEventListener("mousedown", onMouse);
      ro.disconnect();
      dataDisp.dispose();
      void paneUnsubscribe(paneId);
      terms.delete(paneId);
      term.dispose();
      termRef.current = null;
    };
  }, [paneId]);

  useEffect(() => {
    if (focused) {
      termRef.current?.focus();
    }
  }, [focused]);

  return <div ref={hostRef} className="xterm-host" />;
}

function reportCell(term: Terminal, onCellSize?: (w: number, h: number) => void) {
  if (!onCellSize) return;
  const core = term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
  };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  if (cell && cell.width > 0 && cell.height > 0) {
    onCellSize(cell.width, cell.height);
  }
}
