declare module "three" {
  export const ACESFilmicToneMapping: number;
  export const DoubleSide: number;
  export const FrontSide: number;
  export const SRGBColorSpace: string;
  export const PCFSoftShadowMap: number;

  export const MathUtils: {
    lerp(from: number, to: number, alpha: number): number;
    clamp(value: number, min: number, max: number): number;
    damp(from: number, to: number, lambda: number, dt: number): number;
  };

  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    set(x: number, y: number): this;
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
    lerp(v: Vector3, alpha: number): this;
    distanceToSquared(v: Vector3): number;
    lengthSq(): number;
    project(camera: Camera): this;
  }

  export class Quaternion {
    setFromUnitVectors(from: Vector3, to: Vector3): this;
    copy(q: Quaternion): this;
  }

  export class Euler {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }

  export class Matrix4 {
    identity(): this;
    makeTranslation(x: number, y: number, z: number): this;
  }

  export class Color {
    constructor(color?: number);
    readonly r: number;
    readonly g: number;
    readonly b: number;
    set(color: number): this;
    copy(color: Color): this;
    lerp(color: Color, alpha: number): this;
  }

  export class BufferAttribute {
    needsUpdate: boolean;
    constructor(array: ArrayLike<number>, itemSize: number);
    setXYZ(index: number, x: number, y: number, z: number): this;
  }

  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }

  export class BufferGeometry {
    dispose(): void;
    setAttribute(name: string, attribute: BufferAttribute): this;
  }

  export class BoxGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }

  export class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number);
  }

  export class CylinderGeometry extends BufferGeometry {
    constructor(radiusTop?: number, radiusBottom?: number, height?: number, radialSegments?: number);
  }

  export class OctahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number);
  }

  export class LineBasicMaterial extends Material {
    constructor(parameters?: {
      color?: number;
      transparent?: boolean;
      opacity?: number;
      linewidth?: number;
    });
    color: Color;
  }

  export class LineSegments extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry?: BufferGeometry;
    material?: Material;
  }

  export class Texture {
    needsUpdate: boolean;
    dispose(): void;
  }

  export class CanvasTexture extends Texture {
    constructor(canvas: HTMLCanvasElement);
  }

  export class Material {
    transparent: boolean;
    opacity: number;
    dispose(): void;
  }

  export class MeshBasicMaterial extends Material {
    constructor(parameters?: {
      color?: number;
      map?: Texture | null;
      side?: number;
      transparent?: boolean;
      opacity?: number;
      depthWrite?: boolean;
      vertexColors?: boolean;
      wireframe?: boolean;
    });
    color: Color;
    map: Texture | null;
    side: number;
    depthWrite: boolean;
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
    quaternion: Quaternion;
    scale: Vector3;
    up: Vector3;
    visible: boolean;
    matrix: Matrix4;
    children: Object3D[];
    userData: Record<string, unknown>;
    castShadow: boolean;
    receiveShadow: boolean;
    add(...objects: Object3D[]): this;
    remove(...objects: Object3D[]): this;
    traverse(callback: (object: Object3D) => void): void;
    updateMatrix(): void;
    lookAt(x: number, y: number, z: number): void;
    clone(recursive?: boolean): this;
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

  export class RingGeometry extends BufferGeometry {
    constructor(innerRadius?: number, outerRadius?: number, thetaSegments?: number);
  }

  export class PointsMaterial extends Material {
    constructor(parameters?: {
      size?: number;
      vertexColors?: boolean;
      transparent?: boolean;
      opacity?: number;
      depthWrite?: boolean;
      color?: number;
    });
    color: Color;
    size: number;
  }

  export class Points extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry?: BufferGeometry;
    material?: Material;
  }

  export class Raycaster {
    setFromCamera(pointer: Vector2, camera: Camera): void;
    intersectObjects(
      objects: Object3D[],
      recursive?: boolean,
    ): Array<{ instanceId?: number; object: Object3D; point: Vector3 }>;
  }

  export class WebGLRenderer {
    constructor(parameters?: { antialias?: boolean; alpha?: boolean; powerPreference?: string });
    domElement: HTMLCanvasElement;
    toneMapping: number;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    shadowMap: { enabled: boolean; type: number };
    outputColorSpace: string;
    info: { memory: { geometries: number; textures: number } };
    render(scene: Scene, camera: Camera): void;
    dispose(): void;
    forceContextLoss(): void;
  }

  export class Light extends Object3D {
    color: Color;
    intensity: number;
  }

  export class AmbientLight extends Light {
    constructor(color?: number, intensity?: number);
  }

  export class HemisphereLight extends Light {
    constructor(skyColor?: number, groundColor?: number, intensity?: number);
  }

  export class DirectionalLight extends Light {
    constructor(color?: number, intensity?: number);
    castShadow: boolean;
    target: Object3D;
    shadow: {
      bias: number;
      autoUpdate: boolean;
      needsUpdate: boolean;
      mapSize: Vector2;
      camera: OrthographicCamera;
    };
  }

  export class PointLight extends Light {
    constructor(color?: number, intensity?: number, distance?: number);
    castShadow: boolean;
  }

  export class OrthographicCamera extends Camera {
    constructor(left?: number, right?: number, top?: number, bottom?: number, near?: number, far?: number);
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
    zoom: number;
    updateProjectionMatrix(): void;
  }

  export class SphereGeometry extends BufferGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number);
  }

  export class CapsuleGeometry extends BufferGeometry {
    constructor(radius?: number, length?: number, capSegments?: number, radialSegments?: number);
  }

  export class ConeGeometry extends BufferGeometry {
    constructor(radius?: number, height?: number, radialSegments?: number);
  }

  export class CircleGeometry extends BufferGeometry {
    constructor(radius?: number, segments?: number);
  }

  export class IcosahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number);
  }

  export class MeshStandardMaterial extends Material {
    constructor(parameters?: {
      color?: number;
      roughness?: number;
      metalness?: number;
      emissive?: number;
      emissiveIntensity?: number;
      transparent?: boolean;
      opacity?: number;
      map?: Texture | null;
      side?: number;
    });
    color: Color;
    roughness: number;
    metalness: number;
    emissive: Color;
    emissiveIntensity: number;
    map: Texture | null;
  }

  export class SpriteMaterial extends Material {
    constructor(parameters?: {
      map?: Texture | null;
      color?: number;
      transparent?: boolean;
      opacity?: number;
      depthWrite?: boolean;
    });
    color: Color;
    map: Texture | null;
    rotation: number;
  }

  export class Sprite extends Object3D {
    constructor(material?: SpriteMaterial);
    material: SpriteMaterial;
    center: Vector2;
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
    minDistance: number;
    maxDistance: number;
    minAzimuthAngle: number;
    maxAzimuthAngle: number;
    enableRotate: boolean;
    screenSpacePanning: boolean;
    minZoom: number;
    maxZoom: number;
    autoRotate: boolean;
    autoRotateSpeed: number;
    update(): void;
    dispose(): void;
    addEventListener(type: "start" | "change" | "end", listener: () => void): void;
    removeEventListener(type: "start" | "change" | "end", listener: () => void): void;
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
