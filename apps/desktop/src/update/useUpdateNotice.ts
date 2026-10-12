import { useCallback, useEffect, useRef, useState } from "react";

import { checkForUpdate, type AvailableUpdate } from "./checkForUpdate";
import { availablePhase, errorText, type UpdatePhase } from "./noticeModel";

export function useUpdateNotice() {
  const [phase, setPhase] = useState<UpdatePhase>({ status: "hidden" });
  const pending = useRef<AvailableUpdate | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    void checkForUpdate().then((found) => {
      if (cancelled || !found) {
        void found?.close();
        return;
      }
      pending.current = found;
      setPhase(availablePhase(found.version, found.notes));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    const found = pending.current;
    pending.current = null;
    started.current = false;
    setPhase({ status: "hidden" });
    if (found) void found.close();
  }, []);

  const start = useCallback(() => {
    const found = pending.current;
    if (!found || started.current) return;
    started.current = true;
    const version = found.version.replace(/^v/, "");
    setPhase({ status: "downloading", version, downloaded: 0, total: null });
    void found
      .install({
        onProgress(downloaded, total) {
          setPhase({ status: "downloading", version, downloaded, total });
        },
        onInstalling() {
          setPhase({ status: "installing", version });
        },
      })
      .catch((err: unknown) => {
        started.current = false;
        setPhase({ status: "error", message: errorText(err) });
      });
  }, []);

  const checkManual = useCallback(async (): Promise<{ found: boolean; version?: string; error?: string }> => {
    try {
      const found = await checkForUpdate();
      if (!found) {
        return { found: false };
      }
      pending.current = found;
      setPhase(availablePhase(found.version, found.notes));
      return { found: true, version: found.version };
    } catch (err) {
      const msg = errorText(err);
      setPhase({ status: "error", message: msg });
      return { found: false, error: msg };
    }
  }, []);

  return { phase, start, dismiss, checkManual };
}
