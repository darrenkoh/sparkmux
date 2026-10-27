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
  paneArtifacts,
  paneCursor,
  bindPaneOutput,
  paneUnsubscribe,
  paneWrite,
} from "../api";
import { cursorCup } from "./cursorCup";
import { findNext, findPrevious, matchLineColumn } from "./scrollbackSearch";
import { isEmulatorReport } from "./emulatorReports";

import { applyPaneSeed, withExtraHistory } from "./paneSeed";
import {
  commandHasTranscript,
  filterLocalScrollback,
  independentHistoryLines,
} from "./localScrollback";
import {
  SCROLL_COAST_MIN,
  clampScrollTop,
  fingerScrollTop,
  inertialScrollStep,
  phoneScrollFollowsBottom,
  quietTerminalHelper,
  terminalTouchPolicy,
  touchScrollVelocity,
} from "../ios/touchKeyboard";
import type { PaneHistorySource } from "./TiledWindow";
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
  tmuxCols,
  tmuxRows,
  scrollWithoutKeyboard = false,
  historySource,
}: {
  paneId: string;
  focused: boolean;
  onFocus: (paneId: string) => void;
  onCellSize?: (w: number, h: number, cols: number, rows: number) => void;
  fontSize: number;
  inputMode?: PaneInputMode;
  paneCols?: number;
  paneRows?: number;
  tmuxCols?: number;
  tmuxRows?: number;
  /** Phone and iPad: a finger scrolls. The composer owns the keyboard. */
  scrollWithoutKeyboard?: boolean;
  /** Pane identity for the phone's own transcript copy. Omitted on the desktop. */
  historySource?: PaneHistorySource;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const phoneLiveRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onFocusRef = useRef(onFocus);
  const onCellSizeRef = useRef(onCellSize);
  const fontSizeRef = useRef(fontSize);
  const inputModeRef = useRef(inputMode);
  const focusedRef = useRef(focused);
  const paneColsRef = useRef(paneCols);
  const paneRowsRef = useRef(paneRows);
  const scheduleReseedRef = useRef<() => void>(() => {});
  const lastTmuxSizeRef = useRef({ cols: tmuxCols ?? 0, rows: tmuxRows ?? 0 });
  const doFitRef = useRef<() => void>(() => {});
  const redrawCaretRef = useRef<(forceBottom?: boolean) => void>(() => {});
  const syncTmuxCursorRef = useRef<(forceBottom?: boolean) => void>(() => {});
  const scrollCursorIntoViewRef = useRef<(row?: number, col?: number) => void>(() => {});
  const restoreMouseRef = useRef<() => void>(() => {});
  const findOpenRef = useRef(false);
  const findRef = useRef<HTMLInputElement>(null);
  const findNextFromRef = useRef(0);
  const findPrevFromRef = useRef(0);
  const scrollWithoutKeyboardRef = useRef(scrollWithoutKeyboard);
  scrollWithoutKeyboardRef.current = scrollWithoutKeyboard;
  const historySourceRef = useRef(historySource);
  historySourceRef.current = historySource;
  const [findOpen, setFindOpen] = useState(false);
  findOpenRef.current = findOpen;

  useEffect(() => {
    const onFind = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string }>).detail;
      if (detail?.paneId && detail.paneId !== paneId) return;
      setFindOpen(true);
    };
    window.addEventListener("sparkmux-find", onFind);
    return () => window.removeEventListener("sparkmux-find", onFind);
  }, [paneId]);
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
      // Phone and iPad type through the composer. The helper must not take keys.
      disableStdin: scrollWithoutKeyboardRef.current,
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
    if (term.textarea) quietTerminalHelper(term.textarea, scrollWithoutKeyboardRef.current);

    const dismissSoftwareKeyboard = () => {
      const helper = term.textarea;
      if (helper) quietTerminalHelper(helper, true);
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA")
      ) {
        active.blur();
      }
      helper?.blur();
    };

    let unmounted = false;
    let applyingSeed = false;
    let userPanned = false;
    let filterRest: Uint8Array<ArrayBufferLike> = new Uint8Array();

    const showCaret = (target: Terminal, forceBottom: boolean) => {
      const buf = target.buffer.active;
      const pinned = userPanned && scrollWithoutKeyboardRef.current;
      if (!target.hasSelection() && !pinned && (forceBottom || viewportAtBottom(buf.viewportY, buf.baseY))) {
        target.scrollToBottom();
        const screen = target.element?.querySelector(".xterm-screen");
        if (screen instanceof HTMLElement) screen.style.transform = "";
      }
      target.refresh(0, Math.max(0, target.rows - 1));
    };

    const redrawCaret = (forceBottom = false) => {
      if (applyingSeed) return;
      showCaret(term, forceBottom);
    };

    const scrollCursorIntoView = (row?: number, col?: number) => {
      const host = hostRef.current;
      const live = termRef.current;
      if (!host || !live) return;
      const buf = live.buffer.active;
      const r = row ?? buf.cursorY;
      const c = col ?? buf.cursorX;
      const { width: cellW, height: cellH } = cellSize(live);
      if (cellH <= 0) return;
      const targetTop = r * cellH;
      const maxRow = Math.min(live.rows, r + 2);
      const targetBottom = maxRow * cellH;
      const viewH = host.clientHeight;
      if (viewH > 0) {
        if (targetTop < host.scrollTop) {
          host.scrollTop = targetTop;
        } else if (targetBottom > host.scrollTop + viewH) {
          host.scrollTop = Math.max(0, targetBottom - viewH + 4);
        }
      }
      if (cellW > 0) {
        const targetLeft = c * cellW;
        const viewW = host.clientWidth;
        if (viewW > 0) {
          if (targetLeft < host.scrollLeft) {
            host.scrollLeft = targetLeft;
          } else if (targetLeft + cellW * 3 > host.scrollLeft + viewW) {
            host.scrollLeft = Math.max(0, targetLeft + cellW * 3 - viewW + 8);
          }
        }
      }
    };
    scrollCursorIntoViewRef.current = scrollCursorIntoView;

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

    const cursorDisp = term.onCursorMove(() => {
      if (applyingSeed) return;
      const buf = term.buffer.active;
      if (!term.hasSelection() && viewportAtBottom(buf.viewportY, buf.baseY)) {
        scrollCursorIntoView(buf.cursorY, buf.cursorX);
      }
    });

    let syncPhoneHistory = () => {};
    // True until the finger leaves the live screen. Output must not jump a reader.
    let phoneStick = true;
    let phoneAdjusting = false;

    const renderDisp = term.onRender(() => {
      if (applyingSeed) return;
      if (scrollWithoutKeyboardRef.current) {
        syncPhoneHistory();
        return;
      }
      const buf = term.buffer.active;
      if (!term.hasSelection() && viewportAtBottom(buf.viewportY, buf.baseY)) {
        scrollCursorIntoView(buf.cursorY, buf.cursorX);
      }
    });

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

    const writeLive = (bytes: Uint8Array<ArrayBufferLike>) => {
      let payload: Uint8Array<ArrayBufferLike> = bytes;
      if (scrollWithoutKeyboardRef.current) {
        const merged = new Uint8Array(filterRest.length + bytes.length);
        merged.set(filterRest, 0);
        merged.set(bytes, filterRest.length);
        const filtered = filterLocalScrollback(merged);
        filterRest = filtered.rest;
        payload = filtered.out;
      }
      const after = () => {
        if (unmounted || applyingSeed) return;
        // The phone page scrolls its own transcript. xterm stays on the live
        // screen, so its viewport being at the bottom must not yank that page.
        if (scrollWithoutKeyboardRef.current) {
          syncPhoneHistory();
          return;
        }
        const buf = term.buffer.active;
        if (!term.hasSelection() && viewportAtBottom(buf.viewportY, buf.baseY)) {
          userPanned = false;
          scrollCursorIntoView(buf.cursorY, buf.cursorX);
        }
      };
      if (payload.length === 0) {
        after();
        return;
      }
      term.write(payload, after);
    };

    let paintGen = 0;
    let cachedHistory: string[] | null = null;
    let historyPending = false;
    let latestSeed: Uint8Array | null = null;
    const paintNow = (payload: Uint8Array) => {
      const gen = ++paintGen;
      applyPaneSeed(
        term,
        payload,
        () => {
          if (gen !== paintGen) return;
          applyingSeed = false;
          host.style.visibility = "";
          seedApplied = true;
          if (unmounted) return;
          doFitRef.current();
          if (!(userPanned && scrollWithoutKeyboardRef.current)) {
            term.scrollToBottom();
            const screen = term.element?.querySelector(".xterm-screen");
            if (screen instanceof HTMLElement) screen.style.transform = "";
            syncTmuxCursor(true);
          }
          restoreMouse();
          historyRef.current?.replaceChildren();
          syncPhoneHistory();
          if (focusedRef.current && terminalTouchPolicy(scrollWithoutKeyboardRef.current).focusHelper) {
            term.focus();
          }
          requestAnimationFrame(() => {
            if (!unmounted && termRef.current) {
              const buf = termRef.current.buffer.active;
              scrollCursorIntoView(buf.cursorY, buf.cursorX);
            }
          });
        },
        () => {
          applyingSeed = true;
          host.style.visibility = "hidden";
        },
      );
    };
    const paintSeed = (bytes: Uint8Array) => {
      seedState.seeded = true;
      latestSeed = bytes;
      const source = historySourceRef.current;
      const wantTranscript =
        scrollWithoutKeyboardRef.current &&
        source !== undefined &&
        commandHasTranscript(source.command);
      const extra = cachedHistory && cachedHistory.length > 0 ? cachedHistory : [];
      paintNow(extra.length > 0 ? withExtraHistory(bytes, extra) : bytes);
      if (!wantTranscript || !source || cachedHistory || historyPending) return;
      historyPending = true;
      void paneArtifacts(source.command, source.cwd, source.title, source.pid)
        .then((feed) => {
          historyPending = false;
          const lines = independentHistoryLines(feed.entries);
          cachedHistory = lines;
          if (lines.length === 0 || userPanned || unmounted || !latestSeed) return;
          paintNow(withExtraHistory(latestSeed, lines));
        })
        .catch(() => {
          historyPending = false;
          cachedHistory = [];
        });
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
      if (inputFollowsPrompt(data) && !term.hasSelection()) {
        term.scrollToBottom();
        requestAnimationFrame(() => {
          if (!unmounted && termRef.current) {
            const buf = termRef.current.buffer.active;
            scrollCursorIntoView(buf.cursorY, buf.cursorX);
          }
        });
      }
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

    let touchScrollX = 0;
    let touchScrollY = 0;
    let touchAccumPx = 0;
    let touchMulti = false;
    syncPhoneHistory = () => {
      if (applyingSeed || unmounted || !scrollWithoutKeyboardRef.current) return;
      const scroller = scrollRef.current;
      const list = historyRef.current;
      const live = phoneLiveRef.current;
      if (!scroller || !list || !live) return;
      const buf = term.buffer.active;
      const count = buf.baseY;
      const rowH = Math.max(1, cellHeight(term));
      // Readable size. Lines stay one row wide and the page scrolls sideways.
      const fontPx = Math.max(16, fontSizeRef.current);
      scroller.style.setProperty("--phone-font-size", `${fontPx}px`);
      const before = list.childElementCount;
      const heightBefore = scroller.scrollHeight;
      if (count < before) list.replaceChildren();
      for (let i = list.childElementCount; i < count; i += 1) {
        const row = document.createElement("div");
        row.className = "phone-history-line";
        row.textContent = buf.getLine(i)?.translateToString(true) ?? "";
        list.appendChild(row);
      }
      const lineAt = (index: number) => buf.getLine(index)?.translateToString(true) ?? "";
      const visible = Math.max(0, Math.min(term.rows, buf.length - count));
      let last = visible - 1;
      while (last > 0 && lineAt(count + last) === "") last -= 1;
      const shown = last + 1;
      if (live.childElementCount !== shown) {
        live.replaceChildren();
        for (let r = 0; r < shown; r += 1) {
          const row = document.createElement("div");
          row.className = "phone-history-line";
          live.appendChild(row);
        }
      }
      for (let r = 0; r < shown; r += 1) {
        const text = lineAt(count + r);
        const node = live.children[r];
        if (node && node.textContent !== text) node.textContent = text;
      }
      const grew = list.childElementCount !== before || scroller.scrollHeight > heightBefore + 1;
      if (!phoneStick) {
        userPanned = scroller.scrollHeight > scroller.clientHeight + rowH;
        return;
      }
      userPanned = false;
      // Pin only when the transcript grows or the page has never left the top.
      // Writing scrollTop on every frame fights the finger.
      if (!grew && scroller.scrollTop !== 0) return;
      phoneAdjusting = true;
      scroller.scrollTop = scroller.scrollHeight;
      phoneAdjusting = false;
    };
    const onPhoneScroll = () => {
      if (phoneAdjusting || !scrollWithoutKeyboardRef.current) return;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const follows = phoneScrollFollowsBottom(
        scroller.scrollTop,
        scroller.clientHeight,
        scroller.scrollHeight,
      );
      phoneStick = follows;
      const rowH = Math.max(1, cellHeight(term));
      userPanned = !follows && scroller.scrollHeight > scroller.clientHeight + rowH;
    };
    scrollRef.current?.addEventListener("scroll", onPhoneScroll, { passive: true });
    const onTouchStart = (ev: TouchEvent) => {
      // Phone drags are handled on the transcript scroller. This host listener
      // must not take the touch: xterm would snap it to a row.
      const policy = terminalTouchPolicy(scrollWithoutKeyboardRef.current);
      if (policy.dismissKeyboard) return;
      if (ev.touches.length !== 1) {
        touchMulti = true;
        return;
      }
      touchMulti = false;
      touchScrollX = ev.touches[0].clientX;
      touchScrollY = ev.touches[0].clientY;
      touchAccumPx = 0;
      onFocusRef.current(paneId);
      void focusPane(paneId);
      if (policy.focusHelper) {
        term.focus();
      }
      if (policy.revealCursor) {
        requestAnimationFrame(() => {
          if (!unmounted && termRef.current) {
            const buf = termRef.current.buffer.active;
            scrollCursorIntoView(buf.cursorY, buf.cursorX);
          }
        });
      }
    };
    const onTouchEnd = () => {
      if (!terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;
      dismissSoftwareKeyboard();
    };
    const onTouchMove = (ev: TouchEvent) => {
      if (touchMulti || ev.touches.length !== 1) return;
      const curX = ev.touches[0].clientX;
      const curY = ev.touches[0].clientY;
      const deltaX = curX - touchScrollX;
      const deltaY = curY - touchScrollY;
      const previousY = touchScrollY;
      touchScrollX = curX;
      touchScrollY = curY;

      if (terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;

      const host = hostRef.current;
      const canScrollHostY = host && host.scrollHeight > host.clientHeight;
      const canScrollHostX = host && host.scrollWidth > host.clientWidth;

      if (canScrollHostY || canScrollHostX) {
        let consumed = false;
        if (canScrollHostY) {
          const prevTop = host.scrollTop;
          host.scrollTop -= deltaY;
          if (host.scrollTop !== prevTop) consumed = true;
        }
        if (canScrollHostX) {
          const prevLeft = host.scrollLeft;
          host.scrollLeft -= deltaX;
          if (host.scrollLeft !== prevLeft) consumed = true;
        }
        if (consumed) {
          ev.preventDefault();
          return;
        }
      }

      const rowH = Math.max(12, cellHeight(term));
      touchAccumPx += touchDragDelta(previousY, curY);
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
    const onHelperFocus = (ev: FocusEvent) => {
      if (!terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;
      const node = ev.target;
      if (!(node instanceof HTMLTextAreaElement) || !node.classList.contains("xterm-helper-textarea")) {
        return;
      }
      // xterm focuses this on mousedown, which iOS turns into the software keyboard.
      quietTerminalHelper(node, true);
      node.blur();
    };
    const onMouseDownCapture = (ev: MouseEvent) => {
      if (!terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;
      // xterm focuses its helper from the bubble mousedown. Stop that here,
      // or iOS opens the keyboard on a scroll.
      ev.preventDefault();
      ev.stopPropagation();
    };
    // One pixel of finger travel moves one pixel of the transcript. The live
    // screen is in that same scroller, so the page follows the finger.
    let phoneDrag: {
      startX: number;
      startY: number;
      startLeft: number;
      startTop: number;
      samples: { x: number; y: number; t: number }[];
    } | null = null;
    let coastRaf = 0;
    const stopCoast = () => {
      if (coastRaf) cancelAnimationFrame(coastRaf);
      coastRaf = 0;
    };
    const onPhoneTouchStart = (ev: TouchEvent) => {
      if (!terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;
      if (ev.touches.length !== 1) {
        phoneDrag = null;
        return;
      }
      stopCoast();
      const scroller = scrollRef.current;
      if (!scroller) return;
      const now = performance.now();
      phoneDrag = {
        startX: ev.touches[0].clientX,
        startY: ev.touches[0].clientY,
        startLeft: scroller.scrollLeft,
        startTop: scroller.scrollTop,
        samples: [{ x: ev.touches[0].clientX, y: ev.touches[0].clientY, t: now }],
      };
    };
    const onPhoneTouchMove = (ev: TouchEvent) => {
      if (!terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;
      if (!phoneDrag || ev.touches.length !== 1) return;
      const scroller = scrollRef.current;
      if (!scroller) return;
      const x = ev.touches[0].clientX;
      const y = ev.touches[0].clientY;
      phoneDrag.samples.push({ x, y, t: performance.now() });
      if (phoneDrag.samples.length > 8) phoneDrag.samples.shift();
      const maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      scroller.scrollTop = fingerScrollTop(phoneDrag.startTop, phoneDrag.startY, y, maxY);
      scroller.scrollLeft = fingerScrollTop(phoneDrag.startLeft, phoneDrag.startX, x, maxX);
      ev.preventDefault();
      ev.stopPropagation();
    };
    const onPhoneTouchEnd = () => {
      if (!terminalTouchPolicy(scrollWithoutKeyboardRef.current).dismissKeyboard) return;
      const drag = phoneDrag;
      phoneDrag = null;
      if (!drag) return;
      let velocityY = touchScrollVelocity(drag.samples);
      let velocityX = touchScrollVelocity(drag.samples.map((sample) => ({ y: sample.x, t: sample.t })));
      if (Math.abs(velocityY) < SCROLL_COAST_MIN) velocityY = 0;
      if (Math.abs(velocityX) < SCROLL_COAST_MIN) velocityX = 0;
      if (velocityY === 0 && velocityX === 0) return;
      let last = performance.now();
      const step = (now: number) => {
        coastRaf = 0;
        if (phoneDrag || unmounted) return;
        const scroller = scrollRef.current;
        if (!scroller) return;
        const dt = now - last;
        last = now;
        const nextY = inertialScrollStep(velocityY, dt);
        const nextX = inertialScrollStep(velocityX, dt);
        velocityY = nextY.velocity;
        velocityX = nextX.velocity;
        let moved = false;
        if (nextY.deltaPx !== 0 && velocityY !== 0) {
          const maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const top = clampScrollTop(scroller.scrollTop + nextY.deltaPx, maxY);
          if (top !== scroller.scrollTop) {
            scroller.scrollTop = top;
            moved = true;
          }
        }
        if (nextX.deltaPx !== 0 && velocityX !== 0) {
          const maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          const left = clampScrollTop(scroller.scrollLeft + nextX.deltaPx, maxX);
          if (left !== scroller.scrollLeft) {
            scroller.scrollLeft = left;
            moved = true;
          }
        }
        if (!moved) return;
        coastRaf = requestAnimationFrame(step);
      };
      coastRaf = requestAnimationFrame(step);
    };
    const scrollerEl = scrollRef.current;
    scrollerEl?.addEventListener("touchstart", onPhoneTouchStart, { capture: true, passive: false });
    scrollerEl?.addEventListener("touchmove", onPhoneTouchMove, { capture: true, passive: false });
    scrollerEl?.addEventListener("touchend", onPhoneTouchEnd);
    scrollerEl?.addEventListener("touchcancel", onPhoneTouchEnd);
    host.addEventListener("mousedown", onMouseDownCapture, true);
    host.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
    host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);
    host.addEventListener("focusin", onHelperFocus, true);

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
      if (terminalTouchPolicy(scrollWithoutKeyboardRef.current).focusHelper) {
        term.focus();
      }
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

    const scheduleReseed = () => {
      if (!subscribed || unmounted) return;
      if (userPanned && scrollWithoutKeyboardRef.current) return;
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
          write: writeLive,
        });
      }, 150);
    };
    scheduleReseedRef.current = scheduleReseed;

    const doFit = () => {
      if (applyingSeed || unmounted) return;
      let logicalRows = 0;
      try {
        if (paneColsRef.current && paneRowsRef.current) {
          term.resize(paneColsRef.current, paneRowsRef.current);
        } else {
          if (host.clientWidth < 2 || host.clientHeight < 2) return;
          fit.fit();
        }
        logicalRows = term.rows;
        reportCell(term, onCellSizeRef.current, logicalRows);
      } catch {
        return;
      }
      redrawCaret();
      if (term.cols === lastCols && term.rows === lastRows) return;
      const hadGrid = lastCols > 0 && lastRows > 0;
      lastCols = term.cols;
      lastRows = term.rows;
      if (hadGrid) {
        scheduleReseed();
      }
      if (subscribed) return;
      subscribed = true;
      seedTimer = window.setTimeout(() => {
        if (unmounted) return;
        void bindPaneOutput(paneId, seedState, {
          seed: paintSeed,
          write: writeLive,
        });
      }, 0);
    };

    doFitRef.current = doFit;
    requestAnimationFrame(doFit);
    const later = window.setTimeout(doFit, 50);

    const ro = new ResizeObserver(() => {
      if (scrollWithoutKeyboardRef.current) syncPhoneHistory();
      doFit();
      if (!unmounted && termRef.current) {
        const buf = termRef.current.buffer.active;
        if (!termRef.current.hasSelection() && viewportAtBottom(buf.viewportY, buf.baseY)) {
          scrollCursorIntoView(buf.cursorY, buf.cursorX);
        }
      }
    });
    ro.observe(host);
    if (scrollRef.current) ro.observe(scrollRef.current);

    return () => {
      unmounted = true;
      stopCoast();
      scrollRef.current?.removeEventListener("scroll", onPhoneScroll);
      scrollRef.current?.removeEventListener("touchstart", onPhoneTouchStart, true);
      scrollRef.current?.removeEventListener("touchmove", onPhoneTouchMove, true);
      scrollRef.current?.removeEventListener("touchend", onPhoneTouchEnd);
      scrollRef.current?.removeEventListener("touchcancel", onPhoneTouchEnd);
      doFitRef.current = () => {};
      scheduleReseedRef.current = () => {};
      redrawCaretRef.current = () => {};
      syncTmuxCursorRef.current = () => {};
      scrollCursorIntoViewRef.current = () => {};
      restoreMouseRef.current = () => {};
      if (seedTimer) window.clearTimeout(seedTimer);
      if (cursorTimer) window.clearTimeout(cursorTimer);
      if (reseedTimer) window.clearTimeout(reseedTimer);
      window.clearTimeout(later);
      host.removeEventListener("mousedown", onMouseDownCapture, true);
      host.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("touchstart", onTouchStart, true);
      host.removeEventListener("touchmove", onTouchMove, true);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      host.removeEventListener("focusin", onHelperFocus, true);
      ro.disconnect();
      cursorDisp.dispose();
      renderDisp.dispose();
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
    requestAnimationFrame(() => {
      if (termRef.current) {
        const buf = termRef.current.buffer.active;
        scrollCursorIntoViewRef.current(buf.cursorY, buf.cursorX);
      }
    });
  }, [paneCols, paneRows]);

  useEffect(() => {
    if (!tmuxCols || !tmuxRows) return;
    const prev = lastTmuxSizeRef.current;
    lastTmuxSizeRef.current = { cols: tmuxCols, rows: tmuxRows };
    if (prev.cols > 0 && prev.rows > 0 && (prev.cols !== tmuxCols || prev.rows !== tmuxRows)) {
      scheduleReseedRef.current();
    }
  }, [tmuxCols, tmuxRows]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    doFitRef.current();
    requestAnimationFrame(() => {
      const buf = term.buffer.active;
      scrollCursorIntoViewRef.current(buf.cursorY, buf.cursorX);
    });
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
      const term = termRef.current;
      const policy = terminalTouchPolicy(scrollWithoutKeyboardRef.current);
      if (policy.focusHelper) {
        term?.focus();
      } else if (term?.textarea) {
        quietTerminalHelper(term.textarea, true);
        term.textarea.blur();
      }
      if (!policy.revealCursor) return;
      redrawCaretRef.current(true);
      syncTmuxCursorRef.current(true);
      requestAnimationFrame(() => {
        if (termRef.current) {
          const buf = termRef.current.buffer.active;
          scrollCursorIntoViewRef.current(buf.cursorY, buf.cursorX);
        }
      });
    }
  }, [focused, findOpen]);

  useEffect(() => {
    const term = termRef.current;
    const area = term?.textarea;
    if (!term || !area) return;
    quietTerminalHelper(area, scrollWithoutKeyboard);
    term.options.disableStdin = scrollWithoutKeyboard;
    if (scrollWithoutKeyboard) area.blur();
  }, [scrollWithoutKeyboard]);

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
    if (terminalTouchPolicy(scrollWithoutKeyboardRef.current).focusHelper) {
      termRef.current?.focus();
    }
  }

  useEffect(() => {
    restoreMouseRef.current();
  }, [inputMode?.mouse, inputMode?.mouseAny, inputMode?.mouseDrag, inputMode?.mouseSgr]);

  return (
    <>
      <div
        ref={scrollRef}
        className={scrollWithoutKeyboard ? "phone-scroll" : "xterm-slot"}
      >
        {scrollWithoutKeyboard ? (
          <>
            <div className="phone-transcript">
              <div ref={historyRef} className="phone-history" />
              <div ref={phoneLiveRef} className="phone-live" />
            </div>
            <div ref={hostRef} className="xterm-host phone-xterm-source" aria-hidden="true" />
          </>
        ) : (
          <div ref={hostRef} className="xterm-host" />
        )}
      </div>
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
  rows = term.rows,
) {
  if (!onCellSize) return;
  const core = term as unknown as {
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
    };
  };
  const cell = core._core?._renderService?.dimensions?.css?.cell;
  if (cell && cell.width > 0 && cell.height > 0) {
    onCellSize(cell.width, cell.height, term.cols, rows);
  }
}
