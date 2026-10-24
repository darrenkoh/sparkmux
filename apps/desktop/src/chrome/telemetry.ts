import type { AppTelemetry } from "../types";

export type { AppTelemetry };

/** Resident bytes of the Sparkmux process. Zero or missing means the read failed. */
export function formatMemory(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    if (mb < 10) return `${mb.toFixed(1)} MB`;
    return `${Math.round(mb)} MB`;
  }
  const gb = mb / 1024;
  if (gb < 10) return `${gb.toFixed(1)} GB`;
  return `${Math.round(gb)} GB`;
}

/** Percent of one core. Null until a second sample exists. */
export function formatCpu(percent: number | null | undefined): string {
  if (percent == null || !Number.isFinite(percent) || percent < 0) return "CPU —";
  if (percent === 0) return "CPU 0%";
  if (percent < 10) return `CPU ${percent.toFixed(1)}%`;
  return `CPU ${Math.round(percent)}%`;
}


