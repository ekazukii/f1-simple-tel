import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";

const MODEL_URL = "/f1_garage2_compress.glb";

function GaragePortal() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let renderer: THREE.WebGLRenderer | null = null;
    let raf = 0;
    let settleFrames = 0;
    let scrollP = 0;
    let maxScroll = 1;

    // scenes and camera
    const scene3D = new THREE.Scene();
    const sceneBG = new THREE.Scene();
    const sceneMask = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50000);
    const camBG = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // helpers
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const remap01 = (p: number, a: number, b: number) =>
      p <= a ? 0 : p >= b ? 1 : (p - a) / (b - a);
    const easeInOut = (p: number) =>
      p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;

    const recomputeMaxScroll = () => {
      maxScroll = Math.max(
        1,
        document.documentElement.scrollHeight - window.innerHeight
      );
    };
    const computeScrollProgress = () =>
      clamp01(Math.min(window.scrollY, maxScroll) / maxScroll);

    // bg and mask materials
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0x0b0b0b,
      transparent: true,
      opacity: 1,
      depthTest: false,
      depthWrite: false,
    });
    bgMat.stencilWrite = true;
    bgMat.stencilRef = 1;
    bgMat.stencilFunc = THREE.NotEqualStencilFunc;
    bgMat.stencilFail = THREE.KeepStencilOp;
    bgMat.stencilZFail = THREE.KeepStencilOp;
    bgMat.stencilZPass = THREE.KeepStencilOp;
    sceneBG.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat));

    const maskMat = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    maskMat.stencilWrite = true;
    maskMat.stencilRef = 1;
    maskMat.stencilFunc = THREE.AlwaysStencilFunc;
    maskMat.stencilFail = THREE.KeepStencilOp;
    maskMat.stencilZFail = THREE.KeepStencilOp;
    maskMat.stencilZPass = THREE.ReplaceStencilOp;

    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(
      "https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/"
    );
    loader.setDRACOLoader(dracoLoader);

    const frontDir = new THREE.Vector3(-1, 0, 0);
    const upDir = new THREE.Vector3(0, 1, 0);
    const behindDir = frontDir.clone().negate();
    const sideDir = new THREE.Vector3()
      .crossVectors(upDir, frontDir)
      .normalize();
    const lateralOffset = -0.04;
    let behindTargetOffset = 0.2;
    let cameraEndOffset = -0.02;

    const lookMat = new THREE.Matrix4();
    const targetQuat = new THREE.Quaternion();
    const drsPosRaw = new THREE.Vector3();
    const drsPos = new THREE.Vector3();
    const behindTarget = new THREE.Vector3();
    const lateralVec = new THREE.Vector3();
    const carCenterOffset = new THREE.Vector3();
    const tmpPos = new THREE.Vector3();
    let lastFov = camera.fov;
    let worldRoot: THREE.Object3D | null = null;
    let carRoot: THREE.Object3D | null = null;
    let drsFlap: THREE.Object3D | null = null;
    let baseRot: THREE.Euler | null = null;
    let portalSource: THREE.Mesh | null = null;
    let portalMask: THREE.Mesh | null = null;
    let portalIsStatic = false;
    let curve: THREE.CatmullRomCurve3 | null = null;
    let carCenter = new THREE.Vector3();
    let carMaxDim = 1;

    const ancestors = (node: any) => {
      const list = [];
      let n = node;
      while (n) {
        list.push(n);
        n = n.parent;
      }
      return list;
    };
    const lowestCommonAncestor = (a: any, b: any) => {
      if (!a || !b) return null;
      const aAnc = new Set(ancestors(a));
      let n = b;
      while (n) {
        if (aAnc.has(n)) return n;
        n = n.parent;
      }
      return null;
    };
    const maxDimOf = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const s = box.getSize(new THREE.Vector3());
      return Math.max(s.x, s.y, s.z);
    };
    const pickCarRoot = (world: any, flap: any, portal: any) => {
      const named = world.getObjectByName("CAR_ROOT");
      if (named) return named;
      if (!flap) return world;
      let start = flap;
      if (portal) {
        const lca = lowestCommonAncestor(flap, portal);
        if (lca) start = lca;
      }
      let best = start;
      let prevDim = maxDimOf(best);
      const JUMP = 2.8;
      while (best.parent && best.parent !== world) {
        const parent = best.parent;
        const parentDim = maxDimOf(parent);
        if (parentDim > prevDim * JUMP) break;
        best = parent;
        prevDim = parentDim;
      }
      return best;
    };

    const requestRender = (framesToSettle = 0) => {
      settleFrames = Math.max(settleFrames, framesToSettle);
      if (raf) return;
      raf = requestAnimationFrame(renderOnce);
    };

    const onScroll = () => {
      scrollP = computeScrollProgress();
      requestRender(10);
    };

    const onResize = () => {
      recomputeMaxScroll();
      scrollP = computeScrollProgress();
      const w = window.innerWidth;
      const h = Math.max(window.innerHeight, 720);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer?.setSize(w, h);
      renderer?.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      requestRender(1);
    };

    const loadGLB = (url: string) =>
      new Promise<THREE.Object3D>((resolve, reject) =>
        loader.load(url, (gltf) => resolve(gltf.scene), undefined, reject)
      );

    const init = async () => {
      if (!containerRef.current) return;

      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        stencil: true,
      });
      const setRendererSize = () => {
        const w = window.innerWidth;
        const h = Math.max(window.innerHeight, 720);
        renderer!.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      setRendererSize();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.8;
      renderer.physicallyCorrectLights = true;
      renderer.domElement.style.position = "fixed";
      renderer.domElement.style.left = "0";
      renderer.domElement.style.top = "0";
      renderer.domElement.style.width = "100vw";
      renderer.domElement.style.height = "100vh";
      renderer.domElement.style.zIndex = "10";
      renderer.domElement.style.pointerEvents = "none";
      containerRef.current.appendChild(renderer.domElement);

      const pmrem = new THREE.PMREMGenerator(renderer);
      const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      scene3D.environment = envRT.texture;
      pmrem.dispose();

      camera.up.set(0, 1, 0);

      try {
        worldRoot = await loadGLB(MODEL_URL);
        scene3D.add(worldRoot);
        drsFlap = worldRoot.getObjectByName("DRS_FLAP") || null;
        if (drsFlap) baseRot = (drsFlap as any).rotation.clone();

        portalSource =
          (worldRoot.getObjectByName("DRS_PORTAL") as THREE.Mesh) || null;
        if (portalSource && portalSource.isMesh) {
          portalSource.visible = false;
          portalMask = new THREE.Mesh(portalSource.geometry, maskMat);
          portalMask.matrixAutoUpdate = false;
          sceneMask.add(portalMask);
          portalIsStatic = true;
        }

        carRoot = pickCarRoot(worldRoot, drsFlap, portalSource);
        const carBox = new THREE.Box3().setFromObject(carRoot);
        const carSize = carBox.getSize(new THREE.Vector3());
        carCenter = carBox.getCenter(new THREE.Vector3());
        carMaxDim = Math.max(carSize.x, carSize.y, carSize.z);

        lateralVec.copy(sideDir).multiplyScalar(lateralOffset * carMaxDim);
        carCenterOffset.copy(carCenter).add(lateralVec);

        if (drsFlap) drsFlap.getWorldPosition(drsPosRaw);
        else drsPosRaw.copy(carCenter);
        drsPos.copy(drsPosRaw).add(lateralVec);

        behindTarget
          .copy(drsPos)
          .addScaledVector(behindDir, behindTargetOffset * carMaxDim)
          .addScaledVector(upDir, 0.03 * carMaxDim);

        const p0 = carCenterOffset
          .clone()
          .addScaledVector(frontDir, 1.4 * carMaxDim)
          .addScaledVector(upDir, 0.15 * carMaxDim);
        const p1 = carCenterOffset
          .clone()
          .addScaledVector(frontDir, 0.75 * carMaxDim)
          .addScaledVector(upDir, 0.35 * carMaxDim);
        const p2 = drsPos
          .clone()
          .addScaledVector(frontDir, 0.35 * carMaxDim)
          .addScaledVector(upDir, 0.15 * carMaxDim);
        const p25 = drsPos
          .clone()
          .addScaledVector(frontDir, 0.15 * carMaxDim)
          .addScaledVector(upDir, 0.0 * carMaxDim);
        const p3 = drsPos
          .clone()
          .addScaledVector(behindDir, cameraEndOffset * carMaxDim)
          .addScaledVector(upDir, -0.02 * carMaxDim);
        curve = new THREE.CatmullRomCurve3(
          [p0, p1, p2, p25, p3],
          false,
          "centripetal"
        );

        camera.position.copy(p0);
        lookMat.lookAt(camera.position, behindTarget, upDir);
        targetQuat.setFromRotationMatrix(lookMat);
        camera.quaternion.copy(targetQuat);

        const worldDim = maxDimOf(worldRoot);
        camera.near = Math.max(carMaxDim / 500, 0.01);
        camera.far = Math.max(carMaxDim * 200, worldDim * 200);
        camera.updateProjectionMatrix();

        if (portalSource && portalMask) {
          portalSource.updateWorldMatrix(true, false);
          portalMask.matrix.copy(portalSource.matrixWorld);
        }
      } catch (err) {
        console.error("Failed to load GLB", err);
      }

      recomputeMaxScroll();
      scrollP = computeScrollProgress();
      requestRender(1);
    };

    const updateFromProgress = (p: number) => {
      const pReveal = easeInOut(remap01(p, 0.84, 0.95));
      const canvasAlpha = 1 - pReveal;
      if (renderer) renderer.domElement.style.opacity = String(canvasAlpha);
      bgMat.opacity = canvasAlpha;
      if (!curve) return;

      const pCam = easeInOut(remap01(p, 0.0, 1.0));
      curve.getPointAt(pCam, tmpPos);
      camera.position.copy(tmpPos);

      if (drsFlap) drsFlap.getWorldPosition(drsPosRaw);
      else drsPosRaw.copy(carCenter);
      drsPos.copy(drsPosRaw).add(lateralVec);

      behindTarget
        .copy(drsPos)
        .addScaledVector(behindDir, behindTargetOffset * carMaxDim)
        .addScaledVector(upDir, 0.03 * carMaxDim);

      lookMat.lookAt(camera.position, behindTarget, upDir);
      targetQuat.setFromRotationMatrix(lookMat);
      camera.quaternion.slerp(targetQuat, 0.22);

      const pFov = easeInOut(remap01(p, 0.7, 1.0));
      const newFov = THREE.MathUtils.lerp(45, 30, pFov);
      if (Math.abs(newFov - lastFov) > 0.001) {
        camera.fov = newFov;
        camera.updateProjectionMatrix();
        lastFov = newFov;
      }

      if (drsFlap && baseRot) {
        const pDRS = easeInOut(remap01(p, 0.45, 0.85));
        const maxAngle = 0.65;
        drsFlap.rotation.set(baseRot.x, baseRot.y + maxAngle * pDRS, baseRot.z);
      }

      if (portalSource && portalMask && !portalIsStatic) {
        portalSource.updateWorldMatrix(true, false);
        portalMask.matrix.copy(portalSource.matrixWorld);
      }
    };

    const renderOnce = () => {
      raf = 0;
      updateFromProgress(scrollP);
      renderer?.clear(true, true, true);
      if (portalMask) renderer?.render(sceneMask, camera);
      renderer?.render(sceneBG, camBG);
      renderer?.render(scene3D, camera);

      settleFrames -= 1;
      const angleLeft = camera.quaternion.angleTo(targetQuat);
      const needsMore = angleLeft > 0.0008;
      if (settleFrames > 0 || needsMore) requestRender(0);
    };

    init();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
      if (renderer) {
        renderer.dispose();
        if (renderer.domElement.parentElement)
          renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="garage-page">
      <div className="garage-scrollArea" />
      <div className="garage-hero">
        <div className="garage-hero__canvas" ref={containerRef} />
      </div>
      <div className="garage-scroll-hint">
        <span className="hint-arrow">↓</span>
        <span>Scroll to enter</span>
      </div>
      <main className="garage-main">
        <div className="garage-card">
          <h1>Garage Portal</h1>
          <p className="lead">
            The page lives beneath the canvas — you glimpse it through the DRS portal, then the canvas fades away near
            the end of the scroll.
          </p>
        </div>
        <div className="garage-card">
          <h2>What you’re seeing</h2>
          <p>
            The 3D scene is loaded lazily from the GLTF model{" "}
            <code>f1_garage2_compress.glb</code> (DRACO-compressed). Camera position interpolates with scroll, and
            lights/PMREM give a clean studio look.
          </p>
        </div>
        <div className="garage-card">
          <h2>How to extend</h2>
          <p>
            Replace the GLB with any car/garage, or hook in live telemetry to drive camera targets. The stencil portal
            keeps HTML visible only through the flap until the fade finishes.
          </p>
        </div>
        <div className="garage-card">
          <h2>Next steps</h2>
          <p>Use this portal to intro your dashboards: the HTML shows through the flap until the canvas fully fades.</p>
        </div>
      </main>
    </div>
  );
}

export default GaragePortal;
