import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

import { dispatchBinaryFrame, type PaneServerFrame } from "./terminal/paneFrame.ts";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export const WS_TOKEN_KEY = "sparkmux.wsToken";

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "unauthorized";

export interface ConnectionHealth {
  state: ConnectionState;
  rttMs: number | null;
}

export interface TokenBag {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Prefer `localStorage`, then `sessionStorage`. */
export function loadWsToken(local: TokenBag | null, session: TokenBag | null): string {
  try {
    const saved = local?.getItem(WS_TOKEN_KEY);
    if (saved) return saved;
  } catch {
    /* private mode */
  }
  try {
    return session?.getItem(WS_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistWsToken(token: string, local: TokenBag | null, session: TokenBag | null): void {
  try {
    local?.setItem(WS_TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
  try {
    session?.setItem(WS_TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
}

/** A ping round-trip. The socket publishes this sample while it is connected. */
export function connectionHealthFromPing(sentAt: number, receivedAt: number): ConnectionHealth {
  const rttMs = Math.max(0, Math.round(receivedAt - sentAt));
  return { state: "connected", rttMs };
}

/**
 * Visible `visibilitychange`, `pageshow`, and `online` re-seed immediately.
 * A hidden visibility change does not.
 */
export function shouldImmediateReseed(event: { type: string; visibilityState?: string }): boolean {
  if (event.type === "visibilitychange") return event.visibilityState === "visible";
  return event.type === "pageshow" || event.type === "online";
}

let currentHealth: ConnectionHealth = { state: "connecting", rttMs: null };
const healthListeners = new Set<(health: ConnectionHealth) => void>();

export function getConnectionHealth(): ConnectionHealth {
  return currentHealth;
}

export function publishConnectionHealth(next: ConnectionHealth): void {
  currentHealth = next;
  for (const fn of healthListeners) fn(next);
}

export function subscribeConnectionHealth(listener: (health: ConnectionHealth) => void): () => void {
  healthListeners.add(listener);
  listener(currentHealth);
  return () => {
    healthListeners.delete(listener);
  };
}

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type PaneCallback = (frame: PaneServerFrame) => void;

class WebSocketTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private eventListeners = new Map<string, Set<(payload: unknown) => void>>();
  private paneSubscribers = new Map<string, PaneCallback>();
  private connectPromise: Promise<WebSocket> | null = null;
  private reconnectTimer: number | undefined;
  private pingTimer: number | undefined;
  private lastSession: { session: string; cols: number; rows: number } | null = null;
  private broadcastChannel: BroadcastChannel | null = null;

  constructor() {
    if (typeof window !== "undefined" && !isTauriRuntime()) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("token")) {
        const token = url.searchParams.get("token") ?? "";
        persistWsToken(token, window.localStorage, window.sessionStorage);
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.toString());
      }
      if ("BroadcastChannel" in window) {
        this.broadcastChannel = new BroadcastChannel("sparkmux.events");
        this.broadcastChannel.onmessage = (ev: MessageEvent<{ event?: string; payload?: unknown }>) => {
          if (ev.data?.event) this.dispatchEvent(ev.data.event, ev.data.payload);
        };
      }
      const onWake = (event: Event) => {
        if (!shouldImmediateReseed({ type: event.type, visibilityState: document.visibilityState })) {
          return;
        }
        if (this.reconnectTimer) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        void this.ensureConnected(true);
      };
      document.addEventListener("visibilitychange", onWake);
      window.addEventListener("pageshow", onWake);
      window.addEventListener("online", onWake);
    }
  }

  private getWsUrl(): string {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const token = loadWsToken(window.localStorage, window.sessionStorage);
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${proto}//${window.location.host}/ws${qs}`;
  }

  private noteHealth(next: ConnectionHealth) {
    publishConnectionHealth(next);
  }

  private startPing() {
    if (this.pingTimer !== undefined || typeof window === "undefined") return;
    this.pingTimer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const sentAt = performance.now();
      void this.invoke<{ pong?: boolean }>("ping", { t: sentAt })
        .then(() => {
          this.noteHealth(connectionHealthFromPing(sentAt, performance.now()));
        })
        .catch(() => {});
    }, 10_000);
  }

  public ensureConnected(forceReseed = false): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (forceReseed) void this.reseedAfterResume();
      return Promise.resolve(this.ws);
    }
    if (this.connectPromise) return this.connectPromise;

    const prior = getConnectionHealth().state;
    this.noteHealth({
      state: prior === "connected" || prior === "reconnecting" ? "reconnecting" : "connecting",
      rttMs: getConnectionHealth().rttMs,
    });
    this.connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.getWsUrl());
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        this.ws = ws;
        this.connectPromise = null;
        this.noteHealth({ state: "connected", rttMs: getConnectionHealth().rttMs });
        this.startPing();
        void this.reseedAfterResume();
        resolve(ws);
      };
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.ingestBinaryFrame(new Uint8Array(ev.data));
          return;
        }
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as {
              id?: number;
              ok?: boolean;
              data?: unknown;
              error?: string;
              event?: string;
              payload?: unknown;
            };
            if (typeof msg.id === "number") {
              const req = this.pending.get(msg.id);
              if (req) {
                this.pending.delete(msg.id);
                if (msg.ok) req.resolve(msg.data);
                else req.reject(new Error(msg.error ?? "RPC error"));
              }
            } else if (typeof msg.event === "string") {
              this.dispatchEvent(msg.event, msg.payload);
            }
          } catch {
            /* malformed JSON */
          }
        }
      };
      ws.onclose = () => {
        this.ws = null;
        this.connectPromise = null;
        this.noteHealth({ state: "reconnecting", rttMs: getConnectionHealth().rttMs });
        for (const [, req] of this.pending) req.reject(new Error("WebSocket disconnected"));
        this.pending.clear();
        if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = window.setTimeout(() => {
          void this.ensureConnected(true).catch(() => {});
        }, 600);
      };
      ws.onerror = () => {
        if (this.connectPromise) {
          this.connectPromise = null;
          reject(new Error("WebSocket connection failed"));
        }
      };
    });
    return this.connectPromise;
  }

  private async reseedAfterResume() {
    if (this.lastSession) {
      try {
        await this.invoke("control_connect", this.lastSession);
      } catch {
        /* reconnect race */
      }
    }
    for (const [paneId] of this.paneSubscribers) {
      try {
        await this.invoke("pane_subscribe", { paneId });
      } catch {
        /* ignore */
      }
    }
    this.dispatchEvent("tree-dirty", null);
  }

  /** Same function the socket calls for every binary server frame. */
  ingestBinaryFrame(buf: Uint8Array): void {
    dispatchBinaryFrame(buf, (paneId, frame) => {
      const deliver = this.paneSubscribers.get(paneId);
      if (typeof deliver === "function") deliver(frame);
    });
  }

  /** Register a pane callback without opening the socket. `subscribePane` uses this too. */
  attachPaneHandler(paneId: string, onData: PaneCallback): void {
    this.paneSubscribers.set(paneId, onData);
  }

  private dispatchEvent(event: string, payload: unknown) {
    const set = this.eventListeners.get(event);
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  public async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    if (cmd === "control_connect") {
      this.lastSession = {
        session: String(args.session ?? ""),
        cols: Number(args.cols ?? 80),
        rows: Number(args.rows ?? 24),
      };
    }
    if (cmd === "sync_active_target" && args.target) {
      this.broadcastChannel?.postMessage({
        event: "active-target-changed",
        payload: args.target,
      });
    }
    const ws = await this.ensureConnected();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      ws.send(JSON.stringify({ id, cmd, args }));
    });
  }

  public async sendPaneWriteBinary(paneId: string, data: number[] | Uint8Array): Promise<void> {
    const ws = await this.ensureConnected();
    const idBytes = new TextEncoder().encode(paneId);
    const payload = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const frame = new Uint8Array(2 + idBytes.length + payload.length);
    frame[0] = 0x03;
    frame[1] = idBytes.length;
    frame.set(idBytes, 2);
    frame.set(payload, 2 + idBytes.length);
    ws.send(frame);
  }

  public async subscribePane(paneId: string, onData: PaneCallback): Promise<void> {
    this.attachPaneHandler(paneId, onData);
    await this.invoke("pane_subscribe", { paneId });
  }

  public async unsubscribePane(paneId: string): Promise<void> {
    this.paneSubscribers.delete(paneId);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      await this.invoke("pane_unsubscribe", { paneId }).catch(() => {});
    }
  }

  public listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    const wrapped = (payload: unknown) => handler(payload as T);
    set.add(wrapped);
    void this.ensureConnected().catch(() => {});
    return Promise.resolve(() => {
      set?.delete(wrapped);
    });
  }
}

export const wsTransport = new WebSocketTransport();

export { WebSocketTransport };

export function rpcInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) return tauriInvoke<T>(cmd, args);
  return wsTransport.invoke<T>(cmd, args);
}

export function rpcListen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (isTauriRuntime()) return tauriListen<T>(event, (eventPayload) => handler(eventPayload.payload));
  return wsTransport.listen<T>(event, handler);
}
