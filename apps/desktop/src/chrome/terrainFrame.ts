/** Idle, rebuild, and rest-pose decisions for the area map. The viewport calls these. */

export const DOCKED_CHANNEL_TAGS = ["USR", "THK", "RPL", "TOL"] as const;

export function dockedPeakLabel(tag: string, value: string | number): string {
  return `${tag} ${value}`;
}

export function cameraKey(
  azimuth: number,
  elevation: number,
  radius: number,
  tx: number,
  ty: number,
  tz: number,
): string {
  return [azimuth, elevation, radius, tx, ty, tz].map((n) => n.toFixed(4)).join(",");
}

/** An analytics poll that does not change the visible window must not upload again. */
export function shouldRebuildTerrain(previousSignature: string, nextSignature: string): boolean {
  return previousSignature !== nextSignature;
}

/**
 * Rest pose shows the whole time window. A phase-0 sweep (max X at the past
 * edge, globe fraction 0) would clip the mesh, so the reveal sits past the span.
 */
export function restReveal(extent: number): { rectMaxX: number; globeMaxFrac: number } {
  return { rectMaxX: extent + 2, globeMaxFrac: 1.2 };
}

export interface MapFrameInput {
  docked: boolean;
  dragging: boolean;
  zooming: boolean;
  playing: boolean;
  /** Docked rotation the user turned on. Not the fullscreen auto-rotate preference. */
  rotationOn: boolean;
  fullscreenAutoRotate: boolean;
  telemetry: string;
  previousTelemetry: string;
  width: number;
  height: number;
  previousWidth: number;
  previousHeight: number;
  camera: string;
  previousCamera: string;
  /** Spectral or mono. A change must paint once and then stop. */
  color: string;
  previousColor: string;
  geometryReady: boolean;
  extent: number;
  reset: boolean;
}

export interface MapFrameDecision {
  rebuildTerrain: boolean;
  requestRedraw: boolean;
  scheduleFollowUp: boolean;
  settled: boolean;
  rectMaxX: number;
  globeMaxFrac: number;
}

export function decideMapFrame(input: MapFrameInput): MapFrameDecision {
  const rebuildTerrain = shouldRebuildTerrain(input.previousTelemetry, input.telemetry);
  const sizeReady = input.width > 0 && input.height > 0;
  const sizeChanged =
    sizeReady &&
    (Math.round(input.width) !== Math.round(input.previousWidth) ||
      Math.round(input.height) !== Math.round(input.previousHeight));
  const cameraChanged = input.camera !== input.previousCamera;
  const colorChanged = input.color !== input.previousColor;
  const requestRedraw =
    sizeChanged ||
    rebuildTerrain ||
    cameraChanged ||
    colorChanged ||
    input.zooming ||
    input.reset ||
    input.dragging ||
    input.playing ||
    input.rotationOn ||
    !input.docked;
  // Auto-rotate left on from the fullscreen map is not docked rotation.
  const inheritedFromFullscreen = input.docked && input.fullscreenAutoRotate && !input.rotationOn;
  const scheduleFollowUp =
    !input.docked ||
    (input.rotationOn && !inheritedFromFullscreen) ||
    input.dragging ||
    input.playing ||
    !sizeReady ||
    !input.geometryReady;
  const settled =
    input.docked &&
    sizeReady &&
    input.geometryReady &&
    !rebuildTerrain &&
    !scheduleFollowUp &&
    !input.dragging &&
    !input.zooming &&
    !input.playing &&
    !input.rotationOn &&
    !input.reset &&
    !colorChanged;
  const reveal = restReveal(input.extent);
  return {
    rebuildTerrain,
    requestRedraw,
    scheduleFollowUp,
    settled,
    rectMaxX: reveal.rectMaxX,
    globeMaxFrac: reveal.globeMaxFrac,
  };
}

/**
 * Docked idle keeps the last full-resolution picture and only composites the
 * moving sweep. Dragging, playback, and docked rotation draw the field live.
 * A picture change (size, camera, telemetry, color, shape) draws live once,
 * then caches again. Fullscreen always draws live.
 */
export function dockedPresentMode(input: {
  docked: boolean;
  interacting: boolean;
  pictureKey: string;
  bakedKey: string;
}): "live" | "cached" {
  if (!input.docked || input.interacting) return "live";
  if (input.bakedKey.length === 0 || input.bakedKey !== input.pictureKey) return "live";
  return "cached";
}
