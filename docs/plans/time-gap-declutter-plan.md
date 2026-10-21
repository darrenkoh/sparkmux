# Implementation Plan: Decluttering Time Gaps & Seams in Area Map & Token Spectrum

## 1. Problem Statement & Objectives
In long, infrequent sessions (e.g. conversational pings spaced 10–30 minutes apart across several hours/days):
1. **Low Fixed Threshold**: Every quiet stretch $\ge 5\text{ minutes}$ is collapsed into a 2-minute seam. Infrequent chats produce dozens of seams.
2. **Permanent Floating Text Clutter**: Both `TerrainViewport.tsx` (Area Map) and `TokenSpectrumChart.tsx` (Token Spectrum 3D Contour and Burst modes) render floating `+xxm` text labels across the 3D/2D canvas for *every* seam without collision detection or density gating.
3. **Objective**:
   - Combine **Option 1 (Subtle Visual Break + Hover/Summary Badge)** and **Option 3 (Adaptive Idle Threshold & Coalescing)**.
   - Remove visual clutter from the canvas while preserving rich awareness of folded time on hover, on the scrubber, and via high-level telemetry pills.

---

## 2. Key Files & Architecture

- `apps/desktop/src/chrome/terrainWindow.ts`:
  - Central piecewise compressed timeline math (`activityAxis`, `mapWindow`, `wallToCompressed`, `compressedToWall`).
  - Defines `IDLE_GAP_MS`, `COMPRESSED_GAP_MS`, `TimeSeam`, and `CompressedAxis`.
- `apps/desktop/src/chrome/tokenSpectrumMath.ts`:
  - Token spectrum normalization (`processTimelineData`), bucket processing, and seam generation for 3D Contour & Burst modes.
- `apps/desktop/src/chrome/TerrainViewport.tsx`:
  - 3D WebGL2 topography area map, 2D HUD canvas overlay (`terrainMetaRef.current.seamMarks`), timeline window scrubber (`scifi-window-track`).
- `apps/desktop/src/chrome/TokenSpectrumChart.tsx`:
  - Token spectrum 3D contour elevation view (`draw3DContourMode`), 2D Burst mode (`drawBurstMode`), HUD tooltip (`token-hud-tooltip`).

---

## 3. Detailed Technical Design

### Phase 1: Algorithmic Seam Refinement (`terrainWindow.ts` & `tokenSpectrumMath.ts`)

#### 1.1 Adaptive Idle Gap Threshold
Currently:
```ts
export const IDLE_GAP_MS = 5 * 60 * 1000; // Fixed 5 minutes
export const COMPRESSED_GAP_MS = 2 * 60 * 1000;
```
For sessions spanning several hours or days, a 5-minute quiet period between single prompt turns is normal cadence, not a significant session hiatus.

**Refactor `activityAxis`:**
1. Compute the raw session span: `totalSpan = span.end - span.start`.
2. Compute an adaptive idle threshold `effectiveIdleGapMs`:
   - If `totalSpan <= 1 hour`: 5 minutes.
   - If `1 hour < totalSpan <= 6 hours`: 10 minutes.
   - If `6 hours < totalSpan <= 24 hours`: 15 minutes.
   - If `totalSpan > 24 hours`: 30 minutes.
   *(Or continuous formula: `clamp(Math.round(totalSpan / 24), 5 * 60_000, 30 * 60_000)`).*
3. Adjust `effectiveCompGapMs`:
   - If total detected seams $> 8$, scale down compressed seam width from 2 minutes to 1 minute or 45 seconds so compressed idle space doesn't dominate active terrain.

#### 1.2 Adjacent Seam Coalescing & Noise Gating
If two idle seams occur with only a tiny single-burst activity point between them (e.g., a 10s ping followed by another 12m silence):
- Ensure seams separated by trivial activity ($< 30\text{s}$) don't produce stuttering back-to-back seams.
- Add `totalFoldedMs` and `seamCount` to `CompressedAxis` so callers can display aggregate folded time easily:
```ts
export interface CompressedAxis {
  wallStart: number;
  wallEnd: number;
  spanMs: number;
  pieces: TimePiece[];
  seams: TimeSeam[];
  totalFoldedMs: number; // Sum of (gapMs - seamWidth)
}
```

---

### Phase 2: Visual Declutter in Area Map (`TerrainViewport.tsx`)

#### 2.1 Clean Up the 2D Canvas Seam Drawing
In `TerrainViewport.tsx` (around lines 1515–1530):
```ts
// CURRENT CODE TO REMOVE / REFACTOR:
for (const seam of meta.seamMarks) {
  const xSeam = -tStartX + seam.fraction * (tStartX * 2);
  const ptSeam = project([xSeam, 0, tStartZ]);
  if (!ptSeam) continue;
  hud.strokeStyle = "rgba(255, 196, 96, 0.9)";
  hud.lineWidth = 1;
  hud.beginPath();
  hud.moveTo(ptSeam[0], ptSeam[1]);
  hud.lineTo(ptSeam[0], ptSeam[1] - 10);
  hud.stroke();
  hud.fillStyle = "#ff9a3c";
  hud.textAlign = "center";
  hud.fillText(seam.label, ptSeam[0], ptSeam[1] - 14); // <--- OVERLAPPING CLUTTER
}
```

