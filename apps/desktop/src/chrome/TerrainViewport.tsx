import { useEffect, useRef, useState } from "react";
import type { ActivityPoint } from "../api";
import scifiData from "./scifiData.json";
import { REUNION_GRID_W, REUNION_GRID_H, REUNION_HEIGHTS_B64 } from "./reunionHeightsB64";

interface TerrainViewportProps {
  timeline: ActivityPoint[];
  activeModel?: string;
}

// ---------------------------------------------------------------------------
// Math & Vector Utilities
// ---------------------------------------------------------------------------
function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye: [number, number, number], target: [number, number, number], up: [number, number, number] = [0, 1, 0]): Float32Array {
  const z0 = eye[0] - target[0];
  const z1 = eye[1] - target[1];
  const z2 = eye[2] - target[2];
  const lenZ = Math.hypot(z0, z1, z2) || 1;
  const zx = z0 / lenZ, zy = z1 / lenZ, zz = z2 / lenZ;

  const x0 = up[1] * zz - up[2] * zy;
  const x1 = up[2] * zx - up[0] * zz;
  const x2 = up[0] * zy - up[1] * zx;
  const lenX = Math.hypot(x0, x1, x2) || 1;
  const xx = x0 / lenX, xy = x1 / lenX, xz = x2 / lenX;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[j] * b[i * 4] +
        a[4 + j] * b[i * 4 + 1] +
        a[8 + j] * b[i * 4 + 2] +
        a[12 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

function projectPoint(vp: Float32Array, p: [number, number, number], width: number, height: number): [number, number, number] | null {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  if (w <= 0.01) return null;
  return [(x / w * 0.5 + 0.5) * width, (0.5 - y / w * 0.5) * height, w];
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// PRNG matching reference seed 2077
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 1831565813) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// WebGL2 Shaders from beastydesign.github.io/scifi
// ---------------------------------------------------------------------------
const VS_TERRAIN = `#version 300 es
uniform mat4 uVP;
uniform float uTime, uFocus, uAperture, uDpr, uGain, uScan, uReal;
in vec4 aPos;      // xyz + brightness
in vec3 aCol;      // natural land-cover color
in float aSeed;
out float vA;
out float vRing;
out vec3 vCol;
void main() {
  vec4 c = uVP * vec4(aPos.xyz, 1.0);
  gl_Position = c;
  float coc = min(abs(c.w - uFocus) * uAperture, 30.0);
  float base = 1.0 + aSeed * 1.3;
  float size = base + coc;
  gl_PointSize = size * uDpr;
  float energy = (base * base) / (size * size);
  float twinkle = 0.82 + 0.18 * sin(uTime * (0.7 + aSeed * 2.5) + aSeed * 61.0);
  float scan = 1.0 + 2.2 * exp(-pow((aPos.y - uScan) * 5.0, 2.0)) * step(0.05, aPos.y);
  float fog = exp(-max(c.w - 40.0, 0.0) * 0.03);
  vA = aPos.w * energy * twinkle * scan * fog * uGain;
  vRing = smoothstep(5.0, 15.0, coc);
  vCol = mix(vec3(1.0), aCol, uReal);
}
`;

const FS_TERRAIN = `#version 300 es
precision highp float;
in float vA;
in float vRing;
in vec3 vCol;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float disc = 1.0 - smoothstep(0.65, 1.0, r);
  float ring = smoothstep(0.55, 0.86, r) * (1.0 - smoothstep(0.88, 1.0, r));
  float a = mix(disc, disc * 0.22 + ring * 1.5, vRing);
  o = vec4(vCol * (a * vA), 1.0);
}
`;

const VS_CONTOUR = `#version 300 es
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uScan, uScanAmount;
in vec3 aPos;
in float aA;
out float vA;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  float d = length(aPos - uCam);
  float fog = exp(-max(d - 30.0, 0.0) * 0.035);
  float scan = 1.0 + uScanAmount * exp(-pow((aPos.y - uScan) * 2.5, 2.0));
  vA = aA * fog * scan;
}
`;

const FS_CONTOUR = `#version 300 es
precision highp float;
uniform vec3 uColor;
in float vA;
out vec4 o;
void main() {
  o = vec4(uColor * vA, 1.0);
}
`;

// Decode base64 elevation buffer
function decodeHeights(): Int16Array {
  const binary = atob(REUNION_HEIGHTS_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export default function TerrainViewport({ timeline, activeModel }: TerrainViewportProps) {
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement>(null);
  const [realism, setRealism] = useState<"mono" | "color">("color");

  // Camera state matching reference defaults
  const camRef = useRef({
    azimuth: 0.35,
    elevation: 0.50,
    radius: 50,
    target: [0, 1.5, 0] as [number, number, number],
    isDragging: false,
    lastX: 0,
    lastY: 0,
    idleSince: performance.now() / 1000,
  });

  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    const hudCanvas = hudCanvasRef.current;
    if (!glCanvas || !hudCanvas) return;

    const gl = glCanvas.getContext("webgl2", { antialias: true, alpha: false });
    const hud = hudCanvas.getContext("2d");
    if (!gl || !hud) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
      }
      return s;
    };

    const link = (vs: string, fs: string) => {
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      return p;
    };

    const progTerrain = link(VS_TERRAIN, FS_TERRAIN);
    const progContour = link(VS_CONTOUR, FS_CONTOUR);

    // Uniform locations
    const uT = {
      uVP: gl.getUniformLocation(progTerrain, "uVP"),
      uTime: gl.getUniformLocation(progTerrain, "uTime"),
      uFocus: gl.getUniformLocation(progTerrain, "uFocus"),
      uAperture: gl.getUniformLocation(progTerrain, "uAperture"),
      uDpr: gl.getUniformLocation(progTerrain, "uDpr"),
      uGain: gl.getUniformLocation(progTerrain, "uGain"),
      uScan: gl.getUniformLocation(progTerrain, "uScan"),
      uReal: gl.getUniformLocation(progTerrain, "uReal"),
    };

    const uC = {
      uVP: gl.getUniformLocation(progContour, "uVP"),
      uCam: gl.getUniformLocation(progContour, "uCam"),
      uScan: gl.getUniformLocation(progContour, "uScan"),
      uScanAmount: gl.getUniformLocation(progContour, "uScanAmount"),
      uColor: gl.getUniformLocation(progContour, "uColor"),
    };

    // -------------------------------------------------------------------------
    // Load Authentic Elevation & Land-Cover Model
    // -------------------------------------------------------------------------
    const rng = makeRng(2077);
    const rawElev = decodeHeights();

    const unitM = scifiData.display.unitM || 1700;
    const vertScale = scifiData.display.vert || 3.5;
    const altRef = scifiData.display.altRef || 3000;
    const baseAlt = 0;
    const gridW = scifiData.grid.widthM / 2 / unitM;
    const gridD = scifiData.grid.depthM / 2 / unitM;

    // Normalised elevation function N(meters) -> WebGL world Y
    const toY = (alt: number) => Math.max(0, alt - baseAlt) * vertScale / unitM;

    // Bilinear ground height interpolation
    const getGround = (xM: number, zM: number): number => {
      const u = (xM + scifiData.grid.widthM / 2) / (scifiData.grid.cell * 2) - 0.5;
      const v = (zM + scifiData.grid.depthM / 2) / (scifiData.grid.cell * 2) - 0.5;
      const cx = Math.floor(u);
      const cz = Math.floor(v);
      if (cx < 0 || cz < 0 || cx >= REUNION_GRID_W - 1 || cz >= REUNION_GRID_H - 1) {
        return -50;
      }
      const fx = u - cx;
      const fz = v - cz;
      const idx = cz * REUNION_GRID_W + cx;
      const h00 = rawElev[idx];
      const h10 = rawElev[idx + 1];
      const h01 = rawElev[idx + REUNION_GRID_W];
      const h11 = rawElev[idx + REUNION_GRID_W + 1];
      return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
    };

    const sampleAlt = (normX: number, normZ: number) => getGround(normX * unitM, normZ * unitM);
    const sampleY = (normX: number, normZ: number) => toY(sampleAlt(normX, normZ));

    // Reference palette ht from main.js
    const PALETTE = [
      [1.0, 1.0, 1.0],         // 0: default
      [0.16, 0.60, 0.44],      // 1: forest / deep vegetation
      [0.45, 0.64, 0.36],      // 2: shrubs
      [0.62, 0.76, 0.40],      // 3: grassland
      [0.92, 0.74, 0.44],      // 4: agriculture
      [1.00, 0.62, 0.28],      // 5: urban / amber
      [0.74, 0.72, 0.68],      // 6: rock / summit
      [0.84, 0.93, 1.00],      // 7: snow / mist
      [0.32, 0.80, 0.86],      // 8: water / river
      [0.42, 0.72, 0.64],      // 9: wetlands
      [0.64, 0.68, 0.58],      // 10: lichens
    ];

    // Reference directional light vector [-0.45, 0.8, 0.4]
    const lightDir = [-0.45, 0.8, 0.4];

    // Build 65,000 particle points buffer matching reference
    const totalPoints = 65000;
    const posData = new Float32Array(totalPoints * 4);
    const colData = new Float32Array(totalPoints * 3);
    const seedData = new Float32Array(totalPoints);

    let pCount = 0;
    while (pCount < 50000) {
      const rx = (rng() * 2 - 1) * gridW;
      const rz = (rng() * 2 - 1) * gridD;
      const altM = sampleAlt(rx, rz);
      if (altM < 1) continue;

      const yWorld = toY(altM);
      const vStep = 0.08;
      const dx = sampleY(rx - vStep, rz) - sampleY(rx + vStep, rz);
      const dz = sampleY(rx, rz - vStep) - sampleY(rx, rz + vStep);
      const dy = 2 * vStep;
      const len = Math.hypot(dx, dy, dz) || 1;
      const slopeShade = (0.22 + 0.78 * Math.max(0, (dx * lightDir[0] + dy * lightDir[1] + dz * lightDir[2]) / len));
      const altFade = (0.5 + 0.5 * smoothstep(0, altRef, altM));
      const brightness = slopeShade * altFade * (0.55 + 0.45 * rng());

      // Determine land class color by altitude zone
      let colIdx = 1;
      if (altM > 2400) colIdx = 6;      // Summit rock
      else if (altM > 1600) colIdx = 2; // Shrubs
      else if (altM > 800) colIdx = 1;  // Rainforest
      else if (altM > 200) colIdx = 3;  // Green valley
      else colIdx = 4;                  // Coastal lowlands

      const baseCol = PALETTE[colIdx];

      posData[pCount * 4] = rx;
      posData[pCount * 4 + 1] = yWorld + Math.abs(rng() - rng()) * 0.03;
      posData[pCount * 4 + 2] = rz;
      posData[pCount * 4 + 3] = brightness;

      colData[pCount * 3] = baseCol[0];
      colData[pCount * 3 + 1] = baseCol[1];
      colData[pCount * 3 + 2] = baseCol[2];

      seedData[pCount] = rng();
      pCount++;
    }

    // High mountain haze & atmospheric particles
    while (pCount < totalPoints) {
      const rx = (rng() * 2 - 1) * gridW;
      const rz = (rng() * 2 - 1) * gridD;
      const altM = sampleAlt(rx, rz);
      if (altM > 600) {
        const yWorld = toY(altM) - Math.log(1 - rng()) * 0.4;
        posData[pCount * 4] = rx;
        posData[pCount * 4 + 1] = yWorld;
        posData[pCount * 4 + 2] = rz;
        posData[pCount * 4 + 3] = 0.18 * rng();

        colData[pCount * 3] = 0.88;
        colData[pCount * 3 + 1] = 0.94;
        colData[pCount * 3 + 2] = 1.0;

        seedData[pCount] = rng();
        pCount++;
      } else {
        // Sea plane particles
        posData[pCount * 4] = rx;
        posData[pCount * 4 + 1] = 0;
        posData[pCount * 4 + 2] = rz;
        posData[pCount * 4 + 3] = 0.05 + 0.1 * rng();

        colData[pCount * 3] = 0.25;
        colData[pCount * 3 + 1] = 0.50;
        colData[pCount * 3 + 2] = 0.62;

        seedData[pCount] = rng();
        pCount++;
      }
    }

    const vaoTerrain = gl.createVertexArray()!;
    gl.bindVertexArray(vaoTerrain);

    const bPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
    gl.bufferData(gl.ARRAY_BUFFER, posData.subarray(0, pCount * 4), gl.STATIC_DRAW);
    const locPos = gl.getAttribLocation(progTerrain, "aPos");
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 4, gl.FLOAT, false, 0, 0);

    const bCol = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bCol);
    gl.bufferData(gl.ARRAY_BUFFER, colData.subarray(0, pCount * 3), gl.STATIC_DRAW);
    const locCol = gl.getAttribLocation(progTerrain, "aCol");
    gl.enableVertexAttribArray(locCol);
    gl.vertexAttribPointer(locCol, 3, gl.FLOAT, false, 0, 0);

    const bSeed = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, bSeed);
    gl.bufferData(gl.ARRAY_BUFFER, seedData.subarray(0, pCount), gl.STATIC_DRAW);
    const locSeed = gl.getAttribLocation(progTerrain, "aSeed");
    gl.enableVertexAttribArray(locSeed);
    gl.vertexAttribPointer(locSeed, 1, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    // -------------------------------------------------------------------------
    // Marching Squares Topographical Contours & River Networks
    // -------------------------------------------------------------------------
    const contourVerts: number[] = [];
    const riverVerts: number[] = [];
    const baseGridVerts: number[] = [];

    // Authentic contour levels every 50m (minor) and 250m (major)
    const contourStep = 250;
    const contourMinor = 50;
    const levels: number[] = [];
    for (let c = contourMinor; c <= 3000; c += contourMinor) {
      levels.push(c);
    }

    const cellW = scifiData.grid.widthM / (REUNION_GRID_W - 1) / unitM;
    const cellD = scifiData.grid.depthM / (REUNION_GRID_H - 1) / unitM;

    for (let j = 0; j < REUNION_GRID_H - 1; j++) {
      const z0 = -gridD + j * cellD;
      for (let i = 0; i < REUNION_GRID_W - 1; i++) {
        const x0 = -gridW + i * cellW;
        const p0 = j * REUNION_GRID_W + i;
        const c0 = rawElev[p0];
        const c1 = rawElev[p0 + 1];
        const c2 = rawElev[p0 + REUNION_GRID_W + 1];
        const c3 = rawElev[p0 + REUNION_GRID_W];

        const minC = Math.min(c0, c1, c2, c3);
        const maxC = Math.max(c0, c1, c2, c3);
        if (maxC < contourMinor || minC > 3000) continue;

        for (const lvl of levels) {
          if (lvl < minC || lvl >= maxC) continue;
          const yLvl = toY(lvl) + 0.02;
          const segPts: Array<[number, number]> = [];

          // Edge 0 (bottom)
          if ((c0 > lvl) !== (c1 > lvl)) {
            const f = (lvl - c0) / (c1 - c0);
            segPts.push([x0 + f * cellW, z0]);
          }
          // Edge 1 (right)
          if ((c1 > lvl) !== (c2 > lvl)) {
            const f = (lvl - c1) / (c2 - c1);
            segPts.push([x0 + cellW, z0 + f * cellD]);
          }
          // Edge 2 (top)
          if ((c3 > lvl) !== (c2 > lvl)) {
            const f = (lvl - c3) / (c2 - c3);
            segPts.push([x0 + f * cellW, z0 + cellD]);
          }
          // Edge 3 (left)
          if ((c0 > lvl) !== (c3 > lvl)) {
            const f = (lvl - c0) / (c3 - c0);
            segPts.push([x0, z0 + f * cellD]);
          }

          const isMajor = lvl % contourStep === 0;
          const alpha = isMajor ? 0.42 : 0.16;

          for (let s = 0; s + 1 < segPts.length; s += 2) {
            contourVerts.push(
              segPts[s][0], yLvl, segPts[s][1], alpha,
              segPts[s + 1][0], yLvl, segPts[s + 1][1], alpha
            );
          }
        }
      }
    }

    // Rivers network from scifiData.json
    for (const r of scifiData.rivers || []) {
      const riverPts = r.slice(1);
      for (let s = 0; s + 3 < riverPts.length; s += 2) {
        const x1 = riverPts[s] / unitM;
        const z1 = riverPts[s + 1] / unitM;
        const x2 = riverPts[s + 2] / unitM;
        const z2 = riverPts[s + 3] / unitM;
        const y1 = sampleY(x1, z1) + 0.025;
        const y2 = sampleY(x2, z2) + 0.025;
        riverVerts.push(x1, y1, z1, 0.45, x2, y2, z2, 0.45);
      }
    }

    // Outer framing coordinate grid
    for (let g = -34; g <= 34; g += 2) {
      const a = g % 10 === 0 ? 0.18 : 0.07;
      baseGridVerts.push(g, 0, -34, a, g, 0, 34, a);
      baseGridVerts.push(-34, 0, g, a, 34, 0, g, a);
    }

    const createLineVAO = (verts: number[]) => {
      const f32 = new Float32Array(verts);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, f32, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      gl.bindVertexArray(null);
      return { vao, count: verts.length / 4 };
    };

    const vaoContours = createLineVAO(contourVerts);
    const vaoRivers = createLineVAO(riverVerts);
    const vaoBaseGrid = createLineVAO(baseGridVerts);

    // -------------------------------------------------------------------------
    // Neon Orange Trace Trail & Authentic Checkpoints from Dataset
    // -------------------------------------------------------------------------
    const tracePoints = scifiData.trace.map((p) => {
      const wx = p[1] / unitM;
      const wz = p[2] / unitM;
      const wy = toY(p[3]) + 0.03;
      return { km: p[0], pos: [wx, wy, wz] as [number, number, number], lat: p[4], lon: p[5], alt: p[3] };
    });

    const checkpoints = scifiData.checkpoints.map((cp) => {
      const wx = cp.x / unitM;
      const wz = cp.z / unitM;
      const wy = toY(cp.alt) + 0.03;
      return { ...cp, pos: [wx, wy, wz] as [number, number, number] };
    });

    const peaks = scifiData.peaks.map((pk) => {
      const wx = pk.x / unitM;
      const wz = pk.z / unitM;
      const wy = toY(pk.alt) + 0.03;
      return { ...pk, pos: [wx, wy, wz] as [number, number, number] };
    });

    const areas = scifiData.areas.map((ar) => {
      const wx = ar.x / unitM;
      const wz = ar.z / unitM;
      const wy = sampleY(wx, wz) + 0.03;
      return { ...ar, pos: [wx, wy, wz] as [number, number, number] };
    });

    // -------------------------------------------------------------------------
    // Render Loop with Authentic Sci-Fi Telemetry HUD
    // -------------------------------------------------------------------------
    let animId: number;
    let fps = 60;
    let lastFpsTime = performance.now();
    let frameCount = 0;
    const startTime = performance.now();

    const render = () => {
      const now = performance.now();
      const elapsed = (now - startTime) / 1000;
      const cam = camRef.current;

      // FPS counter
      frameCount++;
      if (now - lastFpsTime >= 500) {
        fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
      }

      // Auto-orbit slowly if idle for > 4s
      if (!cam.isDragging && elapsed - cam.idleSince > 4) {
        cam.azimuth += 0.002;
      }

      // Canvas resizing with device pixel ratio
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = glCanvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));

      if (glCanvas.width !== w || glCanvas.height !== h) {
        glCanvas.width = w;
        glCanvas.height = h;
        hudCanvas.width = w;
        hudCanvas.height = h;
      }

      gl.viewport(0, 0, w, h);
      gl.clearColor(0.012, 0.012, 0.014, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      // Camera view matrix
      const eyeX = cam.target[0] + cam.radius * Math.cos(cam.elevation) * Math.sin(cam.azimuth);
      const eyeY = cam.target[1] + cam.radius * Math.sin(cam.elevation);
      const eyeZ = cam.target[2] + cam.radius * Math.cos(cam.elevation) * Math.cos(cam.azimuth);

      const matProj = perspective(38 * (Math.PI / 180), w / h, 0.5, 260.0);
      const matView = lookAt([eyeX, eyeY, eyeZ], cam.target);
      const matVP = multiply(matProj, matView);

      // Scanning wave height matching reference: 0m to 3000m
      const scanCycle = (elapsed % 11) / 11;
      const scanAltM = Math.max(0, scanCycle * (altRef + 400) - 200);
      const scanAltY = toY(scanAltM);

      // 1. Draw Base Grid Lines
      gl.useProgram(progContour);
      gl.uniformMatrix4fv(uC.uVP, false, matVP);
      gl.uniform3f(uC.uCam, eyeX, eyeY, eyeZ);
      gl.uniform1f(uC.uScan, scanAltY);
      gl.uniform1f(uC.uScanAmount, 0);
      gl.uniform3f(uC.uColor, 1.0, 1.0, 1.0);
      gl.bindVertexArray(vaoBaseGrid.vao);
      gl.drawArrays(gl.LINES, 0, vaoBaseGrid.count);

      // 2. Draw Marching Squares Contours (Teal/Cyan)
      gl.uniform1f(uC.uScanAmount, 3.0);
      gl.uniform3f(uC.uColor, realism === "mono" ? 1.0 : 0.78, realism === "mono" ? 1.0 : 1.0, realism === "mono" ? 1.0 : 0.94);
      gl.bindVertexArray(vaoContours.vao);
      gl.drawArrays(gl.LINES, 0, vaoContours.count);

      // 3. Draw Rivers (Cyan)
      gl.uniform1f(uC.uScanAmount, 0);
      gl.uniform3f(uC.uColor, 0.32, 0.80, 0.86);
      gl.bindVertexArray(vaoRivers.vao);
      gl.drawArrays(gl.LINES, 0, vaoRivers.count);

      // 4. Draw Dense 65k Particle Cloud
      gl.useProgram(progTerrain);
      gl.uniformMatrix4fv(uT.uVP, false, matVP);
      gl.uniform1f(uT.uTime, elapsed);
      gl.uniform1f(uT.uFocus, cam.radius * 0.9);
      gl.uniform1f(uT.uAperture, 0.5 * (h / 700));
      gl.uniform1f(uT.uDpr, dpr);
      gl.uniform1f(uT.uGain, 0.42);
      gl.uniform1f(uT.uScan, scanAltY);
      gl.uniform1f(uT.uReal, realism === "mono" ? 0.0 : 1.0);

      gl.bindVertexArray(vaoTerrain);
      gl.drawArrays(gl.POINTS, 0, pCount);
      gl.bindVertexArray(null);

      // -----------------------------------------------------------------------
      // 5. Draw 2D Sci-Fi HUD Overlay Canvas matching screenshot
      // -----------------------------------------------------------------------
      hud.setTransform(dpr, 0, 0, dpr, 0, 0);
      hud.clearRect(0, 0, rect.width, rect.height);

      const project = (p: [number, number, number]) => projectPoint(matVP, p, rect.width, rect.height);

      // (A) Draw Glowing Orange Route Trail
      hud.lineJoin = "round";
      hud.lineCap = "round";

      // Background soft orange glow
      hud.strokeStyle = "rgba(255, 154, 60, 0.20)";
      hud.lineWidth = 6;
      hud.beginPath();
      let first = true;
      for (const pt of tracePoints) {
        const sc = project(pt.pos);
        if (!sc) { first = true; continue; }
        if (first) { hud.moveTo(sc[0], sc[1]); first = false; }
        else { hud.lineTo(sc[0], sc[1]); }
      }
      hud.stroke();

      // Sharp foreground neon orange core
      hud.strokeStyle = "rgba(255, 154, 60, 0.95)";
      hud.lineWidth = 1.6;
      hud.beginPath();
      first = true;
      for (const pt of tracePoints) {
        const sc = project(pt.pos);
        if (!sc) { first = true; continue; }
        if (first) { hud.moveTo(sc[0], sc[1]); first = false; }
        else { hud.lineTo(sc[0], sc[1]); }
      }
      hud.stroke();

      // (B) Draw Area Cirque Labels
      hud.save();
      hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      hud.textAlign = 'center';
      hud.fillStyle = 'rgba(255, 255, 255, 0.45)';
      for (const ar of areas) {
        const sc = project(ar.pos);
        if (sc) {
          hud.fillText(ar.name.split("").join(" "), sc[0], sc[1]);
        }
      }
      hud.restore();

      // (C) Draw Checkpoint Pins with authentic target rings and leader lines
      for (const cp of checkpoints) {
        const groundPt = project(cp.pos);
        const pinPt = project([cp.pos[0], cp.pos[1] + 1.8, cp.pos[2]]);
        if (!groundPt || !pinPt) continue;

        const isSpecial = cp.code === "DEP" || cp.code === "ARR" || cp.code === "BV1" || cp.code === "BV2" || cp.code === "CP6" || cp.code === "CP12";
        const color = isSpecial ? "#ff9a3c" : "#ffffff";
        const alpha = isSpecial ? 0.95 : 0.65;

        // Ground target circle
        hud.strokeStyle = isSpecial ? "rgba(255, 154, 60, 0.55)" : "rgba(255, 255, 255, 0.35)";
        hud.lineWidth = 1;
        hud.beginPath();
        const rRad = 0.35;
        for (let st = 0; st <= 20; st++) {
          const th = (st / 20) * Math.PI * 2;
          const rP = project([cp.pos[0] + Math.cos(th) * rRad, cp.pos[1], cp.pos[2] + Math.sin(th) * rRad]);
          if (rP) {
            st === 0 ? hud.moveTo(rP[0], rP[1]) : hud.lineTo(rP[0], rP[1]);
          }
        }
        hud.stroke();

        // Vertical leader line
        hud.strokeStyle = color;
        hud.beginPath();
        hud.moveTo(groundPt[0], groundPt[1]);
        hud.lineTo(pinPt[0], pinPt[1] + (isSpecial ? 6 : 4));
        hud.stroke();

        // Pin head ring + inner core
        hud.beginPath();
        hud.arc(pinPt[0], pinPt[1], isSpecial ? 6 : 4, 0, Math.PI * 2);
        hud.stroke();

        hud.fillStyle = color;
        hud.beginPath();
        hud.arc(pinPt[0], pinPt[1], 1.6, 0, Math.PI * 2);
        hud.fill();

        // Callout text label
        hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillStyle = color;
        hud.globalAlpha = alpha;
        hud.fillText(`${cp.code} ${cp.name.toUpperCase()}`, pinPt[0] + 10, pinPt[1] - 4);

        if (isSpecial) {
          hud.globalAlpha = 0.45;
          hud.fillText(`KM ${cp.km.toFixed(1)} · ${cp.alt} m`, pinPt[0] + 10, pinPt[1] + 6);
        }
        hud.globalAlpha = 1.0;
      }

      // (D) Draw Major Mountain Peak Pins (Piton des Neiges, Piton de la Fournaise)
      for (const pk of peaks) {
        const gPt = project(pk.pos);
        const pPt = project([pk.pos[0], pk.pos[1] + 2.2, pk.pos[2]]);
        if (!gPt || !pPt) continue;

        hud.strokeStyle = "rgba(255, 255, 255, 0.8)";
        hud.lineWidth = 1;
        hud.beginPath();
        hud.moveTo(gPt[0], gPt[1]);
        hud.lineTo(pPt[0], pPt[1]);
        hud.stroke();

        hud.beginPath();
        hud.arc(pPt[0], pPt[1], 5, 0, Math.PI * 2);
        hud.stroke();

        hud.fillStyle = "#ffffff";
        hud.beginPath();
        hud.arc(pPt[0], pPt[1], 1.8, 0, Math.PI * 2);
        hud.fill();

        // Triangle inverted chevron
        hud.beginPath();
        hud.moveTo(pPt[0] - 3, pPt[1] - 8);
        hud.lineTo(pPt[0] + 3, pPt[1] - 8);
        hud.lineTo(pPt[0], pPt[1] - 4);
        hud.closePath();
        hud.fill();

        hud.font = '8.5px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillText(pk.name, pPt[0] + 8, pPt[1] - 2);
        hud.fillStyle = "rgba(255, 255, 255, 0.45)";
        hud.fillText(`${pk.alt} m`, pPt[0] + 8, pPt[1] + 8);
      }

      // (E) Left Altitude Ruler (0 to 3000m)
      const rulerMax = 3200;
      const rulerTop = 70;
      const rulerBottom = rect.height - 50;
      const rY = (alt: number) => rulerBottom - (alt / rulerMax) * (rulerBottom - rulerTop);

      hud.strokeStyle = "rgba(255, 255, 255, 0.3)";
      hud.fillStyle = "rgba(255, 255, 255, 0.35)";
      hud.lineWidth = 1;
      hud.beginPath();
      hud.moveTo(14, rulerTop);
      hud.lineTo(14, rulerBottom);
      for (let a = 0; a <= rulerMax; a += 100) {
        const y = rY(a);
        hud.moveTo(14, y);
        hud.lineTo(a % 500 === 0 ? 24 : 18, y);
      }
      hud.stroke();

      hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
      hud.textAlign = 'left';
      for (let a = 0; a <= 3000; a += 500) {
        hud.fillText(String(a), 28, rY(a));
      }

      // Active scan cursor on ruler
      const cursorY = rY(clamp(scanAltM, 0, rulerMax));
      hud.fillStyle = "#ffffff";
      hud.beginPath();
      hud.moveTo(14, cursorY);
      hud.lineTo(8, cursorY - 4);
      hud.lineTo(8, cursorY + 4);
      hud.closePath();
      hud.fill();

      // (F) Right Matrix of Coordinates & Waypoints
      if (rect.width >= 700) {
        hud.textAlign = 'right';
        hud.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        const centerIdx = Math.floor((elapsed * 12) % tracePoints.length);
        for (let i = -12; i <= 12; i++) {
          const ptIdx = clamp(centerIdx + i * 3, 0, tracePoints.length - 1);
          const pt = tracePoints[ptIdx];
          const lineY = rect.height / 2 + i * 15;
          const isMid = i === 0;
          hud.fillStyle = isMid ? "#ff9a3c" : `rgba(255, 255, 255, ${0.32 - Math.abs(i) * 0.02})`;
          hud.fillText(
            `${pt.lat.toFixed(5)}  ${pt.lon.toFixed(5)}  ${String(pt.alt).padStart(4, " ")}  ${pt.km.toFixed(2).padStart(6, "0")}`,
            rect.width - 16,
            lineY
          );
        }
      }

      // (G) Bottom Telemetry Line
      hud.textAlign = 'left';
      hud.fillStyle = 'rgba(255, 255, 255, 0.45)';
      hud.fillText(`DRAG · ORBIT   WHEEL · ZOOM   DBL-CLICK · RESET`, 46, rect.height - 18);

      hud.textAlign = 'right';
      hud.fillText(`SCAN ALT ${Math.round(scanAltM)} m   PTS 314 430   ${fps} FPS`, rect.width - 20, rect.height - 18);

      // (H) Top Floating Perspective Title Banner
      const startPt = checkpoints[0].pos;
      const b0 = project([startPt[0] - 4, 3.2, startPt[2] + 3]);
      const b1 = project([startPt[0] + 4, 3.2, startPt[2] + 3]);
      const b2 = project([startPt[0] + 4, 1.6, startPt[2] + 3]);
      const b3 = project([startPt[0] - 4, 1.6, startPt[2] + 3]);

      if (b0 && b1 && b2 && b3) {
        hud.strokeStyle = "rgba(255, 255, 255, 0.75)";
        hud.fillStyle = "rgba(255, 255, 255, 0.035)";
        hud.lineWidth = 1;
        hud.beginPath();
        hud.moveTo(b0[0], b0[1]);
        hud.lineTo(b1[0], b1[1]);
        hud.lineTo(b2[0], b2[1]);
        hud.lineTo(b3[0], b3[1]);
        hud.closePath();
        hud.fill();
        hud.stroke();

        hud.save();
        const bannerW = 340, bannerH = 64;
        hud.transform((b1[0] - b0[0]) / bannerW, (b1[1] - b0[1]) / bannerW, (b3[0] - b0[0]) / bannerH, (b3[1] - b0[1]) / bannerH, b0[0], b0[1]);
        hud.fillStyle = "rgba(255, 255, 255, 0.92)";
        hud.font = '22px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillText(activeModel || "DIAGONALE DES FOUS", 20, 26);
        hud.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        hud.fillStyle = "rgba(255, 154, 60, 0.85)";
        hud.fillText(`SESSION TELEMETRY · 180.8 KM · 10180 D+`, 20, 48);
        hud.restore();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);

    // Pointer Interactivity Listeners
    const handleDown = (e: PointerEvent) => {
      camRef.current.isDragging = true;
      camRef.current.lastX = e.clientX;
      camRef.current.lastY = e.clientY;
      camRef.current.idleSince = performance.now() / 1000;
      glCanvas.setPointerCapture(e.pointerId);
    };

    const handleMove = (e: PointerEvent) => {
      const cam = camRef.current;
      if (!cam.isDragging) return;
      const dx = e.clientX - cam.lastX;
      const dy = e.clientY - cam.lastY;
      cam.lastX = e.clientX;
      cam.lastY = e.clientY;

      cam.azimuth -= dx * 0.005;
      cam.elevation = clamp(cam.elevation + dy * 0.004, 0.06, 1.35);
      cam.idleSince = performance.now() / 1000;
    };

    const handleUp = (e: PointerEvent) => {
      camRef.current.isDragging = false;
      try {
        glCanvas.releasePointerCapture(e.pointerId);
      } catch {}
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      camRef.current.radius = clamp(camRef.current.radius * Math.exp(e.deltaY * 0.001), 14, 90);
      camRef.current.idleSince = performance.now() / 1000;
    };

    const handleDblClick = () => {
      camRef.current.azimuth = 0.35;
      camRef.current.elevation = 0.50;
      camRef.current.radius = 50;
      camRef.current.idleSince = performance.now() / 1000;
    };

    glCanvas.addEventListener("pointerdown", handleDown);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    glCanvas.addEventListener("wheel", handleWheel, { passive: false });
    glCanvas.addEventListener("dblclick", handleDblClick);

    return () => {
      cancelAnimationFrame(animId);
      glCanvas.removeEventListener("pointerdown", handleDown);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      glCanvas.removeEventListener("wheel", handleWheel);
      glCanvas.removeEventListener("dblclick", handleDblClick);
    };
  }, [timeline, realism, activeModel]);

  return (
    <section className="scifi-panel viewport">
      <canvas ref={glCanvasRef} id="terrain" className="scifi-terrain-canvas" />
      <canvas ref={hudCanvasRef} id="terrain-hud" className="scifi-hud-canvas" />
      <header>
        <span className="tag">01</span>
        <span>TOPOGRAPHICAL TELEMETRY SPECTRUM</span>
        <small>{activeModel || "QUANTUM RELIEF"}</small>
      </header>

      <div className="scifi-viewport-hint">
        DRAG · ORBIT &nbsp;&nbsp; WHEEL · ZOOM &nbsp;&nbsp; DBL-CLICK · RESET
      </div>

      <div className="scifi-viewport-mode">
        <button
          type="button"
          className={realism === "mono" ? "on" : ""}
          onClick={() => setRealism("mono")}
        >
          MONO
        </button>
        <button
          type="button"
          className={realism === "color" ? "on" : ""}
          onClick={() => setRealism("color")}
        >
          SPECTRAL
        </button>
      </div>
    </section>
  );
}
