import { useEffect, useRef } from "react";
import GarageNavBar from "../components/GarageNavBar";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import sharedStyles from "../styles/Shared.module.css";
import styles from "../styles/GaragePortal.module.css";

const MODEL_URL = "/f1_garage2_compress.glb";
const cx = (...names: string[]) =>
  names
    .map((n) => styles[n] || sharedStyles[n])
    .filter(Boolean)
    .join(" ");

function GaragePortal() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let renderer: THREE.WebGLRenderer | null = null;
    let raf = 0;
    let settleFrames = 0;
    let scrollP = 0;
    let maxScroll = 1;
    let effectScroll = 1;

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
      const scrollAreaHeight =
        scrollAreaRef.current?.offsetHeight ?? window.innerHeight * 2.8;
      effectScroll = Math.max(1, Math.min(maxScroll, scrollAreaHeight));
    };
    const computeScrollProgress = () => {
      const clamped = Math.min(window.scrollY, effectScroll);
      return clamp01(clamped / Math.max(1, effectScroll));
    };

    // bg and mask materials
    const bgMat = new THREE.MeshBasicMaterial({
      color: 0xf4f6fb,
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
    let behindTargetOffset = 0.8;
    let cameraEndOffset = -0.1;

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
        loader.load(url, (gltf: { scene: THREE.Object3D }) => resolve(gltf.scene), undefined, reject)
      );

    const init = async () => {
      if (!containerRef.current) return;

      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        stencil: true,
      });
      if (!renderer) {
        return;
      }
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
          if (portalMask) {
            portalMask.matrixAutoUpdate = false;
            sceneMask.add(portalMask);
            portalIsStatic = true;
          }
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
          .addScaledVector(upDir, -0.01 * carMaxDim);
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
        const maxAngle = 0.85;
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
    <div className={cx("garage-page")}>
      <div className={cx("garage-scrollArea")} ref={scrollAreaRef} />

      <div className={cx("garage-hero")}>
        <div className={cx("garage-hero__canvas")} ref={containerRef} />
      </div>
      <GarageNavBar />
      <div className={cx("garage-scroll-hint")}>
        <span className={cx("hint-arrow")}>↓</span>
        <span>Scroll to enter</span>
      </div>
      <div className={cx("garage-intro-spacer")} />
      <main className={cx("garage-main")}>
        <div className={cx("garage-card")}>
          <div className={cx("garage-card__content")}>
            <section className={cx("garage-section")}>
              <h1>About this project</h1>
              <p className={cx("lead")}>
                Hello, this website is a personal data science laboratory where
                I experiment with Formula 1 data, telemetry, results, and race
                simulation. The goal is to represent publicly available data in
                ways that make a race easier to read, and to build a race
                simulator that is as precise as public data allows, so I can
                test strategies such as compound mixes and pit stop timings.
                And, as you saw earlier, useless 3D animation.
              </p>
            </section>
            <section className={cx("garage-section")}>
              <h2>Session explorer &amp; race replayer</h2>
              <p>
                Both pages are based on the same data source,{" "}
                <a href="https://openf1.org/" target="_blank" rel="noreferrer">
                  openf1.org
                </a>
                , which provides telemetry and historical race data from 2022
                onwards. I mirror that data into a local TimescaleDB for
                time-series telemetry and keep the rest of the records in
                Postgres. If it can help someone, a dump of the database with
                full data up to the end of 2025 is available{' '}
                <a href="/dumps/f1_db_no_telemetry.dump">here</a>.
              </p>
              <p>
                Each race telemetry set can reach ~250 MB, which is slow to
                download if you just want to see a trace. To speed things up, I
                precompute the speed trace for every lap of every race once and
                store it as an SVG in the app. Since the image is a single path
                with a fixed palette, the SVG can be optimized down to roughly 7
                KB while keeping good visual quality. If you are interested, you
                can download the 2025 trace set{' '}
                <a href="/dumps/track_speed_maps_2025.tar.gz">right here</a>.
              </p>
              <p>
                The race replayer needs the position of every driver at any
                moment. OpenF1 telemetry runs at ~3.3 Hz, and with 20 cars
                across a two-hour race, that is more than five million
                positions. For slower connections, the frontend first loads a
                downsampled version (one position every five seconds per driver)
                so you can start watching immediately, then it swaps in the
                full-resolution positions without interrupting playback. This
                keeps the initial download under a megabyte while still
                delivering smooth replay once the full data is in.
              </p>
            </section>
            <section className={cx("garage-section")}>
              <h2>Strategy lab · how it is built</h2>
              <p>
                The goal is to compare two strategies—pit timing and compound
                choices—by simulating a very large number of races (Monte Carlo)
                that are as realistic as public data allows. It is opinionated
                about speed vs. fidelity: it must answer “Strategy A vs B”
                questions quickly, while keeping each piece explainable.
                Everything runs in modular blocks so any component can be
                swapped or tuned without rewriting the whole thing.
              </p>
              <h3>Data and feature engineering</h3>
              <p>
                Public lap and timing data is cleaned into per-lap rows (one per
                driver per lap) and per-stint summaries. Core features include:
                categorical context (driver, team, circuit, year, session), tyre
                compound and age, fuel-load proxy (laps remaining), track
                evolution spline (lap progress), weather (air/track temp,
                humidity, pressure, wind, wet flag), and traffic signals (gap,
                DRS availability) for overtakes. Circuit/year medians and
                variances act as priors when data is sparse.
              </p>
              <h3>Model blocks (composed)</h3>
              <ul>
                <li>
                  Clean pace: context embeddings
                  (driver/team/circuit/year/session), fuel term, track evolution
                  spline, tyre age with a “knee,” weather adjustment, and a pull
                  toward global medians when data is thin.
                </li>
                <li>Traffic: gap-based slowdown that eases with DRS.</li>
                <li>
                  Pit loss: per-circuit mean/std with a floor and occasional
                  long tails.
                </li>
                <li>DNF: progress-based hazard over the race distance.</li>
                <li>
                  Safety car: probabilistic state machine changes that reshape
                  lap times.
                </li>
                <li>
                  Overtakes: attempts and time deltas driven by gap, tyre
                  advantage, and DRS, which can reorder the field.
                </li>
              </ul>
              <h3>Simulation loop</h3>
              <p>
                Each run takes two strategies, race length, optional SC/rain
                overrides, seeds, and noise. It builds lap-wise features (fuel,
                weather, track evolution), fills pit windows, and then steps
                through laps: apply SC/rain state, predict clean pace, add
                traffic effects, sample overtakes and DNFs, and apply pit stops
                with sampled loss before logging the lap. The focus is to stay
                close to real race dynamics while staying fast enough to run
                thousands of simulations.
              </p>
              <h3>Monte Carlo comparison, auto strategy, tuning</h3>
              <p>
                It runs many races with shared randomness so Strategy A vs B is
                fair. Results include win/podium rates, average finish,
                lap-by-lap averages, and SC frequencies, and can focus on one
                driver. Missing pit windows are filled from a circuit/year
                strategy library or evenly spaced defaults. Defaults favor
                speed, but you can tweak SC/rain laps, pit-loss variability,
                overtaking aggressiveness, and output detail to trade fidelity
                for runtime.
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

export default GaragePortal;
