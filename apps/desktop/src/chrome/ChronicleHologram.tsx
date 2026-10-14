import type { ChronicleHologram as HologramPayload } from "../api";

export function chroniclePanelText(input: {
  tab: "file" | "diff";
  loading: boolean;
  preview: string;
  hologram: Pick<HologramPayload, "fidelity" | "file_text" | "diff_text"> | null;
}): string {
  if (!input.hologram) {
    if (!input.loading) return input.preview;
    return input.preview ? `${input.preview}\nLoading…` : "Loading…";
  }
  if (input.tab === "diff") return input.hologram.diff_text;
  if (input.hologram.file_text != null) return input.hologram.file_text;
  if (input.hologram.fidelity === "patch") return input.hologram.diff_text;
  return "";
}

export function chroniclePanelBanners(hologram: HologramPayload | null): string[] {
  if (!hologram) return [];
  const banners: string[] = [];
  if (hologram.fidelity === "patch") {
    banners.push("Patch only. The full file at this step could not be rebuilt.");
  }
  if (hologram.fidelity === "deleted") banners.push("Deleted at this step.");
  if (hologram.fidelity === "binary") banners.push("Binary file. No preview.");
  if (hologram.reason) banners.push(hologram.reason);
  if (hologram.file_truncated) {
    banners.push(`Showing a window from line ${hologram.window_start_line} of ${hologram.total_lines}.`);
  }
  if (hologram.diff_truncated) banners.push("Diff truncated.");
  return banners;
}

export default function ChronicleHologram(props: {
  title: string;
  banners: readonly string[];
  tab: "file" | "diff";
  onTab: (tab: "file" | "diff") => void;
  text: string;
}) {
  return (
    <aside className="chronicle-hologram" aria-live="polite">
      <header>{props.title}</header>
      {props.banners.map((banner, index) => (
        <p key={`${index}:${banner}`} className="chronicle-note">
          {banner}
        </p>
      ))}
      <div className="chronicle-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={props.tab === "file"} onClick={() => props.onTab("file")}>
          File
        </button>
        <button type="button" role="tab" aria-selected={props.tab === "diff"} onClick={() => props.onTab("diff")}>
          Session diff
        </button>
      </div>
      <pre className="chronicle-hologram-text" tabIndex={0}>
        {props.text}
      </pre>
    </aside>
  );
}
