import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Loader2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from './Button';
import { getAuthToken } from '../api/client';

import type { Parsed3MFData, StepMeshData } from '../lib/meshLoaders';
import { buildModelGroup, buildStepGroup, disposeGroup, parse3MF, parseStepInWorker } from '../lib/meshLoaders';

const MAX_ZOOM_OUT = 8;

/**
 * Frame the camera on a bounding box.
 *
 * The previous heuristic was `maxDim * 1.8`, which ignores both the camera's
 * field of view and the viewport's aspect ratio. In a tall, narrow panel the
 * horizontal field of view is much narrower than the vertical one, so that
 * distance pushed the model into the middle of the frame with a screenful of
 * empty space above it. Solving the distance from the bounding *sphere*
 * against both fields of view fills the frame at any viewport shape.
 */
function fitCameraToBox(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  box: THREE.Box3,
  plateDiagonal: number,
  padding = 1.15,
): void {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Circumscribed sphere: conservative, so the model never crops on rotation.
  const radius = Math.max(size.length() / 2, 0.001);

  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distance = padding * Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2));

  // Keep the established three-quarter view; only the distance changes.
  const direction = new THREE.Vector3(0.7, 0.5, 0.7).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);

  // Zoom range relative to the framed distance. Without the upper bound the
  // wheel dollied straight through the far plane: five or six notches out and
  // the model, plate and grid all vanished, which reads as "zoom is broken".
  controls.minDistance = Math.max(radius * 0.05, 0.05);
  controls.maxDistance = distance * MAX_ZOOM_OUT;

  // Clip planes scaled to the subject, so a small model doesn't z-fight and a
  // large one isn't sliced by the far plane. The far plane has to cover the
  // whole dolly range plus the plate, whose diagonal dwarfs a small model.
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = controls.maxDistance + radius * 4 + plateDiagonal;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

// Module-level so the default keeps its identity: an inline default object is
// new on every render and, as an effect dependency, would rebuild the whole
// scene each time the component re-renders.
const DEFAULT_BUILD_VOLUME: BuildVolume = { x: 256, y: 256, z: 256 };

interface ModelViewerProps {
  url: string;
  fileType?: string;
  buildVolume?: BuildVolume;
  filamentColors?: string[];
  selectedPlateId?: number | null;
  className?: string;
  /** Called once with a 256px PNG of the first render — used by the file
   * manager to persist a thumbnail for formats the server cannot render
   * itself (STEP, #2976). */
  onSnapshot?: (blob: Blob) => void;
}


