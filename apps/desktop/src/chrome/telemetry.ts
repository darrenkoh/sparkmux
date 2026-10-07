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

export function helperStatusText(telemetry: AppTelemetry | null): string {
  if (!telemetry) return "Helper —";
  if (!telemetry.helper_enabled) return "Helper off";
  const name = telemetry.model_name.trim();
  return name || "Command helper";
}

export function helperStatusTitle(telemetry: AppTelemetry | null): string {
  const name = telemetry?.model_name.trim() || "Qwen2.5-Coder-1.5B-Instruct";
  if (!telemetry) return `Command helper model: ${name}`;
  if (!telemetry.helper_enabled) return `Command helper is off. Model: ${name}`;
  if (telemetry.model_loaded) return `Command helper model ${name}, loaded`;
  return `Command helper model ${name}, not loaded`;
}

export function helperStateText(telemetry: AppTelemetry | null): string {
  if (!telemetry) return "—";
  if (!telemetry.helper_enabled) return "Off";
  return telemetry.model_loaded ? "On, model loaded" : "On, model not loaded";
}

export function modelText(telemetry: AppTelemetry | null): string {
  if (!telemetry) return "—";
  const name = telemetry.model_name.trim();
  return name || "—";
}
