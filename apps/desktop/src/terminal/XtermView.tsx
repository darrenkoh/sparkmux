import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import {
  clipboardWrite,
  openHttpUrl,
  pasteIntoPane,
  focusPane,
  paneCursor,
  bindPaneOutput,
  paneUnsubscribe,
  paneWrite,
} from "../api";
import { cursorCup } from "./cursorCup";
import { findNext, findPrevious, matchLineColumn } from "./scrollbackSearch";
import { isEmulatorReport } from "./emulatorReports";

import { applyPaneSeed } from "./paneSeed";
import { touchDragDelta } from "../ios/touchKeys";
import {
  altScreenArrows,
  decideWheel,
  inputFollowsPrompt,
  viewportAtBottom,
  mouseModeWrite,
  wheelReport,
  type PaneInputMode,
  type WheelContext,
} from "./promptScroll";

const isMac = navigator.userAgent.includes("Mac");

const terms = new Map<string, Terminal>();

export function getTerm(paneId: string): Terminal | undefined {
  return terms.get(paneId);
}

const idleMode: PaneInputMode = {
  alternate: false,
  mouse: false,
  mouseDrag: false,
  mouseAny: false,
  mouseSgr: false,
};

export default function XtermView({
  paneId,
  focused,
  onFocus,
  onCellSize,
  fontSize,
  inputMode,
  paneCols,
  paneRows,
}: {
  paneId: string;
  focused: boolean;
  onFocus: (paneId: string) => void;
  onCellSize?: (w: number, h: number, cols: number, rows: number) => void;
  fontSize: number;
  inputMode?: PaneInputMode;
  paneCols?: number;
  paneRows?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onFocusRef = useRef(onFocus);
  const onCellSizeRef = useRef(onCellSize);
  const fontSizeRef = useRef(fontSize);
  const inputModeRef = useRef(inputMode);
  const focusedRef = useRef(focused);
  const paneColsRef = useRef(paneCols);
  const paneRowsRef = useRef(paneRows);
  const doFitRef = useRef<() => void>(() => {});
  const redrawCaretRef = useRef<(forceBottom?: boolean) => void>(() => {});
  const syncTmuxCursorRef = useRef<(forceBottom?: boolean) => void>(() => {});
  const restoreMouseRef = useRef<() => void>(() => {});
  const findOpenRef = useRef(false);
  const findRef = useRef<HTMLInputElement>(null);
  const findNextFromRef = useRef(0);
  const findPrevFromRef = useRef(0);
  const [findOpen, setFindOpen] = useState(false);
  findOpenRef.current = findOpen;
  onFocusRef.current = onFocus;
  onCellSizeRef.current = onCellSize;
  fontSizeRef.current = fontSize;
  inputModeRef.current = inputMode;
  focusedRef.current = focused;
  paneColsRef.current = paneCols;
  paneRowsRef.current = paneRows;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      allowProposedApi: true,
      // Keep in step with sparkmux_core::PANE_SCROLLBACK_LINES.
      scrollback: 5000,
      fontFamily:
        "'0xProto Nerd Font Mono', '0xProto Nerd Font', 'MesloLGS NF', Menlo, ui-monospace, monospace",
      fontSize: fontSizeRef.current,
      lineHeight: 1.2,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1.5,
      macOptionIsMeta: isMac,
      // Mouse reports and alt-screen arrow keys are user input. Following
      // them scrolls a selection back onto the prompt.
      scrollOnUserInput: false,
      // The default handler confirms, then calls window.open. The webview
      // blocks that, so the click does nothing. http(s) only; other schemes
      // are dropped here and rejected again in open_http_url.
      linkHandler: {
        activate(_event, uri) {
          openTerminalLink(uri);
        },
      },
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
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        openTerminalLink(uri);
      }),
    );
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

    let unmounted = false;
    let applyingSeed = false;

    const showCaret = (target: Terminal, forceBottom: boolean) => {
      const buf = target.buffer.active;
      if (!target.hasSelection() && (forceBottom || viewportAtBottom(buf.viewportY, buf.baseY))) {
        target.scrollToBottom();
      }
      target.refresh(0, Math.max(0, target.rows - 1));
    };

    const redrawCaret = (forceBottom = false) => {
      if (applyingSeed) return;
      showCaret(term, forceBottom);
    };

    const scrollCursorIntoView = (row: number, col = 0) => {
      const host = hostRef.current;
      const live = termRef.current;
      if (!host || !live) return;
      const { width: cellW, height: cellH } = cellSize(live);
      if (cellH <= 0) return;
      const targetTop = row * cellH;
      const maxRow = Math.min(live.rows, row + 4);
      const targetBottom = maxRow * cellH;
      const viewH = host.clientHeight;
      if (targetTop < host.scrollTop) {
        host.scrollTop = targetTop;
      } else if (targetBottom > host.scrollTop + viewH) {
        host.scrollTop = Math.max(0, targetBottom - viewH + 4);
      }
      if (cellW > 0) {
        const targetLeft = col * cellW;
        const viewW = host.clientWidth;
        if (targetLeft < host.scrollLeft) {
          host.scrollLeft = targetLeft;
        } else if (targetLeft + cellW > host.scrollLeft + viewW) {
          host.scrollLeft = Math.max(0, targetLeft + cellW - viewW + 8);
        }
      }
    };

    const syncTmuxCursor = (forceBottom = false) => {
      if (applyingSeed) return;
      void paneCursor(paneId)
        .then((pos) => {
          if (unmounted) return;
          const live = termRef.current;
          if (!live) return;
          live.write(cursorCup(pos.y, pos.x), () => {
            showCaret(live, forceBottom);
            scrollCursorIntoView(pos.y, pos.x);
          });
        })
        .catch(() => {
          /* pane may have closed during resize */
        });
    };

    redrawCaretRef.current = redrawCaret;
    syncTmuxCursorRef.current = syncTmuxCursor;

    const seedState = { seeded: false };
    // The text seed calls reset(), which drops mouse tracking. Restore only
    // after that paint so a tab switch still delivers clicks to Grok.
    let seedApplied = false;
    const restoreMouse = () => {
      if (!seedApplied || unmounted) return;
      const live = termRef.current;
      const mode = inputModeRef.current;
      if (!live || !mode) return;
      const seq = mouseModeWrite(live.modes?.mouseTrackingMode, mode);
      if (seq) live.write(seq);
    };
    restoreMouseRef.current = restoreMouse;

    const paintSeed = (bytes: Uint8Array) => {
      seedState.seeded = true;
      applyPaneSeed(
        term,
        bytes,
        () => {
          applyingSeed = false;
          host.style.visibility = "";
          seedApplied = true;
          if (unmounted) return;
          doFitRef.current();
          term.scrollToBottom();
          syncTmuxCursor(true);
          restoreMouse();
          if (focusedRef.current) {
            term.focus();
          }
        },
        () => {
          applyingSeed = true;
          host.style.visibility = "hidden";
        },
      );
    };
    const dataDisp = term.onData((raw) => {
      // tmux already answered the query that produced this. A second reply
      // is typed into the select prompt and the options redraw out of order.
      if (isEmulatorReport(raw)) return;
      const transform = (window as Window & { __sparkmuxConsumeModifiers?: (data: string) => string })
        .__sparkmuxConsumeModifiers;
      const data = typeof transform === "function" ? transform(raw) : raw;
      // Letters and editing keys reveal the prompt. Wheel, mouse, and arrows
      // must not, or a scroll-to-select snaps back down.
      if (inputFollowsPrompt(data) && !term.hasSelection()) term.scrollToBottom();
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

    let touchScrollY = 0;
    let touchAccumPx = 0;
    let touchMulti = false;
    const onTouchStart = (ev: TouchEvent) => {
      if (ev.touches.length !== 1) {
        touchMulti = true;
        return;
      }
      touchMulti = false;
      touchScrollY = ev.touches[0].clientY;
      touchAccumPx = 0;
      onFocusRef.current(paneId);
      void focusPane(paneId);
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (touchMulti || ev.touches.length !== 1) return;
      const curY = ev.touches[0].clientY;
      touchAccumPx += touchDragDelta(touchScrollY, curY);
      touchScrollY = curY;
      const rowH = Math.max(12, cellHeight(term));
      if (Math.abs(touchAccumPx) < rowH * 0.75) return;
      const fakeWheel = {
        deltaY: touchAccumPx,
        deltaMode: 0,
        shiftKey: false,
        clientX: ev.touches[0].clientX,
        clientY: ev.touches[0].clientY,
      } as WheelEvent;
      touchAccumPx = 0;
      const decision = decideWheel(wheelContext(term, fakeWheel, inputModeRef.current ?? idleMode));
      if (decision.kind === "scroll") {
        term.scrollLines(decision.lines);
        ev.preventDefault();
      } else if (decision.kind === "report") {
        const pos = cellFromWheel(term, fakeWheel);
        const bytes = wheelReport(
          decision.up,
          pos.col,
          pos.row,
          (inputModeRef.current ?? idleMode).mouseSgr,
        );
        void paneWrite(paneId, bytes);
        if (!term.hasSelection()) term.scrollToBottom();
        ev.preventDefault();
      } else if (decision.kind === "arrows") {
        const bytes = altScreenArrows(
          decision.lines < 0,
          Math.abs(decision.lines),
          Boolean(term.modes?.applicationCursorKeysMode),
        );
        void paneWrite(paneId, bytes);
        if (!term.hasSelection()) term.scrollToBottom();
        ev.preventDefault();
      }
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });

    // Page Up/Down while a draft is showing. A trackpad emits a wheel event
    // per frame; one page per event would fly through the transcript.
    let pageLines = 0;
    let lastPageAt = 0;
    term.attachCustomWheelEventHandler((ev) => {
      const decision = decideWheel(wheelContext(term, ev, inputModeRef.current ?? idleMode));
      if (decision.kind === "passthrough") return true;
      if (decision.kind === "scroll") {
        term.scrollLines(decision.lines);
      } else if (decision.kind === "report") {
        const pos = cellFromWheel(term, ev);
        const bytes = wheelReport(
          decision.up,
          pos.col,
          pos.row,
          (inputModeRef.current ?? idleMode).mouseSgr,
        );
        void paneWrite(paneId, bytes);
        // The seeded buffer is not Grok's transcript. Keep it pinned so a
        // wheel the webview will not cancel cannot park on a blank row.
        if (!term.hasSelection()) term.scrollToBottom();
      } else if (decision.kind === "arrows") {
        const bytes = altScreenArrows(
          decision.lines < 0,
          Math.abs(decision.lines),
          Boolean(term.modes?.applicationCursorKeysMode),
        );
        void paneWrite(paneId, bytes);
        if (!term.hasSelection()) term.scrollToBottom();
      } else {
        pageLines += decision.lines;
        const now = performance.now();
        if (pageLines !== 0 && now - lastPageAt >= 48) {
          const key = pageLines < 0 ? "\x1b[5~" : "\x1b[6~";
          const pages = Math.min(2, Math.max(1, Math.round(Math.abs(pageLines) / 12)));
          term.input(key.repeat(pages), false);
          pageLines = 0;
          lastPageAt = now;
        }
      }
      ev.preventDefault();
      ev.stopPropagation();
      return false;
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      if (findOpenRef.current) return false;
      if (isFindChord(ev) && !foreignField(ev, host)) {
        findNextFromRef.current = 0;
        findPrevFromRef.current = 0;
        setFindOpen(true);
        return false;
      }
      const isCopyChord =
        (isMac && ev.metaKey && (ev.key === "c" || ev.key === "C")) ||
        (!isMac &&
          ev.ctrlKey &&
          ((ev.shiftKey && (ev.key === "c" || ev.key === "C")) ||
            ((ev.key === "c" || ev.key === "C") && term.hasSelection())));
      if (isCopyChord) {
        if (term.hasSelection()) {
          void clipboardWrite(term.getSelection());
          return false;
        }
        if (isMac && ev.metaKey) {
          void paneWrite(paneId, [3]);
          return false;
        }
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

    let downX = 0;
    let downY = 0;
    let pressed = false;
    const onMouseDown = (ev: MouseEvent) => {
      pressed = true;
      downX = ev.clientX;
      downY = ev.clientY;
      onFocusRef.current(paneId);
      void focusPane(paneId);
      term.focus();
    };
    // xterm activates a link on mouseup of the screen element. Refreshing on
    // mousedown clears the hovered link first, so the click never opens.
    // Listen on window so this runs after that, including when the button is
    // released outside the pane. A drag is a selection; leave scrollback put.
    const onMouseUp = (ev: MouseEvent) => {
      if (!pressed) return;
      pressed = false;
      const moved = Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY) > 3;
      if (moved || term.hasSelection()) return;
      const buf = term.buffer.active;
      if (!viewportAtBottom(buf.viewportY, buf.baseY)) return;
      redrawCaret(true);
      syncTmuxCursor(true);
    };
    host.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);

    let lastCols = 0;
    let lastRows = 0;
    let seedTimer: number | undefined;
    let cursorTimer: number | undefined;
    let reseedTimer: number | undefined;
    let subscribed = false;

    const doFit = () => {
      if (applyingSeed || unmounted) return;
      if (paneColsRef.current && paneRowsRef.current) {
        try {
          term.resize(paneColsRef.current, paneRowsRef.current);
          reportCell(term, onCellSizeRef.current);
        } catch {
          return;
        }
      } else {
        if (host.clientWidth < 2 || host.clientHeight < 2) return;
        try {
          fit.fit();
          reportCell(term, onCellSizeRef.current);
        } catch {
          return;
        }
      }
      redrawCaret();
      if (term.cols === lastCols && term.rows === lastRows) return;
      const hadGrid = lastCols > 0 && lastRows > 0;
      lastCols = term.cols;
      lastRows = term.rows;
      if (hadGrid) {
        if (cursorTimer) window.clearTimeout(cursorTimer);
        cursorTimer = window.setTimeout(() => {
          if (!unmounted) syncTmuxCursor();
        }, 120);
        if (reseedTimer) window.clearTimeout(reseedTimer);
        reseedTimer = window.setTimeout(() => {
          if (unmounted) return;
          seedState.seeded = false;
          void bindPaneOutput(paneId, seedState, {
            seed: paintSeed,
            write: (bytes) => term.write(bytes),
          });
        }, 150);
      }
      if (subscribed) return;
      subscribed = true;
      seedTimer = window.setTimeout(() => {
        if (unmounted) return;
        void bindPaneOutput(paneId, seedState, {
          seed: paintSeed,
          write: (bytes) => term.write(bytes),
        });
      }, 0);
    };

    doFitRef.current = doFit;
    requestAnimationFrame(doFit);
    const later = window.setTimeout(doFit, 50);

    const ro = new ResizeObserver(() => {
      doFit();
    });
    ro.observe(host);

    return () => {
      unmounted = true;
      doFitRef.current = () => {};
      redrawCaretRef.current = () => {};
      syncTmuxCursorRef.current = () => {};
      restoreMouseRef.current = () => {};
      if (seedTimer) window.clearTimeout(seedTimer);
      if (cursorTimer) window.clearTimeout(cursorTimer);
      if (reseedTimer) window.clearTimeout(reseedTimer);
      window.clearTimeout(later);
      host.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
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
    paneColsRef.current = paneCols;
    paneRowsRef.current = paneRows;
    doFitRef.current();
  }, [paneCols, paneRows]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    doFitRef.current();
  }, [fontSize]);

  useEffect(() => {
    if (!focused) setFindOpen(false);
  }, [focused]);

  useEffect(() => {
    if (!findOpen) return;
    findRef.current?.focus();
    findRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    if (focused && !findOpen) {
      termRef.current?.focus();
      redrawCaretRef.current(true);
      syncTmuxCursorRef.current(true);
    }
  }, [focused, findOpen]);

  function reveal(backward: boolean) {
    const term = termRef.current;
    const needle = findRef.current?.value ?? "";
    if (!term) return;
    if (needle.length === 0) {
      term.clearSelection();
      return;
    }
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buf.length; row += 1) {
      lines.push(buf.getLine(row)?.translateToString(true) ?? "");
    }
    const text = lines.join("\n");
    const hit = backward
      ? findPrevious(text, needle, findPrevFromRef.current)
      : findNext(text, needle, findNextFromRef.current);
    if (!hit) {
      term.clearSelection();
      return;
    }
    const pos = matchLineColumn(text, hit.index);
    term.scrollToLine(pos.line);
    term.select(pos.column, pos.line, hit.length);
    findNextFromRef.current = hit.index + hit.length;
    findPrevFromRef.current = hit.index;
  }

  function closeFind() {
    setFindOpen(false);
    termRef.current?.focus();
  }

  useEffect(() => {
    restoreMouseRef.current();
  }, [inputMode?.mouse, inputMode?.mouseAny, inputMode?.mouseDrag, inputMode?.mouseSgr]);

  return (
    <>
      <div ref={hostRef} className="xterm-host" />
      {findOpen && (
        <form
          className="pane-find"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            reveal(false);
          }}
        >
          <input
            ref={findRef}
            className="pane-find-input"
            aria-label="Find in pane"
            placeholder="Find"
            onChange={() => {
              findNextFromRef.current = 0;
              findPrevFromRef.current = 0;
              reveal(false);
            }}
            onKeyDown={(event) => {
              if (isFindChord(event)) {
                event.preventDefault();
                event.currentTarget.select();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
                return;
              }
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                reveal(true);
                return;
              }
              event.stopPropagation();
            }}
          />
          <button type="submit">Next</button>
          <button
            type="button"
            onClick={() => reveal(true)}
          >
            Previous
          </button>
          <button type="button" aria-label="Close find" onClick={closeFind}>
            ×
          </button>
        </form>
      )}
    </>
  );
}

