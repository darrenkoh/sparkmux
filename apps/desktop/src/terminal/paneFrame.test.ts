import assert from "node:assert/strict";
import { test } from "node:test";

import { bindPaneOutput } from "../api.ts";
import { isTauriRuntime, wsTransport } from "../transport.ts";
import { FRAME_OUTPUT, FRAME_SEED } from "./paneFrame.ts";
import { applyPaneSeed } from "./paneSeed.ts";

function encode(kind: number, paneId: string, text: string): Uint8Array {
  const id = new TextEncoder().encode(paneId);
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(2 + id.length + payload.length);
  frame[0] = kind;
  frame[1] = id.length;
  frame.set(id, 2);
  frame.set(payload, 2 + id.length);
  return frame;
}

test("the WebSocket frame router reseeds on a second 0x01 instead of appending it", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    assert.equal("__TAURI_INTERNALS__" in window, false);
    assert.equal(isTauriRuntime(), false);

    const resets: number[] = [];
    const live: string[] = [];
    const term = {
      cols: 80,
      rows: 24,
      options: { windowsMode: false },
      reset() {
        resets.push(resets.length + 1);
      },
      resize() {},
      write(data: string, done?: () => void) {
        live.push(data);
        done?.();
      },
    };
    const pending = bindPaneOutput(
      "%0",
      { seeded: false },
      {
        seed: (bytes) => applyPaneSeed(term as never, bytes, () => {}),
        write: (bytes) => live.push(`LIVE:${new TextDecoder().decode(bytes)}`),
      },
    );
    pending.catch(() => {});

    const firstSeed = "\x1ehistory:1\nfirst-line\nvisible-a";
    const secondSeed = "\x1ehistory:1\nreplaced-line\nvisible-b";
    wsTransport.ingestBinaryFrame(encode(FRAME_SEED, "%0", firstSeed));
    wsTransport.ingestBinaryFrame(encode(FRAME_OUTPUT, "%0", "typed-after-seed"));
    wsTransport.ingestBinaryFrame(encode(FRAME_SEED, "%0", secondSeed));

    assert.equal(resets.length, 2);
    assert.deepEqual(
      live.filter((row) => row.startsWith("LIVE:")),
      ["LIVE:typed-after-seed"],
    );
    assert.equal(
      live.some((row) => row.includes("replaced-line") && row.startsWith("LIVE:")),
      false,
    );
    assert.ok(live.some((row) => row.includes("visible-b")));
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});
