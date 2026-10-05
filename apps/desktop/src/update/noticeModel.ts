export type UpdatePhase =
  | { status: "hidden" }
  | { status: "available"; version: string; notes: string }
  | { status: "downloading"; version: string; downloaded: number; total: number | null }
  | { status: "installing"; version: string }
  | { status: "error"; message: string };

export type NoticeModel = {
  title: string;
  detail: string;
  primary: string | null;
  secondary: string | null;
  busy: boolean;
  percent: number | null;
};

const NOTES_MAX = 140;
const ERROR_MAX = 180;

export function updateVersion(version: string): string {
  return version.trim().replace(/^v/, "");
}

export function updateNotes(body: string | null | undefined): string {
  const flat = (body ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= NOTES_MAX) return flat;
  return `${flat.slice(0, NOTES_MAX - 1).trimEnd()}…`;
}

export function errorText(err: unknown): string {
  let message = "Something went wrong.";
  if (typeof err === "string" && err.trim()) message = err.trim();
  else if (err instanceof Error && err.message.trim()) message = err.message.trim();
  else if (err && typeof err === "object" && "message" in err) {
    const nested = err.message;
    if (typeof nested === "string" && nested.trim()) message = nested.trim();
  }
  if (message.length > ERROR_MAX) return `${message.slice(0, ERROR_MAX - 1).trimEnd()}…`;
  return message;
}

export function downloadPercent(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  const pct = Math.round((Math.max(0, downloaded) / total) * 100);
  return Math.min(100, pct);
}

export function availablePhase(version: string, notes: string): UpdatePhase {
  return {
    status: "available",
    version: updateVersion(version),
    notes: updateNotes(notes),
  };
}

export function noticeModel(phase: UpdatePhase): NoticeModel | null {
  switch (phase.status) {
    case "hidden":
      return null;
    case "available":
      return {
        title: `Sparkmux ${phase.version} is available`,
        detail: phase.notes,
        primary: "Update Now",
        secondary: "Later",
        busy: false,
        percent: null,
      };
    case "downloading": {
      const percent = downloadPercent(phase.downloaded, phase.total);
      const title =
        percent == null
          ? `Downloading Sparkmux ${phase.version}`
          : `Downloading Sparkmux ${phase.version} · ${percent}%`;
      return {
        title,
        detail: "",
        primary: null,
        secondary: null,
        busy: true,
        percent,
      };
    }
    case "installing":
      return {
        title: `Installing Sparkmux ${phase.version}`,
        detail: "Sparkmux will relaunch when the update is in place.",
        primary: null,
        secondary: null,
        busy: true,
        percent: null,
      };
    case "error":
      return {
        title: "Could not install the update",
        detail: phase.message,
        primary: null,
        secondary: "Dismiss",
        busy: false,
        percent: null,
      };
  }
}