function isFindChord(ev: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; key: string }): boolean {
  if (ev.altKey || ev.shiftKey) return false;
  if (ev.key !== "f" && ev.key !== "F") return false;
  if (isMac) return ev.metaKey && !ev.ctrlKey;
  return ev.ctrlKey && !ev.metaKey;
}

function foreignField(ev: KeyboardEvent, host: HTMLElement): boolean {
  const target = ev.target;
  if (!(target instanceof HTMLElement)) return false;
  if (host.contains(target)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function wheelContext(term: Terminal, ev: WheelEvent, input: PaneInputMode): WheelContext {
  const buf = term.buffer.active;
  const cursorLine = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
  const mode = term.modes?.mouseTrackingMode;
  return {
    alt: buf.type === "alternate",
    mouseWheel: mode === "vt200" || mode === "drag" || mode === "any",
    paneAlt: input.alternate,
    mouseReport: input.mouse,
    baseY: buf.baseY,
    rows: term.rows,
    cursorY: buf.cursorY,
    cursorX: buf.cursorX,
    cursorLine,
    deltaY: ev.deltaY,
    deltaMode: ev.deltaMode,
    shiftKey: ev.shiftKey,
    rowHeight: cellHeight(term),
  };
}

function cellFromWheel(term: Terminal, ev: WheelEvent): { col: number; row: number } {
  const host = term.element;
  const size = cellSize(term);
  if (!host || size.width <= 0 || size.height <= 0) return { col: 1, row: 1 };
  const rect = host.getBoundingClientRect();
  const col = Math.floor((ev.clientX - rect.left) / size.width) + 1;
  const row = Math.floor((ev.clientY - rect.top) / size.height) + 1;
  return {
    col: Math.min(term.cols, Math.max(1, col)),
    row: Math.min(term.rows, Math.max(1, row)),
  };
}

function cellHeight(term: Terminal): number {
  return cellSize(term).height;
}

function cellSize(term: Terminal): { width: number; height: number } {
  const core = term as unknown as {
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
    };
  };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  return {
    width: cell && cell.width > 0 ? cell.width : 8,
    height: cell && cell.height > 0 ? cell.height : 16,
  };
}

function openTerminalLink(uri: string) {
  void openHttpUrl(uri).catch((err: unknown) => {
    console.warn("could not open link", err);
  });
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
