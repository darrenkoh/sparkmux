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
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, 'Ubuntu Mono', 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1.5,
      macOptionIsMeta: isMac,
      theme: {
        background: "#0d0f12",
        foreground: "#e6e8ee",
        cursor: "#e6e8ee",
        cursorAccent: "#0d0f12",
        selectionBackground: "#2a4a70",
        selectionForeground: "#ffffff",
        black: "#1c1f26",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e6e8ee",
        brightBlack: "#6b7280",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f9fafb",
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

    const doFit = () => {
      if (host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        fit.fit();
        reportCell(term, onCellSizeRef.current);
      } catch {
        /* layout not ready */
      }
    };
    requestAnimationFrame(doFit);
    const later = window.setTimeout(doFit, 40);

    const ro = new ResizeObserver(() => {
      doFit();
    });
    ro.observe(host);

    return () => {
      window.clearTimeout(later);
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
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
    };
  };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  if (cell && cell.width > 0 && cell.height > 0) {
    onCellSize(cell.width, cell.height);
  }
}
