import { invoke } from "@tauri-apps/api/core";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";

export type UpdateProgress = {
  onProgress: (downloaded: number, total: number | null) => void;
  onInstalling: () => void;
};

export type AvailableUpdate = {
  version: string;
  notes: string;
  install: (progress: UpdateProgress) => Promise<void>;
  close: () => Promise<void>;
};

function applyDownload(
  event: DownloadEvent,
  progress: UpdateProgress,
  downloaded: { n: number },
  total: { n: number | null },
) {
  if (event.event === "Started") {
    total.n = event.data.contentLength ?? null;
    downloaded.n = 0;
    progress.onProgress(0, total.n);
    return;
  }
  if (event.event === "Progress") {
    downloaded.n += event.data.chunkLength;
    progress.onProgress(downloaded.n, total.n);
    return;
  }
  progress.onInstalling();
}

// A missing manifest or a failed check stays quiet so launch is unchanged.
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  let update;
  try {
    update = await check();
  } catch (err) {
    console.warn("update check failed", err);
    return null;
  }
  if (!update) return null;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await update.close();
  };

  return {
    version: update.version,
    notes: update.body ?? "",
    close,
    async install(progress) {
      const downloaded = { n: 0 };
      const total = { n: null as number | null };
      try {
        await update.downloadAndInstall((event) => {
          applyDownload(event, progress, downloaded, total);
        });
        progress.onInstalling();
        await invoke("relaunch_after_update");
      } catch (err) {
        await close().catch(() => {});
        throw err;
      }
    },
  };
}
