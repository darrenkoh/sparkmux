import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

import {
  clipboardWrite,
  pasteIntoPane,
  focusPane,
  paneSubscribe,
  paneUnsubscribe,
  paneWrite,
  screenDumpToXterm,
  toBytes,
} from "../api";

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
  fontSize,
}: {
  paneId: string;
  focused: boolean;
  onFocus: (paneId: string) => void;
  onCellSize?: (w: number, h: number, cols: number, rows: number) => void;
  fontSize: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onFocusRef = useRef(onFocus);
  const onCellSizeRef = useRef(onCellSize);
  const fontSizeRef = useRef(fontSize);
  onFocusRef.current = onFocus;
  onCellSizeRef.current = onCellSize;
  fontSizeRef.current = fontSize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      scrollback: 5000,
      // tmux %output is LF-only; without this, \n moves down and stays in
      // column, zsh PROMPT_SP thinks the line is partial and prints '%'.
      convertEol: true,
      fontFamily:
        "'0xProto Nerd Font Mono', '0xProto Nerd Font', 'MesloLGS NF', Menlo, ui-monospace, monospace",
      fontSize: fontSizeRef.current,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1.5,
      macOptionIsMeta: isMac,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
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
    fitRef.current = fit;
    term.loadAddon(fit);
    if (!isMac) {
      try {
        term.loadAddon(new CanvasAddon());
      } catch {
        /* default renderer */
      }
    }
    term.open(host);
    termRef.current = term;
    terms.set(paneId, term);

    let seeded = false;
    const channel = new Channel<ArrayBuffer | Uint8Array | number[]>();
    channel.onmessage = (msg) => {
      const bytes = toBytes(msg);
      if (!seeded) {
        seeded = true;
        term.reset();
        term.write(screenDumpToXterm(bytes));
        return;
      }
      term.write(bytes);
    };

    const dataDisp = term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      void paneWrite(paneId, bytes);
    });

    let lastPaste = 0;
    const pasteNow = () => {
      const now = Date.now();
      if (now - lastPaste < 400) return;
      lastPaste = now;
      void pasteIntoPane(paneId, Boolean(term.modes?.bracketedPasteMode));
    };

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      pasteNow();
    };
    host.addEventListener("paste", onPaste, true);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (isMac && ev.metaKey && ev.key === "c") {
        if (term.hasSelection()) {
          void clipboardWrite(term.getSelection());
          return false;
        }
        void paneWrite(paneId, [3]);
        return false;
      }
      const pasteChord =
        (isMac && ev.metaKey && ev.key === "v") ||
        (!isMac && ev.ctrlKey && ev.shiftKey && (ev.key === "V" || ev.key === "v"));
      if (pasteChord) {
        window.setTimeout(pasteNow, 0);
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

    let lastCols = 0;
    let lastRows = 0;
    let seedTimer: number | undefined;
    let subscribed = false;
    let unmounted = false;

    const doFit = () => {
      if (unmounted || host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        fit.fit();
        reportCell(term, onCellSizeRef.current);
      } catch {
        return;
      }
      if (term.cols === lastCols && term.rows === lastRows) return;
      lastCols = term.cols;
      lastRows = term.rows;
      if (subscribed) return;
      subscribed = true;
      seedTimer = window.setTimeout(() => {
        if (unmounted) return;
        void paneSubscribe(paneId, channel);
      }, 120);
    };

    requestAnimationFrame(doFit);
    const later = window.setTimeout(doFit, 50);

    const ro = new ResizeObserver(() => {
      doFit();
    });
    ro.observe(host);

    return () => {
      unmounted = true;
      if (seedTimer) window.clearTimeout(seedTimer);
      window.clearTimeout(later);
      host.removeEventListener("mousedown", onMouse);
      host.removeEventListener("paste", onPaste, true);
      ro.disconnect();
      dataDisp.dispose();
      void paneUnsubscribe(paneId);
      terms.delete(paneId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [paneId]);

  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = fontSize;
    try {
      fit.fit();
      reportCell(term, onCellSizeRef.current);
    } catch {
      /* host may be hidden */
    }
  }, [fontSize]);

  useEffect(() => {
    if (focused) {
      termRef.current?.focus();
    }
  }, [focused]);

  return <div ref={hostRef} className="xterm-host" />;
}

function reportCell(
  term: Terminal,
  onCellSize?: (w: number, h: number, cols: number, rows: number) => void,
) {
  if (!onCellSize) return;
  const core = term as unknown as {
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
    };
  };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  if (cell && cell.width > 0 && cell.height > 0) {
    onCellSize(cell.width, cell.height, term.cols, term.rows);
  }
}
