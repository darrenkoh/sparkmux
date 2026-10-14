declare module "three" {
  export const ACESFilmicToneMapping: number;
  export const DoubleSide: number;

  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
  }

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    add(v: Vector3): this;
    subVectors(a: Vector3, b: Vector3): this;
    lengthSq(): number;
    project(camera: Camera): this;
  }

  export class Euler {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }

  export class Matrix4 {}

  export class Color {
    constructor(color?: number);
    set(color: number): this;
  }

  export class BufferGeometry {
    dispose(): void;
  }

  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }

  export class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number);
  }

  export class Material {
    transparent: boolean;
    opacity: number;
    dispose(): void;
  }

  export class MeshBasicMaterial extends Material {
    constructor(parameters?: {
      color?: number;
      side?: number;
      transparent?: boolean;
      opacity?: number;
      depthWrite?: boolean;
    });
    map: { dispose(): void } | null;
    side: number;
    depthWrite: boolean;
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
    scale: Vector3;
    up: Vector3;
    matrix: Matrix4;
    children: Object3D[];
    userData: Record<string, unknown>;
    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
    traverse(callback: (object: Object3D) => void): void;
    updateMatrix(): void;
  }

  export class Camera extends Object3D {}

  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    updateProjectionMatrix(): void;
  }

  export class Group extends Object3D {}

  export class Scene extends Object3D {
    background: Color | null;
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material | Material[]);
    geometry?: BufferGeometry;
    material?: Material | Material[];
  }

  export class InstancedMesh extends Mesh {
    constructor(geometry: BufferGeometry | undefined, material: Material | undefined, count: number);
    instanceMatrix: { needsUpdate: boolean };
    instanceColor: { needsUpdate: boolean } | null;
    setMatrixAt(index: number, matrix: Matrix4): void;
    setColorAt(index: number, color: Color): void;
  }

  export class GridHelper extends Object3D {
    constructor(size?: number, divisions?: number, color1?: number, color2?: number);
    material: Material | Material[];
  }

  export class Raycaster {
    setFromCamera(pointer: Vector2, camera: Camera): void;
    intersectObjects(
      objects: Object3D[],
      recursive?: boolean,
    ): Array<{ instanceId?: number; object: Object3D }>;
  }

  export class WebGLRenderer {
    constructor(parameters?: { antialias?: boolean; alpha?: boolean; powerPreference?: string });
    domElement: HTMLCanvasElement;
    toneMapping: number;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: Scene, camera: Camera): void;
    dispose(): void;
    forceContextLoss(): void;
  }
}

declare module "three/addons/controls/OrbitControls.js" {
  import { Camera, Vector3 } from "three";
  export class OrbitControls {
    constructor(camera: Camera, domElement?: HTMLElement);
    target: Vector3;
    enablePan: boolean;
    enableZoom: boolean;
    enableDamping: boolean;
    dampingFactor: number;
    minPolarAngle: number;
    maxPolarAngle: number;
    update(): void;
    dispose(): void;
  }
}

declare module "three/addons/postprocessing/EffectComposer.js" {
  import { WebGLRenderer } from "three";
  export class EffectComposer {
    constructor(renderer: WebGLRenderer);
    addPass(pass: { dispose(): void }): void;
    setSize(width: number, height: number): void;
    render(): void;
    dispose(): void;
  }
}

declare module "three/addons/postprocessing/RenderPass.js" {
  import { Camera, Scene } from "three";
  export class RenderPass {
    constructor(scene: Scene, camera: Camera);
    dispose(): void;
  }
}

declare module "three/addons/postprocessing/UnrealBloomPass.js" {
  import { Vector2 } from "three";
  export class UnrealBloomPass {
    constructor(resolution: Vector2, strength?: number, radius?: number, threshold?: number);
    dispose(): void;
  }
}

declare module "three/addons/postprocessing/OutputPass.js" {
  export class OutputPass {
    constructor();
    dispose(): void;
  }
}