**New Approach:**
1. **Remove the floating `+xxm` text** from the 3D ground plane.
2. **Subtle Seam Mark**: Replace the tall leader line and text with a subtle, elegant double-hash seam notch (`//` or a small 4px amber marker on the axis baseline: `rgba(255, 154, 60, 0.4)`).
3. **Terrain Canyons already visually represent seams**: The shader and geometry already dampen altitude at seam bands (`seamDamp = Math.min(seamDamp, along * along)`), which naturally communicates the gap.

#### 2.2 Rich Scrubber Track Hover Tooltips
The bottom scrubber track (`scifi-window-track`) already renders tick bars for seams:
```tsx
{axis.seams.map((seam) => {
  const spanMs = Math.max(1, axis.spanMs);
  const at = ((seam.compStart + seam.compEnd) / 2 / spanMs) * 100;
  return (
    <span
      key={`${seam.wallStart}-${seam.wallEnd}`}
      className="scifi-window-seam"
      style={{ left: `${at}%` }}
      title={`Idle Gap: ${seam.label} folded`}
    />
  );
})}
```
Enhance this:
- Add a subtle hover state or styling to `.scifi-window-seam` so mousing over the seam tick displays a crisp tooltip with exact gap details (e.g. `Idle: +42m (14:10 → 14:52)`).

#### 2.3 Aggregate Seam Summary Pill
In the viewport header or bottom telemetry row:
- If `axis.seams.length > 0`, display a compact sci-fi pill badge:
  `[SEAMS: ${axis.seams.length} · +${formatGap(axis.totalFoldedMs)} FOLDED]`
- Clicking or hovering this badge highlights or summarizes the gaps without cluttering the 3D mesh.

---

### Phase 3: Visual Declutter in Token Spectrum (`TokenSpectrumChart.tsx`)

#### 3.1 3D Contour Mode (`draw3DContourMode`)
Around lines 541–550:
```ts
// CURRENT CODE:
ctx.fillStyle = "#ff9a3c";
ctx.font = "9.5px ui-monospace, SFMono-Regular, Menlo, monospace";
ctx.textAlign = "center";
for (const seam of seams) {
  const seamX = xMin + seam.fraction * xSpan;
  const pt = project([seamX, 0, 6.6]);
  if (!pt) continue;
  ctx.fillText(seam.label, pt[0], pt[1] - 12); // <--- OVERLAPS ALL OVER FRONT AXIS
}
```

**New Approach:**
1. **Remove unconditional `ctx.fillText(seam.label, ...)`**.
2. **Subtle Axis Notches**: Render a subtle axis break icon on the front grid baseline:
   - Two parallel angled ticks (`//`) in muted amber `rgba(255, 154, 60, 0.45)`.
3. **Summary Badge in Toolbar**:
   - In `.token-chart-telemetry-tag`, display:
     `[GAPS: ${seams.length} (${formatGap(totalFolded)})]` when `seams.length > 0`.

#### 3.2 Burst Mode (`drawBurstMode` & `drawGridAndContours`)
In `drawGridAndContours` around lines 1139–1143:
```ts
// CURRENT CODE:
ctx.fillStyle = "#ff9a3c";
for (const seam of seams) {
  const x = padL + seam.fraction * plotW;
  ctx.fillText(seam.label, x, padT + plotH - 6); // <--- OVERLAPS WITH TIME TICKS
}
```

**New Approach:**
1. Remove `fillText` for all seams on the bottom axis.
2. Draw a dashed vertical partition line `ctx.setLineDash([2, 4])` with `rgba(255, 154, 60, 0.25)` across `plotH`, indicating the compressed break.
3. Show the seam break label only if the cursor hovers within $\pm 8\text{px}$ of the seam, or when inspecting the nearest bucket in the HUD tooltip.

#### 3.3 Enhanced HUD Tooltip Inspection
In `TokenSpectrumChart.tsx`'s hover tooltip (`token-hud-tooltip`):
- When the user hovers over a bucket immediately following a seam:
  - Add a small callout row:
    `⏳ GAPPED: +45m idle folded prior to this turn`.

---

## 4. Verification & Testing Checklist

- [ ] **Short session verification**: Start or mock a session $< 10$ minutes with 1–2 prompts; verify that normal spacing and minimal seams remain clean and functional.
- [ ] **Sparse long session verification**: Load or simulate a transcript with events spanning 8+ hours with 20+ minute gaps:
  - Verify no overlapping text labels appear on the Area Map 3D ground plane or Token Spectrum base axis.
  - Verify terrain valleys and subtle axis notches (`//`) visually demarcate breaks cleanly.
  - Verify hover on scrubber seam ticks and bucket tooltips shows precise gap duration.
  - Verify summary badge displays accurate total folded time.
- [ ] **Regression & Performance**:
  - Run `cargo test --workspace` and `cargo clippy --workspace -- -D warnings`.
  - Run `pnpm --dir apps/desktop run build` to guarantee TypeScript types and bundle succeed.
  - Verify 60 FPS continuous rendering remains smooth with no performance regression during orbit or drag.