export function ModelViewer({
  url,
  fileType,
  buildVolume = DEFAULT_BUILD_VOLUME,
  filamentColors,
  selectedPlateId = null,
  className = '',
  onSnapshot,
}: ModelViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  // Held so the environment map and its generator can be released on unmount;
  // a PMREM render target is GPU memory the garbage collector cannot reclaim.
  const pmremRef = useRef<THREE.PMREMGenerator | null>(null);
  const environmentRef = useRef<THREE.Texture | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const shadowCatcherRef = useRef<THREE.Mesh | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const modelGroupRef = useRef<THREE.Group | null>(null);
  const plateRef = useRef<THREE.Mesh | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  // The last framed bounds, so Reset returns to the framed view rather than
  // a fixed camera pose that ignores where the model was placed.
  const fitBoxRef = useRef<THREE.Box3 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<Parsed3MFData | null>(null);
  const [stlGeometry, setStlGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [stepMeshes, setStepMeshes] = useState<StepMeshData[] | null>(null);
  // Seconds spent converting a STEP file. A large export can take over a
  // minute in the OpenCascade worker, and a bare spinner for that long reads
  // as "nothing is happening" - so STEP loads say what they are doing and
  // show that time is passing.
  const [stepLoadSeconds, setStepLoadSeconds] = useState(0);
  const loadingType = (fileType || url.split('?')[0].split('.').pop() || '').toLowerCase();
  const isStepFile = loadingType === 'step' || loadingType === 'stp';
  useEffect(() => {
    if (!loading || !isStepFile) return;
    setStepLoadSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setStepLoadSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading, isStepFile]);
  // Snapshot is a one-shot per loaded url; the callback lives in a ref so its
  // identity never retriggers the (expensive) scene effects.
  const snapshotSentRef = useRef(false);
  const onSnapshotRef = useRef(onSnapshot);
  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  });

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    camera.position.set(150, 150, 150);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    // Cap the device pixel ratio: a 3x phone screen quadruples the fragment
    // load for no visible gain on a model this simple.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Filmic tone mapping keeps the bright side of a saturated filament colour
    // from clipping to white, which is what made every model read as flat paint.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Deliberately below 1.0: RoomEnvironment is a bright white box, and
    // anything at or above unity clipped the lit side of a saturated
    // filament colour to white, draining the hue out of the model.
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    // Image-based lighting. A generated room gives the model a real light
    // environment -- soft gradients across curved surfaces, a hint of
    // reflection -- which is the single biggest difference between this and a
    // desktop slicer's viewport. Two directional lights on flat ambient could
    // never produce that; every surface facing the same way got the same
    // colour, so the model read as a flat silhouette.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = environment.texture;
    pmremRef.current = pmrem;
    environmentRef.current = environment.texture;

    // One key light on top, purely for the contact shadow and a highlight
    // direction; the environment supplies the fill.
    // Mostly overhead. An oblique key threw a long shadow across the whole
    // bed; a print sitting on a plate wants a contact shadow beneath it.
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.75);
    keyLight.position.set(60, 260, 90);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    // Three's default shadow camera is a +/-5 unit box; on a 256mm bed the
    // model falls entirely outside it and no shadow is drawn at all.
    const shadowExtent = Math.max(buildVolume.x, buildVolume.y) * 0.75;
    keyLight.shadow.camera.left = -shadowExtent;
    keyLight.shadow.camera.right = shadowExtent;
    keyLight.shadow.camera.top = shadowExtent;
    keyLight.shadow.camera.bottom = -shadowExtent;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = shadowExtent * 6;
    keyLight.shadow.camera.updateProjectionMatrix();
    scene.add(keyLight);
    keyLightRef.current = keyLight;

    // Grid - use the larger dimension for the grid size
    const gridSize = Math.max(buildVolume.x, buildVolume.y);
    const gridDivisions = Math.ceil(gridSize / 16);
    const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x444444, 0x333333);
    scene.add(gridHelper);
    gridRef.current = gridHelper;

    // Build plate indicator
    const plateGeometry = new THREE.PlaneGeometry(buildVolume.x, buildVolume.y);
    const plateMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ae42,
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
    });
    const plate = new THREE.Mesh(plateGeometry, plateMaterial);
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.5; // Slightly below Y=0 so models sit on top
    scene.add(plate);
    plateRef.current = plate;

    // Dedicated shadow catcher just above the plate. The plate itself is an
    // unlit MeshBasicMaterial and cannot receive shadows; ShadowMaterial draws
    // nothing but the shadow, so the tinted plate shows through unchanged.
    // Without a contact shadow the model reads as pasted onto the background
    // rather than resting on the bed.
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(buildVolume.x, buildVolume.y),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.49;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);
    shadowCatcherRef.current = shadowCatcher;

    // Animation loop - keep it simple for reliability
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    setLoading(true);
    setError(null);
    setParsedData(null);
    setStlGeometry(null);
    setStepMeshes(null);
    snapshotSentRef.current = false;

    const normalizedType = (fileType || url.split('?')[0].split('.').pop() || '').toLowerCase();

    // Build auth headers for fetch
    const headers: HeadersInit = {};
    const token = getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (normalizedType === 'stl') {
      fetch(url, { headers })
        .then((res) => {
          if (!res.ok) throw new Error(t('modelViewer.errors.failedToLoad'));
          return res.arrayBuffer();
        })
        .then((buffer) => {
          const loader = new STLLoader();
          const geometry = loader.parse(buffer);
          geometry.computeVertexNormals();
          geometry.rotateX(-Math.PI / 2);
          setStlGeometry(geometry);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    } else if (normalizedType === '3mf') {
      fetch(url, { headers })
        .then((res) => {
          if (!res.ok) throw new Error(t('modelViewer.errors.failedToLoad'));
          return res.arrayBuffer();
        })
        .then(parse3MF)
        .then((parsed) => {
          if (parsed.objects.size === 0) {
            throw new Error(t('modelViewer.errors.noMeshes'));
          }
          setParsedData(parsed);
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    } else if (normalizedType === 'step' || normalizedType === 'stp') {
      // STEP has no three.js loader; triangulation happens in the dedicated
      // OpenCascade worker (#2976), off the UI thread.
      fetch(url, { headers })
        .then((res) => {
          if (!res.ok) throw new Error(t('modelViewer.errors.failedToLoad'));
          return res.arrayBuffer();
        })
        .then(parseStepInWorker)
        .then(setStepMeshes)
        .catch((err: Error) => {
          // Worker rejections carry machine reasons; everything else already
          // is a translated message from the fetch step above.
          const message = err.message === 'no-meshes'
            ? t('modelViewer.errors.noMeshes')
            : err.message === 'error'
              ? t('modelViewer.errors.failedToLoad')
              : err.message;
          setError(message);
          setLoading(false);
        });
    } else {
      setError(t('modelViewer.errors.unsupportedFormat'));
      setLoading(false);
    }

    // Handle resize (window + container)
    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);
    // Entering or leaving fullscreen resizes the container too; the observer
    // catches that, but only after layout — resizing on the event itself
    // avoids one frame drawn at the old aspect.
    document.addEventListener('fullscreenchange', handleResize);
    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('fullscreenchange', handleResize);
      resizeObserver.disconnect();
      cancelAnimationFrame(animationId);
      controls.dispose();
      // The environment map is a render target; disposing the renderer alone
      // leaves it allocated on the GPU, and this viewer is opened and closed
      // repeatedly from the file manager.
      environmentRef.current?.dispose();
      environmentRef.current = null;
      pmremRef.current?.dispose();
      pmremRef.current = null;
      scene.environment = null;
      renderer.dispose();
      container.removeChild(renderer.domElement);
      modelGroupRef.current = null;
      plateRef.current = null;
      gridRef.current = null;
      keyLightRef.current = null;
      shadowCatcherRef.current = null;
    };
  }, [url, buildVolume, fileType, t]);

  useEffect(() => {
    if (!sceneRef.current || !cameraRef.current || !controlsRef.current) return;
    if (!parsedData && !stlGeometry && !stepMeshes) return;

    if (modelGroupRef.current) {
      sceneRef.current.remove(modelGroupRef.current);
      disposeGroup(modelGroupRef.current);
    }

    // STL and STEP are plain single models with no plate/build-item layout;
    // they share the same centre-on-plate placement below.
    const isPlainModel = !!stlGeometry || !!stepMeshes;
    const group = stlGeometry
      ? (() => {
          const materialColor = filamentColors?.[0] || '#00ae42';
          const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(materialColor),
            roughness: 0.62,
            metalness: 0.0,
            envMapIntensity: 0.55,
          });
          const mesh = new THREE.Mesh(stlGeometry, material);
          mesh.castShadow = true;
          const stlGroup = new THREE.Group();
          stlGroup.add(mesh);
          return stlGroup;
        })()
      : stepMeshes
        ? buildStepGroup(stepMeshes, filamentColors)
        : buildModelGroup(parsedData!, selectedPlateId ?? null, filamentColors);
    modelGroupRef.current = group;
    sceneRef.current.add(group);

    // Get bounding box to position model
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());

    // Always place models on the build plate (Y=0)
    group.position.y = -box.min.y;

    const selectedPlateBounds = (!isPlainModel && selectedPlateId != null && parsedData!.buildItems.length > 0)
      ? parsedData!.plateBounds.get(selectedPlateId)
      : undefined;
    const selectedPlateOffset = (!isPlainModel && selectedPlateId != null)
      ? parsedData!.plateOffsets.get(selectedPlateId)
      : undefined;
    const shouldCenterOnPlate = isPlainModel
      || parsedData!.buildItems.length === 0
      || (selectedPlateId != null && !selectedPlateBounds && !selectedPlateOffset);
    const centerOffsetX = shouldCenterOnPlate ? -center.x : 0;
    const centerOffsetZ = shouldCenterOnPlate ? -center.z : 0;

    let plateOffsetX = 0;
    let plateOffsetZ = 0;
    if (!isPlainModel && selectedPlateId != null && parsedData!.buildItems.length > 0 && selectedPlateBounds) {
      const plateBox = new THREE.Box3().setFromObject(group);
      plateOffsetX = plateBox.min.x - selectedPlateBounds.minX;
      plateOffsetZ = plateBox.min.z - selectedPlateBounds.minY;
    }

    const plateCenterX = buildVolume.x / 2;
    const plateCenterZ = buildVolume.y / 2;

    if (!isPlainModel && selectedPlateId != null && parsedData!.buildItems.length > 0 && selectedPlateBounds) {
      group.position.x = centerOffsetX - plateOffsetX;
      group.position.z = centerOffsetZ - plateOffsetZ;
    } else if (!isPlainModel && selectedPlateId != null && selectedPlateOffset) {
      group.position.x = centerOffsetX + (plateCenterX - selectedPlateOffset.offsetX);
      group.position.z = centerOffsetZ + (plateCenterZ - selectedPlateOffset.offsetY);
    } else if (shouldCenterOnPlate) {
      group.position.x = centerOffsetX + plateCenterX;
      group.position.z = centerOffsetZ + plateCenterZ;
    } else {
      group.position.x = centerOffsetX;
      group.position.z = centerOffsetZ;
    }

    if (plateRef.current) {
      plateRef.current.position.x = plateCenterX;
      plateRef.current.position.z = plateCenterZ;
    }

    if (gridRef.current) {
      gridRef.current.position.x = plateCenterX;
      gridRef.current.position.z = plateCenterZ;
    }

    // Follows the plate, or the shadow lands on empty space beside the bed.
    if (shadowCatcherRef.current) {
      shadowCatcherRef.current.position.x = plateCenterX;
      shadowCatcherRef.current.position.z = plateCenterZ;
    }

    // Recalculate bounding box after positioning
    const finalBox = new THREE.Box3().setFromObject(group);

    // Adjust camera to fit model
    fitBoxRef.current = finalBox;
    fitCameraToBox(cameraRef.current, controlsRef.current, finalBox, Math.hypot(buildVolume.x, buildVolume.y));

    setLoading(false);

    // One-shot snapshot of the first framed render (#2976). Rendering
    // explicitly right before reading the canvas keeps the WebGL buffer
    // valid without preserveDrawingBuffer.
    if (onSnapshotRef.current && !snapshotSentRef.current) {
      snapshotSentRef.current = true;
      requestAnimationFrame(() => {
        const renderer = rendererRef.current;
        const scene = sceneRef.current;
        const camera = cameraRef.current;
        if (!renderer || !scene || !camera) return;
        try {
          renderer.render(scene, camera);
          const source = renderer.domElement;
          const size = 256;
          const side = Math.min(source.width, source.height);
          const target = document.createElement('canvas');
          target.width = size;
          target.height = size;
          const ctx = target.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, size, size);
          target.toBlob((blob) => {
            if (blob) onSnapshotRef.current?.(blob);
          }, 'image/png');
        } catch {
          // Snapshot is best-effort; the preview itself already rendered.
        }
      });
    }
  }, [parsedData, stlGeometry, stepMeshes, selectedPlateId, filamentColors, buildVolume]);

  const resetView = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    if (fitBoxRef.current) {
      fitCameraToBox(camera, controls, fitBoxRef.current, Math.hypot(buildVolume.x, buildVolume.y));
    } else {
      camera.position.set(150, 150, 150);
      controls.target.set(0, 50, 0);
      controls.update();
    }
  };

  // Dolly along the view axis, like the wheel. Scaling the camera position
  // itself measured from the world origin, not from the orbit target at the
  // plate centre, so each press also slid the model sideways.
  const zoom = (factor: number) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const offset = camera.position.clone().sub(controls.target);
    const distance = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() * factor));
    camera.position.copy(controls.target).addScaledVector(offset.normalize(), distance);
    controls.update();
  };

  return (
    <div className={`relative ${className}`}>
      <div ref={containerRef} className="w-full h-full min-h-[400px]" />

      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bambu-dark/80 px-6 text-center">
          <Loader2 className="w-8 h-8 text-bambu-green animate-spin" />
          {isStepFile && (
            <div role="status" className="space-y-1">
              <p className="text-sm text-white tabular-nums">
                {t('modelViewer.stepConverting', { seconds: stepLoadSeconds })}
              </p>
              <p className="text-xs text-bambu-gray">{t('modelViewer.stepSlowHint')}</p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-bambu-dark/80">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="absolute bottom-4 right-4 flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => zoom(0.8)}>
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={() => zoom(1.25)}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <Button variant="secondary" size="sm" onClick={resetView}>
            <RotateCcw className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
