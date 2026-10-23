import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";

import {
  getActiveTarget,
  listenActiveTargetChanged,
  listenTreeDirty,
  snapshot as fetchSnapshot,
  type ActiveTarget,
} from "../api";
import type { Snapshot } from "../types";
import AnalyticsHud from "./AnalyticsHud";
import ChangeGraph from "./ChangeGraph";
import {
  ACTIVE_TARGET_STORAGE_KEY,
  formatPopoutWindowTitle,
  readStoredActiveTarget,
  resolvePopoutTarget,
  type PinnedTarget,
  type PopoutWindowKind,
} from "./popoutModel";

export default function PopoutWindow({ kind }: { kind: PopoutWindowKind }) {
  const [followTarget, setFollowTarget] = useState<ActiveTarget | null>(() => {
    try {
      return readStoredActiveTarget(window.localStorage.getItem(ACTIVE_TARGET_STORAGE_KEY));
    } catch {
      return null;
    }
  });
  const [snap, setSnap] = useState<Snapshot>({ sessions: [] });
  const [pinnedTarget, setPinnedTarget] = useState<PinnedTarget | null>(null);

  const refreshSnapshot = useCallback(() => {
    void fetchSnapshot()
      .then((next) => setSnap(next))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void getActiveTarget()
      .then((target) => {
        if (target && target.session_name) {
          setFollowTarget(target);
        }
      })
      .catch(() => {});
    refreshSnapshot();

    const interval = window.setInterval(refreshSnapshot, 1000);
    const unlistenTarget = listenActiveTargetChanged((target) => {
      if (target && target.session_name) {
        setFollowTarget(target);
      }
    });
    const unlistenTree = listenTreeDirty(() => {
      refreshSnapshot();
    });

    const onStorage = (event: StorageEvent) => {
      if (event.key === ACTIVE_TARGET_STORAGE_KEY) {
        const parsed = readStoredActiveTarget(event.newValue);
        if (parsed) setFollowTarget(parsed);
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("storage", onStorage);
      void unlistenTarget.then((fn) => fn());
      void unlistenTree.then((fn) => fn());
    };
  }, [refreshSnapshot]);

  const resolved = resolvePopoutTarget(snap, followTarget, pinnedTarget);
  const isPinned = pinnedTarget !== null;

  useEffect(() => {
    const title = formatPopoutWindowTitle(kind, resolved, isPinned);
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [kind, resolved.session_name, resolved.tab_name, isPinned]);

  const handleTogglePin = useCallback(() => {
    setPinnedTarget((prev) => {
      if (prev) return null;
      return {
        sessionName: resolved.session_name,
        tabId: resolved.tab_id,
        paneId: resolved.focused_pane,
      };
    });
  }, [resolved.session_name, resolved.tab_id, resolved.focused_pane]);

  const handleClose = useCallback(() => {
    void getCurrentWindow()
      .close()
      .catch(() => {
        window.close();
      });
  }, []);

  const attentionLabel =
    snap.sessions
      .find((session) => session.name === resolved.session_name)
      ?.windows.find((win) => win.id === resolved.tab_id)?.attention_label ?? null;

  if (kind === "stats") {
    return (
      <AnalyticsHud
        sessionName={resolved.session_name}
        tabId={resolved.tab_id}
        tabName={resolved.tab_name}
        command={resolved.command}
        cwd={resolved.cwd}
        title={resolved.title}
        pid={resolved.pid}
        onClose={handleClose}
        isStandaloneWindow
        pinned={isPinned}
        onTogglePin={handleTogglePin}
        attentionLabel={attentionLabel}
      />
    );
  }

  return (
    <ChangeGraph
      sessionName={resolved.session_name}
      tabId={resolved.tab_id}
      tabName={resolved.tab_name}
      command={resolved.command}
      cwd={resolved.cwd}
      title={resolved.title}
      pid={resolved.pid}
      onClose={handleClose}
      isStandaloneWindow
      pinned={isPinned}
      onTogglePin={handleTogglePin}
    />
  );
}
