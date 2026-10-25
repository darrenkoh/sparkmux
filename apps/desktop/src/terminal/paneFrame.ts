/** Binary pane frames from `sparkmux serve`. `0x01` is a full seed, `0x02` is live output. */

export const FRAME_SEED = 0x01;
export const FRAME_OUTPUT = 0x02;

export interface PaneServerFrame {
  kind: number;
  payload: Uint8Array;
}

export interface DecodedPaneFrame extends PaneServerFrame {
  paneId: string;
}

export interface PaneFrameSink {
  seed: (payload: Uint8Array) => void;
  write: (payload: Uint8Array) => void;
}

export function isPaneServerFrame(msg: unknown): msg is PaneServerFrame {
  if (typeof msg !== "object" || msg === null) return false;
  const frame = msg as { kind?: unknown; payload?: unknown };
  return (
    (frame.kind === FRAME_SEED || frame.kind === FRAME_OUTPUT) &&
    frame.payload instanceof Uint8Array
  );
}

/** Split a server binary frame. Returns null when the header is truncated. */
export function decodePaneFrame(buf: Uint8Array): DecodedPaneFrame | null {
  if (buf.length < 2) return null;
  const kind = buf[0];
  if (kind !== FRAME_SEED && kind !== FRAME_OUTPUT) return null;
  const idLen = buf[1];
  if (idLen === 0 || buf.length < 2 + idLen) return null;
  const paneId = new TextDecoder().decode(buf.subarray(2, 2 + idLen));
  const payload = buf.subarray(2 + idLen);
  return { kind, paneId, payload };
}

/**
 * A seed replaces the terminal. A later `0x01` (reconnect / visibility reseed)
 * is still a seed, not bytes to append after the live screen.
 */
export function routePaneFrame(frame: PaneServerFrame, sink: PaneFrameSink): void {
  if (frame.kind === FRAME_SEED) {
    sink.seed(frame.payload);
    return;
  }
  if (frame.kind === FRAME_OUTPUT) sink.write(frame.payload);
}

/** Entry used by the WebSocket transport for every server binary frame. */
export function dispatchBinaryFrame(
  buf: Uint8Array,
  deliver: (paneId: string, frame: PaneServerFrame) => void,
): void {
  const decoded = decodePaneFrame(buf);
  if (!decoded) return;
  deliver(decoded.paneId, { kind: decoded.kind, payload: decoded.payload });
}

/**
 * What the terminal does with one subscription message.
 * A web `0x01` always reseeds, including the frame after a reconnect.
 * Raw Tauri bytes still treat only the first payload as the seed.
 */
export function acceptPaneSubscriptionMessage(
  msg: unknown,
  state: { seeded: boolean },
  sink: PaneFrameSink,
): void {
  if (isPaneServerFrame(msg)) {
    routePaneFrame(msg, {
      seed: (bytes) => {
        state.seeded = true;
        sink.seed(bytes);
      },
      write: sink.write,
    });
    return;
  }
  if (msg instanceof ArrayBuffer || msg instanceof Uint8Array || Array.isArray(msg)) {
    const bytes =
      msg instanceof Uint8Array
        ? msg
        : msg instanceof ArrayBuffer
          ? new Uint8Array(msg)
          : Uint8Array.from(msg);
    if (!state.seeded) {
      state.seeded = true;
      sink.seed(bytes);
      return;
    }
    sink.write(bytes);
  }
}
