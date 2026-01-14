declare module "three" {
  // Minimal fallback typings for three.js used in the app.
  export const DoubleSide: any;
  export const NotEqualStencilFunc: any;
  export const KeepStencilOp: any;
  export const AlwaysStencilFunc: any;
  export const ReplaceStencilOp: any;
  export const SRGBColorSpace: any;
  export const ACESFilmicToneMapping: any;

  export class WebGLRenderer {
    [key: string]: any;
    constructor(params?: any);
    domElement: any;
    outputColorSpace: any;
    toneMapping: any;
    toneMappingExposure: number;
    autoClear: boolean;
    setSize: (...args: any[]) => any;
    setPixelRatio: (...args: any[]) => any;
    setClearColor: (...args: any[]) => any;
    render: (...args: any[]) => any;
  }

  export class Scene {
    [key: string]: any;
    constructor();
    environment?: any;
    add: (...args: any[]) => any;
  }

  export class PerspectiveCamera {
    [key: string]: any;
    constructor(fov: number, aspect: number, near: number, far: number);
    position: any;
    aspect: number;
    fov: number;
    up: Vector3;
    updateProjectionMatrix: () => void;
    lookAt: (...args: any[]) => any;
  }

  export class OrthographicCamera {
    [key: string]: any;
    constructor(left: number, right: number, top: number, bottom: number, near: number, far: number);
    updateProjectionMatrix: () => void;
  }

  export class MeshBasicMaterial {
    [key: string]: any;
    constructor(params?: any);
    stencilWrite?: any;
    stencilRef?: any;
    stencilFunc?: any;
    stencilFail?: any;
    stencilZFail?: any;
    stencilZPass?: any;
    colorWrite?: any;
    depthWrite?: any;
    depthTest?: any;
    side?: any;
    transparent?: boolean;
    opacity?: number;
  }

  export class PlaneGeometry {
    [key: string]: any;
    constructor(width: number, height: number);
  }

  export class Object3D {
    [key: string]: any;
  }

  export class Mesh<TGeom = any, TMat = any> extends Object3D {
    constructor(geometry?: TGeom, material?: TMat);
    geometry: TGeom;
    material: TMat;
    matrixAutoUpdate: boolean;
    visible: boolean;
  }

  export class Vector3 {
    [key: string]: any;
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    clone(): Vector3;
    negate(): Vector3;
    multiplyScalar(n: number): Vector3;
    normalize(): Vector3;
    copy(v: Vector3): Vector3;
    add(v: Vector3): Vector3;
    addVectors(a: Vector3, b: Vector3): Vector3;
  }

  export class Matrix4 {
    [key: string]: any;
    constructor();
    lookAt: (...args: any[]) => any;
  }

  export class Quaternion {
    [key: string]: any;
    constructor();
    setFromRotationMatrix: (m: any) => any;
  }

  export class Euler {
    [key: string]: any;
    constructor(x?: number, y?: number, z?: number, order?: string);
    x: number;
    y: number;
    z: number;
    order?: string;
  }

  export class CatmullRomCurve3 {
    [key: string]: any;
    constructor(points?: Vector3[]);
    getPointAt: (t: number, target?: Vector3) => Vector3;
  }

  export class Box3 {
    [key: string]: any;
    constructor();
    setFromObject: (obj: any) => Box3;
    getSize: (target: Vector3) => Vector3;
    getCenter: (target: Vector3) => Vector3;
  }

  export class PMREMGenerator {
    [key: string]: any;
    constructor(renderer: WebGLRenderer);
    fromScene: (scene: any, sigma?: number) => { texture: any };
    dispose: () => void;
  }

  const Three: any;
  export = Three;
  export as namespace THREE;
  export default Three;
}

declare module "three/examples/jsm/loaders/GLTFLoader.js" {
  export class GLTFLoader {
    load: (url: string, onLoad: (gltf: any) => void, onProgress?: any, onError?: any) => void;
    setDRACOLoader: (loader: any) => void;
  }
}

declare module "three/examples/jsm/environments/RoomEnvironment.js" {
  export class RoomEnvironment {}
}

declare module "three/examples/jsm/loaders/DRACOLoader.js" {
  export class DRACOLoader {
    setDecoderPath: (path: string) => void;
  }
}
