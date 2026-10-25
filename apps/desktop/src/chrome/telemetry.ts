import type { AppTelemetry } from "../types";

export type { AppTelemetry };

export type TelemetryTone = "ok" | "warn" | "hot";

export interface TelemetryPoint {
  time: number;
  cpu: number;
  memory: number;
}

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

/**
 * Pads the CPU formatted string with non-breaking spaces (\u00A0)
 * so that single-digit and double-digit percentages maintain constant visual width (8 characters).
 */
export function padCpu(cpuText: string): string {
  if (!cpuText || cpuText.length >= 8) return cpuText;
  return cpuText + "\u00A0".repeat(8 - cpuText.length);
}

/** Tone status based on CPU load percentage. */
export function cpuTone(percent: number | null | undefined): TelemetryTone {
  if (percent == null || !Number.isFinite(percent) || percent < 30) return "ok";
  if (percent < 70) return "warn";
  return "hot";
}

/** Tone status based on resident memory usage in bytes. */
export function memoryTone(bytes: number | null | undefined): TelemetryTone {
  if (bytes == null || !Number.isFinite(bytes)) return "ok";
  const mb = bytes / (1024 * 1024);
  if (mb < 600) return "ok";
  if (mb < 1200) return "warn";
  return "hot";
}

/**
 * Builds SVG path data for a sparkline stroke and its closed area fill.
 */
export function buildSparklinePaths(
  values: number[],
  width: number,
  height: number,
  options?: { minVal?: number; maxVal?: number },
): { strokePath: string; areaPath: string; latestPoint: { x: number; y: number } | null } {
  if (values.length === 0) {
    return { strokePath: "", areaPath: "", latestPoint: null };
  }
  const min = options?.minVal ?? Math.min(...values);
  const max = Math.max(options?.maxVal ?? min + 1, ...values);
  const range = max - min || 1;
  const padding = 1.5;
  const usableH = Math.max(1, height - padding * 2);

  const points = values.map((val, idx) => {
    const x = values.length > 1 ? (idx / (values.length - 1)) * width : width;
    const clamped = Math.max(min, Math.min(max, val));
    const y = height - padding - ((clamped - min) / range) * usableH;
    return { x, y };
  });

  const strokePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const last = points[points.length - 1];
  const first = points[0];
  const areaPath = `${strokePath} L ${last.x.toFixed(1)} ${height} L ${first.x.toFixed(1)} ${height} Z`;

  return { strokePath, areaPath, latestPoint: last };
}



