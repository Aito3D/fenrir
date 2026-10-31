import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { getAuthToken } from '../../api/client';
import { buildStepGroup, createGeometryFromMesh, disposeGroup, parse3MF, parseStepInWorker } from '../../lib/meshLoaders';
import type { Parsed3MFData } from '../../lib/meshLoaders';
import { filterLayersByType, layersByFilament, parseGcodeToolpath } from '../../lib/gcodeToolpath';
import type { ParsedToolpath } from '../../lib/gcodeToolpath';
import { buildSegmentData, computeColors, makeToolpath } from '../../lib/vendor/toolpathRenderer.js';
import { clearThinWalls, measureThinWalls, overhangShare } from './partAnalysis';
import type { GcodeWorkerRequest, GcodeWorkerResponse } from '../../workers/gcodeParse.worker';
import type { RenderPrefs, SceneView, VisualStyle } from './viewerLink';
import type { ToolpathHandle } from '../../lib/vendor/toolpathRenderer.js';
import type { BuildVolume } from './printerBeds';

/**
 * The part viewer's one WebGL scene, shared by the Model and Toolpath tabs so the camera, the
 * view cube, the bed and the tools never change under the user's hands when switching tabs.
 *
 * Coordinates follow the slicer: printer X to the right, printer Y towards the BACK of the bed,
 * Z up — mapped to three.js as (x, z, -y). The toolpath renderer already draws that way (a
 * -90° turn about X); STL and STEP are turned the same way; the shared 3MF loader swaps
 * printer Y and Z (a reflection), so its geometry is mirrored in Z once more here, which makes
 * the pair a proper rotation with outward normals. The bed spans x∈[0,X], z∈[-Y,0]; its
 * front-left corner is the origin,
 * where the printer's axes and the view cube's triad start.
 */

export interface PartObject {
  index: number;
  name: string;
  triangles: number;
  /** Printer millimetres: X, Y (depth), Z (height). */
  size: [number, number, number];
  color: string;
}

export interface PartBounds {
  /** Printer coordinates. */
  min: [number, number, number];
  max: [number, number, number];
}

export interface ToolpathStats {
  layerCount: number;
  /** Share of extrusion length per toolpath type (index = type). */
  typeShares: number[];
  zPerLayer: number[];
  /** Remaining print time at each layer's end from the slicer's progress marks (null without them). */
  remainingPerLayer: Array<number | null>;
  /** Extruding segments per layer: the fallback weight when the file carries no progress marks. */
  segmentsPerLayer: number[];
}

export interface AnalysisState {
  overhang: { on: boolean; deg: number };
  thinWalls: { on: boolean; mm: number };
}

export interface AnalysisResult {
  overhangShare: number | null;
  thinWalls: { share: number; sampled: number } | null;
}

export interface Pin {
  id: number;
  /** Printer millimetres. */
  x: number;
  y: number;
  z: number;
  text: string;
}

export interface SectionState {
  on: boolean;
  axis: 'x' | 'y' | 'z';
  /** 0..100 along the model's extent on that axis. */
  pct: number;
}

export interface PartSceneProps {
  tab: 'model' | 'toolpath';
  model: { url: string; fileType: string } | null;
  toolpath: { url: string } | null;
  buildVolume: BuildVolume;
  filamentColors: string[];
  selectedPlateId: number | null;
  /** Names for the model's objects, in build order (the plate metadata's list). */
  objectNames: string[];
  layerRange: [number, number];
  hiddenFeatures: ReadonlySet<number>;
  colorMode: 'feature' | 'filament';
  hoverIndex: number | null;
  isolatedIndex: number | null;
  tool: 'none' | 'measure' | 'pin';
  pins: Pin[];
  section: SectionState;
  dims: boolean;
  xray: boolean;
  grid: boolean;
  ortho: boolean;
  turntable: boolean;
  /** Another revision's model, drawn as an amber wireframe ghost over this one. */
  compareUrl: string | null;
  /** Fusion-style visual style: shaded, with feature edges, with hidden edges too, or edges only. */
  style: VisualStyle;
  /** Overhang shading and thin-wall tint (the Display menu's analysis section). */
  analysis: AnalysisState;
  /** 0..1: how far the objects slide apart from the plate's centre (proposition 5). */
  explode: number;
  /** Shadows, ambient occlusion, finish, reflections, background. */
  render: RenderPrefs;
  onAnalysis: (result: AnalysisResult) => void;
  onHover: (index: number | null) => void;
  onIsolate: (index: number) => void;
  onObjects: (objects: PartObject[], bounds: PartBounds | null) => void;
  onToolpathStats: (stats: ToolpathStats | null) => void;
  onMeasure: (mm: number | null) => void;
  onPlacePin: (point: [number, number, number]) => void;
  onStatus: (status: ViewerStatus) => void;
  /** Called once with a 256px PNG of the first framed render (the file manager's STEP thumbnail). */
  onSnapshot?: (blob: Blob) => void;
  className?: string;
}

export interface PartSceneHandle {
  fit: () => void;
  goTo: (dir: [number, number, number]) => void;
  orbit: (dTheta: number, dPhi: number) => void;
  getView: () => { dir: [number, number, number]; up: [number, number, number] } | null;
  /** The camera as a link carries it, and its restoration (no re-framing). */
  getSceneView: () => SceneView | null;
  setSceneView: (view: SceneView) => void;
  /** The current frame as a PNG; `size` crops to a centred square of that many pixels. */
  snapshot: (size?: number) => Promise<Blob | null>;
}

const ISO: [number, number, number] = [1, 0.85, 1];
const MAX_ZOOM_OUT = 8;
const AXES: Array<{ dir: [number, number, number]; color: string }> = [
  { dir: [1, 0, 0], color: '#ef5350' },
  { dir: [0, 0, -1], color: '#4cd964' },
  { dir: [0, 1, 0], color: '#4a9cff' },
];
const HIGHLIGHT = new THREE.Color('#14b8a6');
/** Triangles per mesh above which feature-edge overlays are skipped (cost and speckle). */
const EDGE_BUDGET = 300_000;
const BLACK = new THREE.Color('#000000');

/** Printer coordinates of a world point (x, z, -y). */
const toPrinter = (v: THREE.Vector3): [number, number, number] => [v.x, -v.z, v.y];
const fromPrinter = (p: [number, number, number]) => new THREE.Vector3(p[0], p[2], -p[1]);

function safeDir(d: [number, number, number]): THREE.Vector3 {
  const v = new THREE.Vector3(...d).normalize();
  // Straight up or down: nudge so the camera's up vector is never parallel to the view.
  if (Math.abs(v.y) > 0.999) v.z = v.y > 0 ? -0.0001 : 0.0001;
  return v.normalize();
}

/** What the modal shows over the canvas: a download with its share (null until the size is
 *  known), then the parse ('prepare'), then nothing. */
export interface ViewerStatus {
  loading: boolean;
  error: 'webgl' | 'load' | 'unsupported' | 'noMeshes' | null;
  stage?: 'download' | 'prepare' | 'parse';
  progress?: number | null;
}

/** Reads the body as it arrives so the overlay can show how far the download is. */
async function fetchBytes(url: string, onProgress: (share: number | null) => void): Promise<Uint8Array> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error('load');
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(total ? 0 : null);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(total ? Math.min(1, loaded / total) : null);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Parses the G-code off the main thread (a worker, when the platform has one), reporting the
 *  share of lines read; falls back to the synchronous parse elsewhere (tests, old browsers). */
let gcodeWorker: Worker | null = null;
let gcodeRequestId = 0;
function parseToolpathOffThread(text: string, onProgress: (share: number) => void): Promise<ParsedToolpath> {
  if (typeof Worker === 'undefined') return Promise.resolve(parseGcodeToolpath(text, onProgress));
  return new Promise((resolve, reject) => {
    const id = ++gcodeRequestId;
    try {
      gcodeWorker ??= new Worker(new URL('../../workers/gcodeParse.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(parseGcodeToolpath(text, onProgress));
      return;
    }
    const worker = gcodeWorker;
    const onMessage = (event: MessageEvent<GcodeWorkerResponse>) => {
      if (event.data.id !== id) return;
      if (event.data.type === 'progress') onProgress(event.data.share);
      else {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (event.data.type === 'done') resolve(event.data.parsed);
        else reject(new Error(event.data.reason));
      }
    };
    const onError = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.terminate();
      if (gcodeWorker === worker) gcodeWorker = null;
      // The worker died (memory, a blocked script): parse here instead.
      resolve(parseGcodeToolpath(text, onProgress));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const request: GcodeWorkerRequest = { id, text };
    worker.postMessage(request);
  });
}

function authHeaders(): HeadersInit {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The filament's colour as the part is drawn: a black or near-black filament is lifted to a
 *  dark grey (as the slicer draws it), or its shape vanishes against the dark scene. */
function displayColor(color: string): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l < 0.2) c.setHSL(hsl.h, Math.min(hsl.s, 0.25), 0.24);
  return c;
}

/** One set of uniforms for every part material: the overhang and thin-wall tints are scene-wide. */
const ANALYSIS_UNIFORMS = {
  uOverhang: { value: 0 },
  uOverhangDeg: { value: 45 },
  uThin: { value: 0 },
};

/** The part's material, with the analysis tints compiled in: an overhang ramp (amber to red
 *  past the angle, skipping the first layer on the bed) and the `thin` vertex attribute. */
function material(color: string): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: displayColor(color), roughness: 0.55, metalness: 0, envMapIntensity: 0.45 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ANALYSIS_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float thin;\nvarying vec3 vWorldN;\nvarying vec3 vWorldP;\nvarying float vThin;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldN = normalize(mat3(modelMatrix) * objectNormal);\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvThin = thin;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uOverhang;\nuniform float uOverhangDeg;\nuniform float uThin;\nvarying vec3 vWorldN;\nvarying vec3 vWorldP;\nvarying float vThin;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 wn = normalize(vWorldN) * (gl_FrontFacing ? 1.0 : -1.0);
          float ovDeg = degrees(asin(clamp(-wn.y, 0.0, 1.0)));
          float ov = uOverhang * step(0.3, vWorldP.y) * clamp((ovDeg - (uOverhangDeg - 15.0)) / 15.0, 0.0, 1.0);
          vec3 warn = mix(vec3(0.98, 0.72, 0.2), vec3(0.92, 0.24, 0.24), smoothstep(0.5, 1.0, ov));
          diffuseColor.rgb = mix(diffuseColor.rgb, warn, ov);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.24, 0.24), clamp(vThin, 0.0, 1.0) * uThin);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'part-analysis';
  return mat;
}

/** Feature-edge overlays (visual styles, X-ray) are cached per threshold on the mesh. */
function edgesFor(mesh: THREE.Mesh, threshold: number): THREE.EdgesGeometry {
  const cache = (mesh.userData.edgeCache ??= new Map<number, THREE.EdgesGeometry>()) as Map<number, THREE.EdgesGeometry>;
  let geo = cache.get(threshold);
  if (!geo) {
    geo = new THREE.EdgesGeometry(mesh.geometry, threshold);
    cache.set(threshold, geo);
  }
  return geo;
}

/** The mesh's triangle edges (the "polygons" style), cached on the mesh. */
function polygonsFor(mesh: THREE.Mesh): THREE.WireframeGeometry {
  let geo = mesh.userData.wireCache as THREE.WireframeGeometry | undefined;
  if (!geo) {
    geo = new THREE.WireframeGeometry(mesh.geometry);
    mesh.userData.wireCache = geo;
  }
  return geo;
}

function disposeOverlays(group: THREE.Group) {
  group.traverse((o) => {
    const cache = o.userData.edgeCache as Map<number, THREE.EdgesGeometry> | undefined;
    if (cache) {
      for (const g of cache.values()) g.dispose();
      cache.clear();
    }
    const wire = o.userData.wireCache as THREE.WireframeGeometry | undefined;
    if (wire) {
      wire.dispose();
      delete o.userData.wireCache;
    }
    if (o.userData.overlay) ((o as THREE.LineSegments).material as THREE.Material).dispose();
  });
}

/** One mesh per build item (not merged per extruder as the file manager's viewer does), so an
 *  object can be hovered, isolated and measured on its own. Plate filtering as ModelViewer. */
function buildObjectGroup(parsed: Parsed3MFData, selectedPlateId: number | null, colors: string[], names: string[]): { group: THREE.Group; objects: PartObject[] } {
  const group = new THREE.Group();
  const objects: PartObject[] = [];
  const hasPlates = parsed.buildItems.some((item) => item.plateId != null);
  const filtered = selectedPlateId == null || !hasPlates ? parsed.buildItems : parsed.buildItems.filter((item) => item.plateId === selectedPlateId);
  const items = filtered.length > 0 ? filtered : parsed.buildItems;
  const sources = items.length > 0 ? items.map((item) => ({ item, object: parsed.objects.get(item.objectId) })) : [...parsed.objects.values()].map((object) => ({ item: null, object }));
  let index = 0;
  for (const { item, object } of sources) {
    if (!object) continue;
    const objectGroup = new THREE.Group();
    let triangles = 0;
    let extruder = object.defaultExtruder;
    for (const meshData of object.meshes) {
      extruder = item?.extruder ?? meshData.extruder;
      let vertices = meshData.vertices;
      if (item) {
        vertices = [];
        const v = new THREE.Vector3();
        for (let k = 0; k < meshData.vertices.length; k += 3) {
          v.set(meshData.vertices[k], meshData.vertices[k + 1], meshData.vertices[k + 2]).applyMatrix4(item.transform);
          vertices.push(v.x, v.y, v.z);
        }
      }
      const geometry = createGeometryFromMesh({ vertices, triangles: meshData.triangles, extruder });
      // The shared loader swaps printer Y and Z (a reflection); mirroring Z turns that into the
      // slicer frame (x, z, -y) — a proper rotation, so winding and normals come out outward.
      geometry.scale(1, 1, -1);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, material(colors[extruder] || '#00ae42'));
      mesh.castShadow = true;
      objectGroup.add(mesh);
      triangles += meshData.triangles.length / 3;
    }
    const box = new THREE.Box3().setFromObject(objectGroup);
    const size = box.getSize(new THREE.Vector3());
    objectGroup.userData.index = index;
    objects.push({ index, name: names[index] ?? `#${index + 1}`, triangles, size: [round1(size.x), round1(size.z), round1(size.y)], color: colors[extruder] || '#00ae42' });
    group.add(objectGroup);
    index += 1;
  }
  return { group, objects };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export const PartScene = forwardRef<PartSceneHandle, PartSceneProps>(function PartScene(props, ref) {
  const {
    tab, model, toolpath, buildVolume, filamentColors, selectedPlateId, objectNames, layerRange, hiddenFeatures, colorMode,
    hoverIndex, isolatedIndex, tool, pins, section, dims, xray, grid, ortho, turntable, compareUrl, style, analysis, explode, render, className = '',
  } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  // Latest callbacks, read from effects and the frame loop without re-running them.
  const cb = useRef(props);
  cb.current = props;

  // Everything three.js lives in refs: a React render per frame would be pointless work.
  const st = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    persp: THREE.PerspectiveCamera;
    ortho: THREE.OrthographicCamera;
    camera: THREE.Camera;
    controls: OrbitControls;
    bed: THREE.Group;
    plate: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null; // fades when the camera is under the bed
    gridHelper: THREE.GridHelper;
    mirror: THREE.Group; // holds the model (3MF/STL/STEP) and the compare ghost
    modelGroup: THREE.Group | null;
    objectGroups: THREE.Group[];
    toolpathGroup: THREE.Group | null;
    toolpathHandle: ToolpathHandle | null;
    compareGroup: THREE.Group | null;
    boxHelper: THREE.Box3Helper | null;
    measureLine: THREE.Line | null;
    pinDots: THREE.Group;
    anim: { q0: THREE.Quaternion; q1: THREE.Quaternion; t0: number; dist: number; target: THREE.Vector3 } | null;
    viewDir: THREE.Vector3;
    modelBox: THREE.Box3 | null;
    plane: THREE.Plane;
    measurePoints: THREE.Vector3[];
    snapshotSent: boolean;
    frame: number;
    /** Post-processing (ambient occlusion); null renders straight to the canvas. */
    composer: { composer: EffectComposer; renderPass: RenderPass; gtao: GTAOPass } | null;
  } | null>(null);
  const draw = (s: NonNullable<typeof st.current>) => {
    if (s.composer) s.composer.composer.render();
    else s.renderer.render(s.scene, s.camera);
  };
  const parsedModel = useRef<{ kind: '3mf'; data: Parsed3MFData } | { kind: 'stl'; geometry: THREE.BufferGeometry } | { kind: 'step'; group: THREE.Group } | null>(null);
  const parsedToolpath = useRef<ParsedToolpath | null>(null);
  const segmentMeta = useRef<{ nV: number; vType: Uint8Array } | null>(null);
  const modelGeneration = useRef(0);
  const toolpathGeneration = useRef(0);
  // Frame the view only when something new arrives (a file, a plate), never on a rebuild for
  // colours, names, hidden features or the colour mode — those must leave the camera alone.
  const frameModelNext = useRef(true);
  const frameToolpathNext = useRef(true);

  // ---------- helpers over the live scene ----------
  const focusBox = (): THREE.Box3 | null => {
    const s = st.current;
    if (!s) return null;
    if (tab === 'toolpath' && s.toolpathGroup) return new THREE.Box3().setFromObject(s.toolpathGroup);
    if (isolatedIndex !== null && s.objectGroups[isolatedIndex]) return new THREE.Box3().setFromObject(s.objectGroups[isolatedIndex]);
    if (s.modelGroup) return new THREE.Box3().setFromObject(s.mirror);
    if (s.toolpathGroup) return new THREE.Box3().setFromObject(s.toolpathGroup);
    return null;
  };

  const placeCamera = (dir: THREE.Vector3, dist: number, center: THREE.Vector3) => {
    const s = st.current;
    if (!s) return;
    s.camera.position.copy(center.clone().addScaledVector(dir, dist));
    s.camera.up.set(0, 1, 0);
    s.controls.target.copy(center);
    s.controls.update();
  };

  const frameView = (dir: THREE.Vector3) => {
    const s = st.current;
    if (!s) return;
    const box = focusBox() ?? new THREE.Box3(new THREE.Vector3(0, 0, -buildVolume.y), new THREE.Vector3(buildVolume.x, 10, 0));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.001);
    const plateDiagonal = Math.hypot(buildVolume.x, buildVolume.y);
    let dist: number;
    if (s.camera === s.persp) {
      const vFov = THREE.MathUtils.degToRad(s.persp.fov);
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * s.persp.aspect);
      dist = 1.15 * Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2));
      s.persp.near = Math.max(dist / 1000, 0.01);
      s.persp.far = dist * MAX_ZOOM_OUT + radius * 4 + plateDiagonal;
      s.persp.updateProjectionMatrix();
    } else {
      dist = radius * 3 + plateDiagonal;
      const a = s.persp.aspect;
      s.ortho.left = -radius * 1.25 * a;
      s.ortho.right = radius * 1.25 * a;
      s.ortho.top = radius * 1.25;
      s.ortho.bottom = -radius * 1.25;
      s.ortho.zoom = 1;
      s.ortho.near = -plateDiagonal * 4;
      s.ortho.far = dist * MAX_ZOOM_OUT + plateDiagonal * 4;
      s.ortho.updateProjectionMatrix();
    }
    s.controls.minDistance = Math.max(radius * 0.05, 0.05);
    s.controls.maxDistance = dist * MAX_ZOOM_OUT;
    s.viewDir = dir.clone();
    placeCamera(dir, dist, center);
  };

  const goTo = (d: [number, number, number]) => {
    const s = st.current;
    if (!s) return;
    const target = s.controls.target.clone();
    const offset = s.camera.position.clone().sub(target);
    const dist = offset.length() || 1;
    const from = offset.normalize();
    const to = safeDir(d);
    const z = new THREE.Vector3(0, 0, 1);
    s.anim = { q0: new THREE.Quaternion().setFromUnitVectors(z, from), q1: new THREE.Quaternion().setFromUnitVectors(z, to), t0: performance.now(), dist, target };
    s.viewDir = to;
  };

  useImperativeHandle(ref, () => ({
    fit: () => frameView(st.current?.viewDir ?? safeDir(ISO)),
    goTo,
    orbit: (dTheta, dPhi) => {
      const s = st.current;
      if (!s) return;
      const target = s.controls.target.clone();
      const off = s.camera.position.clone().sub(target);
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta -= dTheta;
      sph.phi = THREE.MathUtils.clamp(sph.phi - dPhi, 0.02, Math.PI - 0.02);
      const pos = new THREE.Vector3().setFromSpherical(sph);
      placeCamera(pos.clone().normalize(), sph.radius, target);
      s.viewDir = pos.normalize();
    },
    getView: () => {
      const s = st.current;
      if (!s) return null;
      const dir = s.camera.position.clone().sub(s.controls.target).normalize();
      return { dir: [dir.x, dir.y, dir.z], up: [s.camera.up.x, s.camera.up.y, s.camera.up.z] };
    },
    getSceneView: () => {
      const s = st.current;
      if (!s) return null;
      const t = s.controls.target;
      const off = s.camera.position.clone().sub(t);
      const dist = off.length();
      const dir = off.normalize();
      return { dir: [dir.x, dir.y, dir.z], target: [t.x, t.y, t.z], dist, ortho: s.camera === s.ortho, half: s.ortho.top / (s.ortho.zoom || 1) };
    },
    setSceneView: (view) => {
      const s = st.current;
      if (!s) return;
      s.anim = null;
      const dir = safeDir(view.dir);
      const target = new THREE.Vector3(...view.target);
      if (s.camera === s.ortho && view.ortho && view.half > 0) {
        const aspect = (containerRef.current?.clientWidth || 1) / (containerRef.current?.clientHeight || 1);
        s.ortho.zoom = 1;
        s.ortho.top = view.half;
        s.ortho.bottom = -view.half;
        s.ortho.left = -view.half * aspect;
        s.ortho.right = view.half * aspect;
        s.ortho.updateProjectionMatrix();
      }
      s.viewDir = dir.clone();
      placeCamera(dir, view.dist, target);
    },
    snapshot: (size) =>
      new Promise((resolve) => {
        const s = st.current;
        if (!s) return resolve(null);
        draw(s);
        const source = s.renderer.domElement;
        const target = document.createElement('canvas');
        const ctx = target.getContext('2d');
        if (!ctx) return resolve(null);
        if (size) {
          const side = Math.min(source.width, source.height);
          target.width = size;
          target.height = size;
          ctx.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, size, size);
        } else {
          target.width = source.width;
          target.height = source.height;
          ctx.drawImage(source, 0, 0);
        }
        target.toBlob((blob) => resolve(blob), 'image/png');
      }),
  }));

  // ---------- the scene, once per mount ----------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      cb.current.onStatus({ loading: false, error: 'webgl' });
      return;
    }
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0c1016');
    const persp = new THREE.PerspectiveCamera(40, width / height, 0.1, 10000);
    const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 10000);
    const controls = new OrbitControls(persp, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.autoRotateSpeed = 1.5;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = environment.texture;
    scene.add(new THREE.HemisphereLight(0xd7e0ea, 0x1a2027, 0.55));
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
    fill.position.set(-200, 120, -160);
    scene.add(fill);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    scene.add(key);

    const bed = new THREE.Group();
    scene.add(bed);
    const mirror = new THREE.Group();
    scene.add(mirror);
    const pinDots = new THREE.Group();
    scene.add(pinDots);

    st.current = {
      renderer, scene, persp, ortho: orthoCam, camera: persp, controls, bed, plate: null, gridHelper: new THREE.GridHelper(1, 1), mirror, modelGroup: null, objectGroups: [],
      toolpathGroup: null, toolpathHandle: null, compareGroup: null, boxHelper: null, measureLine: null, pinDots, anim: null, viewDir: safeDir(ISO), modelBox: null,
      plane: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), measurePoints: [], snapshotSent: false, frame: 0, composer: null,
    };

    // A handle for the dev harness and a DevTools console; never in a production build.
    if (import.meta.env.DEV) (window as unknown as { __partScene?: unknown }).__partScene = st.current;
    const loop = () => {
      const s = st.current;
      if (!s) return;
      s.frame = requestAnimationFrame(loop);
      if (s.anim) {
        const k = Math.min(1, (performance.now() - s.anim.t0) / 350);
        const e = 1 - Math.pow(1 - k, 3);
        const q = s.anim.q0.clone().slerp(s.anim.q1, e);
        placeCamera(new THREE.Vector3(0, 0, 1).applyQuaternion(q), s.anim.dist, s.anim.target);
        if (k >= 1) s.anim = null;
      }
      s.controls.update();
      // Exploded objects glide to their place (proposition 5): a short lerp per frame.
      for (const g of s.objectGroups) {
        const want = g.userData.explodeTarget as THREE.Vector3 | undefined;
        if (want && g.position.distanceToSquared(want) > 1e-4) g.position.lerp(want, 0.18);
        else if (want) g.position.copy(want);
      }
      // Under the bed the plate turns to glass, so the part's underside can be checked.
      if (s.plate) {
        const want = s.camera.position.y < -0.5 ? 0.12 : 1;
        const mat = s.plate.material;
        if (Math.abs(mat.opacity - want) > 0.005) mat.opacity += (want - mat.opacity) * 0.2;
        else mat.opacity = want;
        // Opaque plates stay out of the transparent queue: in there, distance sorting could
        // draw the plate over an X-ray part from some angles.
        mat.transparent = mat.opacity < 1;
        mat.depthWrite = mat.opacity > 0.9;
      }
      draw(s);
      drawLabels();
    };
    loop();

    const onResize = () => {
      const s = st.current;
      if (!s) return;
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      s.renderer.setSize(w, h);
      s.persp.aspect = w / h;
      s.persp.updateProjectionMatrix();
      const half = (s.ortho.top - s.ortho.bottom) / 2;
      s.ortho.left = -half * (w / h);
      s.ortho.right = half * (w / h);
      s.ortho.updateProjectionMatrix();
      s.composer?.composer.setSize(w, h);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      const s = st.current;
      if (s) {
        cancelAnimationFrame(s.frame);
        s.controls.dispose();
        thinWallsCancel.current?.();
        if (s.modelGroup) {
          disposeOverlays(s.modelGroup);
          disposeGroup(s.modelGroup);
        }
        if (s.compareGroup) disposeGroup(s.compareGroup);
        s.toolpathHandle?.dispose();
        s.composer?.composer.dispose();
        environment.texture.dispose();
        pmrem.dispose();
        s.renderer.dispose();
        if (s.renderer.domElement.parentNode === container) container.removeChild(s.renderer.domElement);
      }
      st.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once; everything else updates the live scene
  }, []);

  // ---------- the bed, at the printer's size ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.bed.clear();
    const { x: X, y: Y } = buildVolume;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(X, Y), new THREE.MeshStandardMaterial({ color: 0x242a32, roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
    plate.rotation.x = -Math.PI / 2;
    plate.renderOrder = -1; // always behind the glass of an X-ray part, whatever the angle
    plate.position.set(X / 2, -0.5, -Y / 2);
    s.bed.add(plate);
    s.plate = plate;
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(X, Y), new THREE.ShadowMaterial({ opacity: 0.22 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.set(X / 2, -0.49, -Y / 2);
    catcher.receiveShadow = true;
    s.bed.add(catcher);
    const size = Math.max(X, Y);
    const gridHelper = new THREE.GridHelper(size, Math.ceil(size / 10), 0x4a5563, 0x343c47);
    gridHelper.scale.set(X / size, 1, Y / size);
    gridHelper.position.set(X / 2, 0, -Y / 2);
    gridHelper.visible = grid;
    s.bed.add(gridHelper);
    s.gridHelper = gridHelper;
    const area = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(X - 4, 0.2, Y - 4)), new THREE.LineDashedMaterial({ color: 0x14b8a6, dashSize: 4, gapSize: 4, transparent: true, opacity: 0.5 }));
    area.computeLineDistances();
    area.position.set(X / 2, 0.2, -Y / 2);
    s.bed.add(area);
    const arrow = Math.max(18, Math.min(X, Y) * 0.1);
    for (const ax of AXES) s.bed.add(new THREE.ArrowHelper(new THREE.Vector3(...ax.dir), new THREE.Vector3(0, 0.3, 0), arrow, new THREE.Color(ax.color), arrow * 0.25, arrow * 0.12));
    const key = s.scene.children.find((c) => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight | undefined;
    if (key) {
      key.position.set(X / 2 + 60, 260, -Y / 2 + 90);
      key.target.position.set(X / 2, 0, -Y / 2);
      s.scene.add(key.target);
      const extent = Math.max(X, Y) * 0.75;
      key.shadow.camera.left = -extent;
      key.shadow.camera.right = extent;
      key.shadow.camera.top = extent;
      key.shadow.camera.bottom = -extent;
      key.shadow.camera.near = 1;
      key.shadow.camera.far = extent * 6;
      key.shadow.camera.updateProjectionMatrix();
    }
    applyBackground();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildVolume, grid]);

  useEffect(() => {
    if (st.current) st.current.gridHelper.visible = grid;
  }, [grid]);

  // ---------- projection, turntable ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    const next = ortho ? s.ortho : s.persp;
    if (s.camera === next) return;
    const from = s.camera;
    const target = s.controls.target.clone();
    const dir = from.position.clone().sub(target);
    const dist = dir.length() || 1;
    dir.normalize();
    // Same direction, same target, same apparent size: the swap must not move the view.
    const aspect = (containerRef.current?.clientWidth || 1) / (containerRef.current?.clientHeight || 1);
    const halfFov = THREE.MathUtils.degToRad(s.persp.fov) / 2;
    if (ortho) {
      const half = dist * Math.tan(halfFov);
      s.ortho.zoom = 1;
      s.ortho.top = half;
      s.ortho.bottom = -half;
      s.ortho.left = -half * aspect;
      s.ortho.right = half * aspect;
      s.ortho.updateProjectionMatrix();
      next.position.copy(from.position);
    } else {
      const half = s.ortho.top / (s.ortho.zoom || 1);
      next.position.copy(target.clone().addScaledVector(dir, half / Math.tan(halfFov)));
    }
    next.up.copy(from.up);
    const { minDistance, maxDistance } = s.controls;
    s.controls.dispose();
    s.controls = new OrbitControls(next, s.renderer.domElement);
    s.controls.enableDamping = true;
    s.controls.dampingFactor = 0.06;
    s.controls.autoRotate = turntable;
    s.controls.autoRotateSpeed = 1.5;
    s.controls.minDistance = minDistance;
    s.controls.maxDistance = maxDistance;
    s.controls.target.copy(target);
    s.controls.update();
    s.camera = next;
    if (s.composer) {
      s.composer.renderPass.camera = next;
      s.composer.gtao.camera = next;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- turntable is applied by its own effect
  }, [ortho]);

  // ---------- rendering: shadows, ambient occlusion, background ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.renderer.shadowMap.enabled = render.shadows;
    const key = s.scene.children.find((c) => c instanceof THREE.DirectionalLight && c.castShadow !== undefined) as THREE.DirectionalLight | undefined;
    if (key) key.castShadow = render.shadows;
    s.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).needsUpdate = true;
    });
  }, [render.shadows]);
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    if (s.composer) {
      s.composer.composer.dispose();
      s.composer = null;
    }
    if (!render.ao) return;
    const w = containerRef.current?.clientWidth || 1;
    const h = containerRef.current?.clientHeight || 1;
    const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(s.renderer, target);
    const renderPass = new RenderPass(s.scene, s.camera);
    const gtao = new GTAOPass(s.scene, s.camera, w, h);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({ radius: 6, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    composer.addPass(renderPass);
    composer.addPass(gtao);
    composer.addPass(new OutputPass());
    composer.setSize(w, h);
    s.composer = { composer, renderPass, gtao };
  }, [render.ao]);
  const applyBackground = () => {
    const s = st.current;
    if (!s) return;
    const light = cb.current.render.background === 'light';
    (s.scene.background as THREE.Color).set(light ? '#e6eaef' : '#0c1016');
    if (s.plate) s.plate.material.color.set(light ? 0xc9d1da : 0x242a32);
    const grid = s.gridHelper.material as THREE.LineBasicMaterial | THREE.LineBasicMaterial[];
    const colors = grid instanceof Array ? grid : [grid];
    colors.forEach((m) => m.color.set(light ? 0x8e99a6 : 0x4a5563));
    const hemi = s.scene.children.find((c) => c instanceof THREE.HemisphereLight) as THREE.HemisphereLight | undefined;
    if (hemi) hemi.groundColor.set(light ? 0xb8c0ca : 0x1a2027);
  };
  useEffect(() => {
    applyBackground();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render.background]);

  useEffect(() => {
    if (st.current) st.current.controls.autoRotate = turntable;
  }, [turntable]);

  // ---------- the model ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    const generation = ++modelGeneration.current;
    parsedModel.current = null;
    frameModelNext.current = true;
    if (!model) {
      rebuildModel();
      return;
    }
    cb.current.onStatus({ loading: true, error: null, stage: 'download', progress: null });
    const type = model.fileType.toLowerCase();
    const load = async () => {
      const bytes = await fetchBytes(model.url, (share) => {
        if (generation === modelGeneration.current) cb.current.onStatus({ loading: true, error: null, stage: 'download', progress: share });
      });
      if (generation === modelGeneration.current) cb.current.onStatus({ loading: true, error: null, stage: 'prepare', progress: 1 });
      await new Promise((r) => setTimeout(r, 0)); // let the overlay paint before the parse blocks
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (type === 'stl') {
        const geometry = new STLLoader().parse(buffer);
        geometry.computeVertexNormals();
        geometry.rotateX(-Math.PI / 2);
        return { kind: 'stl' as const, geometry };
      }
      if (type === '3mf' || type === 'gcode.3mf') {
        const data = await parse3MF(buffer);
        if (data.objects.size === 0) throw new Error('noMeshes');
        return { kind: '3mf' as const, data };
      }
      if (type === 'step' || type === 'stp') {
        const meshes = await parseStepInWorker(buffer);
        return { kind: 'step' as const, group: buildStepGroup(meshes, filamentColors) };
      }
      throw new Error('unsupported');
    };
    load()
      .then((parsed) => {
        if (generation !== modelGeneration.current) return;
        parsedModel.current = parsed;
        rebuildModel();
        cb.current.onStatus({ loading: false, error: null });
      })
      .catch((err: Error) => {
        if (generation !== modelGeneration.current) return;
        const code = err.message === 'noMeshes' ? 'noMeshes' : err.message === 'unsupported' ? 'unsupported' : 'load';
        cb.current.onStatus({ loading: false, error: code });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the plate and colours rebuild below without a refetch
  }, [model?.url, model?.fileType]);

  const rebuildModel = () => {
    const s = st.current;
    if (!s) return;
    // Always the latest props: the plates (object names, colours) may land after the mesh.
    const { filamentColors, selectedPlateId, objectNames, buildVolume, tab } = cb.current;
    if (s.modelGroup) {
      s.mirror.remove(s.modelGroup);
      disposeOverlays(s.modelGroup);
      disposeGroup(s.modelGroup);
      s.modelGroup = null;
      s.objectGroups = [];
    }
    thinWallsCancel.current?.();
    thinWallsCancel.current = null;
    const parsed = parsedModel.current;
    if (!parsed) {
      s.modelBox = null;
      cb.current.onObjects([], null);
      cb.current.onAnalysis({ overhangShare: null, thinWalls: null });
      return;
    }
    let group: THREE.Group;
    let objects: PartObject[];
    let centreOnPlate = true;
    if (parsed.kind === 'stl') {
      group = new THREE.Group();
      const mesh = new THREE.Mesh(parsed.geometry.clone(), material(filamentColors[0] || '#00ae42'));
      mesh.castShadow = true;
      const g = new THREE.Group();
      g.add(mesh);
      group.add(g);
      const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
      objects = [{ index: 0, name: objectNames[0] ?? '#1', triangles: parsed.geometry.index ? parsed.geometry.index.count / 3 : parsed.geometry.attributes.position.count / 3, size: [round1(size.x), round1(size.z), round1(size.y)], color: filamentColors[0] || '#00ae42' }];
    } else if (parsed.kind === 'step') {
      group = new THREE.Group();
      objects = [];
      parsed.group.children.slice().forEach((child, index) => {
        const g = new THREE.Group();
        g.add(child.clone());
        group.add(g);
        const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
        objects.push({ index, name: objectNames[index] ?? `#${index + 1}`, triangles: 0, size: [round1(size.x), round1(size.z), round1(size.y)], color: filamentColors[0] || '#00ae42' });
      });
    } else {
      const built = buildObjectGroup(parsed.data, selectedPlateId, filamentColors, objectNames);
      group = built.group;
      objects = built.objects;
      centreOnPlate = parsed.data.buildItems.length === 0;
    }
    // Placement as the file manager's viewer: on the plate, centred when the file carries no
    // placement (STL, STEP, a 3MF without build items), at its own plate offset otherwise.
    const box = new THREE.Box3().setFromObject(group);
    const centre = box.getCenter(new THREE.Vector3());
    group.position.y = -box.min.y;
    const plateCentreX = buildVolume.x / 2;
    const plateCentreZ = -buildVolume.y / 2; // three z = -printer y
    if (parsed.kind === '3mf' && !centreOnPlate && selectedPlateId != null) {
      const bounds = parsed.data.plateBounds.get(selectedPlateId);
      const offset = parsed.data.plateOffsets.get(selectedPlateId);
      if (bounds) {
        group.position.x = -(box.min.x - bounds.minX);
        group.position.z = -(bounds.minY + box.max.z);
      } else if (offset) {
        group.position.x = plateCentreX - offset.offsetX;
        group.position.z = offset.offsetY - buildVolume.y / 2;
      }
    } else if (centreOnPlate) {
      group.position.x = -centre.x + plateCentreX;
      group.position.z = -centre.z + plateCentreZ;
    }
    s.mirror.add(group);
    s.modelGroup = group;
    s.objectGroups = group.children as THREE.Group[];
    s.mirror.updateMatrixWorld(true);
    const world = new THREE.Box3().setFromObject(s.mirror);
    s.modelBox = world;
    const minP = toPrinter(world.min);
    const maxP = toPrinter(world.max);
    cb.current.onObjects(objects, { min: [minP[0], Math.min(minP[1], maxP[1]), minP[2]], max: [maxP[0], Math.max(minP[1], maxP[1]), maxP[2]] });
    for (const g of s.objectGroups) g.userData.basePosition = g.position.clone();
    applyExplode(true);
    applyAppearance();
    applySection();
    applyDims();
    applyAnalysis();
    if (tab === 'model' && frameModelNext.current) frameView(s.viewDir);
    frameModelNext.current = false;
    if (cb.current.onSnapshot && !s.snapshotSent) {
      s.snapshotSent = true;
      requestAnimationFrame(() => {
        const sc = st.current;
        if (!sc) return;
        draw(sc);
        const source = sc.renderer.domElement;
        const side = Math.min(source.width, source.height);
        const target = document.createElement('canvas');
        target.width = target.height = 256;
        const ctx = target.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, 256, 256);
        target.toBlob((blob) => blob && cb.current.onSnapshot?.(blob), 'image/png');
      });
    }
  };

  useEffect(() => {
    if (parsedModel.current) rebuildModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild on colour/name changes only
  }, [filamentColors, objectNames]);
  useEffect(() => {
    // A plate or bed change moves the part: that one is worth re-framing.
    frameModelNext.current = true;
    if (parsedModel.current) rebuildModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlateId, buildVolume]);

  // ---------- the toolpath ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    const generation = ++toolpathGeneration.current;
    parsedToolpath.current = null;
    frameToolpathNext.current = true;
    rebuildToolpath();
    if (!toolpath) {
      cb.current.onToolpathStats(null);
      return;
    }
    const url = selectedPlateId != null ? `${toolpath.url}${toolpath.url.includes('?') ? '&' : '?'}plate=${selectedPlateId}` : toolpath.url;
    const report = (status: ViewerStatus) => {
      if (cb.current.tab === 'toolpath' && generation === toolpathGeneration.current) cb.current.onStatus(status);
    };
    report({ loading: true, error: null, stage: 'download', progress: null });
    fetchBytes(url, (share) => report({ loading: true, error: null, stage: 'download', progress: share }))
      .then(async (bytes) => {
        report({ loading: true, error: null, stage: 'parse', progress: 0 });
        await new Promise((r) => setTimeout(r, 0));
        const text = new TextDecoder().decode(bytes);
        return parseToolpathOffThread(text, (share) => report({ loading: true, error: null, stage: 'parse', progress: share }));
      })
      .then((parsed) => {
        if (generation !== toolpathGeneration.current) return;
        report({ loading: true, error: null, stage: 'prepare', progress: 1 });
        parsedToolpath.current = parsed;
        rebuildToolpath();
        if (tab === 'toolpath') cb.current.onStatus({ loading: false, error: null });
      })
      .catch(() => {
        if (generation !== toolpathGeneration.current) return;
        cb.current.onToolpathStats(null);
        if (tab === 'toolpath') cb.current.onStatus({ loading: false, error: 'load' });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the feature filter rebuilds below without a refetch
  }, [toolpath?.url, selectedPlateId]);

  const hiddenKey = [...hiddenFeatures].sort((a, b) => a - b).join(',');
  const rebuildToolpath = () => {
    const s = st.current;
    if (!s) return;
    const { colorMode, hiddenFeatures, tab } = cb.current;
    if (s.toolpathGroup) {
      s.scene.remove(s.toolpathGroup);
      s.toolpathHandle?.dispose();
      s.toolpathGroup = null;
      s.toolpathHandle = null;
      segmentMeta.current = null;
    }
    const parsed = parsedToolpath.current;
    if (!parsed || parsed.layers.length === 0) return;
    const keyed = colorMode === 'filament' ? layersByFilament(parsed.layers) : parsed.layers;
    const data = buildSegmentData(filterLayersByType(keyed, hiddenFeatures), parsed.defaultWidth);
    const handle = makeToolpath(THREE, data);
    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;
    group.add(handle.mesh);
    group.add(handle.travLines);
    handle.setTravelVisible(false);
    s.scene.add(group);
    s.toolpathGroup = group;
    s.toolpathHandle = handle;
    segmentMeta.current = { nV: data.nV, vType: data.meta.vType };
    applyToolpathColours();
    applyLayerRange();
    group.visible = tab === 'toolpath';
    const full = buildSegmentData(parsed.layers, parsed.defaultWidth);
    const total = full.typeLengths.reduce((a, b) => a + b, 0) || 1;
    cb.current.onToolpathStats({
      layerCount: parsed.layers.length,
      typeShares: Array.from(full.typeLengths, (l) => l / total),
      zPerLayer: parsed.layers.map((l) => l.z),
      remainingPerLayer: parsed.layers.map((l) => l.remainingSec),
      segmentsPerLayer: parsed.layers.map((l) => l.paths.length / 8),
    });
    if (tab === 'toolpath' && frameToolpathNext.current) frameView(s.viewDir);
    frameToolpathNext.current = false;
  };
  useEffect(() => {
    if (parsedToolpath.current) rebuildToolpath();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild on filter/mode changes only
  }, [hiddenKey, colorMode]);

  const applyToolpathColours = () => {
    const s = st.current;
    const meta = segmentMeta.current;
    if (!s?.toolpathHandle || !meta) return;
    const { colorMode, filamentColors, hiddenFeatures } = cb.current;
    if (colorMode === 'filament') {
      const colors = new Float32Array(meta.nV * 4);
      for (let v = 0; v < meta.nV; v += 1) {
        const slot = Math.max(0, meta.vType[v] - 1);
        const hex = (filamentColors[slot] ?? filamentColors[0] ?? '#00ae42').replace('#', '');
        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
        colors[v * 4] = Number.parseInt(full.slice(0, 6), 16) || 0x00ae42;
      }
      s.toolpathHandle.setColors(colors);
    } else {
      const data = buildSegmentData(filterLayersByType(parsedToolpath.current?.layers ?? [], hiddenFeatures), parsedToolpath.current?.defaultWidth ?? 0.4);
      s.toolpathHandle.setColors(computeColors(data, 'feature', {}).color);
    }
  };
  useEffect(() => {
    applyToolpathColours();
  }, [filamentColors]);

  const applyLayerRange = () => {
    const s = st.current;
    if (!s?.toolpathHandle) return;
    const { layerRange } = cb.current;
    const last = Math.max(0, s.toolpathHandle.layerCount - 1);
    s.toolpathHandle.setLayerRange(Math.min(layerRange[0], last), Math.min(layerRange[1], last));
  };
  useEffect(() => {
    applyLayerRange();
  }, [layerRange]);

  // ---------- tab: which layer is shown, and the frame ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.mirror.visible = tab === 'model';
    if (s.compareGroup) s.compareGroup.visible = tab === 'model';
    if (s.boxHelper) s.boxHelper.visible = tab === 'model' && dims;
    s.pinDots.visible = tab === 'model';
    if (s.measureLine) s.measureLine.visible = tab === 'model';
    if (s.toolpathGroup) s.toolpathGroup.visible = tab === 'toolpath';
    frameView(s.viewDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ---------- appearance: hover, isolate, x-ray ----------
  const applyAppearance = () => {
    const s = st.current;
    if (!s) return;
    const { xray, isolatedIndex, hoverIndex, style, render } = cb.current;
    const wireframe = style === 'wireframe';
    const polygons = style === 'polygons';
    const roughness = render.finish === 'matte' ? 0.9 : render.finish === 'glossy' ? 0.22 : 0.55;
    const envIntensity = render.reflections === 'off' ? 0 : render.reflections === 'strong' ? 1.1 : 0.45;
    // Which overlays the style wants: feature edges that respect depth, and (hidden-edges
    // style) the occluded ones too, faint. X-ray adds its own softer edges on a shaded part.
    const wantVisible = wireframe || style === 'edges' || style === 'hiddenEdges' || xray;
    const wantHidden = style === 'hiddenEdges';
    const threshold = wireframe ? 20 : xray && style === 'shaded' ? 45 : 30;
    s.objectGroups.forEach((g, index) => {
      const ghosted = xray || (isolatedIndex !== null && index !== isolatedIndex);
      g.traverse((m) => {
        if (!(m instanceof THREE.Mesh) || m.userData.overlay) return;
        const mat = m.material as THREE.MeshStandardMaterial;
        // X-ray: a thin, double-sided glass (inner walls show through), no shadow, and the
        // part's sharp edges drawn on top so its shape still reads. A ghosted neighbour
        // (another object isolated) is the same glass without the edges. Wireframe keeps the
        // fill invisible but depth-writing, so the edges behind the part stay hidden.
        const tris = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
        // Feature edges only help on mechanical parts; a dense organic mesh (scans, sculpts)
        // would turn into speckle, so above the budget those keep the plain surface — and the
        // wireframe style falls back to the triangle wireframe, which still shows the shape.
        const allow = tris <= EDGE_BUDGET;
        const triWire = wireframe && !allow;
        mat.transparent = ghosted || (wireframe && !triWire);
        mat.opacity = wireframe && !triWire ? 0 : xray ? 0.18 : ghosted ? 0.25 : 1;
        mat.depthWrite = !ghosted;
        mat.colorWrite = !wireframe || triWire;
        mat.wireframe = triWire;
        mat.roughness = roughness;
        mat.envMapIntensity = envIntensity;
        mat.side = ghosted ? THREE.DoubleSide : THREE.FrontSide;
        mat.needsUpdate = true;
        m.castShadow = !ghosted && !wireframe;
        mat.emissive = index === hoverIndex ? HIGHLIGHT : BLACK;
        mat.emissiveIntensity = 0.35;
        const sync = (kind: 'visible' | 'hidden' | 'polygons', want: boolean, make: () => THREE.LineSegments) => {
          const existing = m.children.find((c) => c.userData.overlay === kind) as THREE.LineSegments | undefined;
          if (want && allow) {
            if (existing && existing.userData.threshold === threshold) return;
            if (existing) {
              m.remove(existing);
              (existing.material as THREE.Material).dispose();
            }
            const lines = make();
            lines.userData.overlay = kind;
            lines.userData.threshold = threshold;
            lines.raycast = () => undefined;
            m.add(lines);
          } else if (existing) {
            m.remove(existing);
            (existing.material as THREE.Material).dispose();
          }
        };
        const edgeColor = xray ? 0xdbe4ee : wireframe ? 0xe2e8f0 : 0x111827;
        sync('visible', wantVisible, () => new THREE.LineSegments(edgesFor(m, threshold), new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: xray ? 0.45 : wireframe ? 0.95 : 0.85, depthWrite: false })));
        // Polygons: every triangle edge over the shaded part (a slicer's "show mesh edges").
        sync('polygons', polygons && tris <= 1_000_000, () => new THREE.LineSegments(polygonsFor(m), new THREE.LineBasicMaterial({ color: 0x0b1220, transparent: true, opacity: 0.5, depthWrite: false })));
        sync('hidden', wantHidden, () => {
          const l = new THREE.LineSegments(edgesFor(m, threshold), new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }));
          l.renderOrder = 5;
          return l;
        });
      });
    });
    const catcher = s.bed.children.find((c) => c instanceof THREE.Mesh && c.material instanceof THREE.ShadowMaterial);
    if (catcher) catcher.visible = !xray;
  };
  useEffect(() => {
    applyAppearance();
  }, [hoverIndex, xray, style, render.finish, render.reflections]);

  // ---------- explode: objects slide apart from the plate's centre ----------
  const applyExplode = (instant = false) => {
    const s = st.current;
    if (!s || s.objectGroups.length === 0) return;
    const { explode } = cb.current;
    const centres = s.objectGroups.map((g) => new THREE.Box3().setFromObject(g).getCenter(new THREE.Vector3()).sub(g.position));
    const all = centres.reduce((acc, c) => acc.add(c), new THREE.Vector3()).divideScalar(centres.length);
    const spread = Math.max(40, ...centres.map((c) => Math.hypot(c.x - all.x, c.z - all.z))) * 0.9;
    s.objectGroups.forEach((g, i) => {
      const base = (g.userData.basePosition as THREE.Vector3 | undefined) ?? new THREE.Vector3();
      const away = new THREE.Vector3(centres[i].x - all.x, 0, centres[i].z - all.z);
      // Objects at the very centre (or a lone one) still lift a little, so "explode" reads.
      if (away.lengthSq() < 1e-6) away.set(0, 0, 0);
      else away.normalize().multiplyScalar(spread);
      const target = base.clone().addScaledVector(away, explode);
      g.userData.explodeTarget = target;
      if (instant) g.position.copy(target);
    });
  };
  useEffect(() => {
    applyExplode();
  }, [explode]);

  // ---------- analysis: overhang ramp and thin walls ----------
  const thinWallsCancel = useRef<(() => void) | null>(null);
  const applyAnalysis = () => {
    const s = st.current;
    if (!s) return;
    const { analysis } = cb.current;
    ANALYSIS_UNIFORMS.uOverhang.value = analysis.overhang.on ? 1 : 0;
    ANALYSIS_UNIFORMS.uOverhangDeg.value = analysis.overhang.deg;
    ANALYSIS_UNIFORMS.uThin.value = analysis.thinWalls.on ? 1 : 0;
    const meshes: THREE.Mesh[] = [];
    s.objectGroups.forEach((g) => g.traverse((m) => { if (m instanceof THREE.Mesh && !m.userData.overlay) meshes.push(m); }));
    const result: AnalysisResult = { overhangShare: null, thinWalls: null };
    if (analysis.overhang.on && meshes.length) {
      result.overhangShare = overhangShare(meshes.map((m) => ({ geometry: m.geometry, worldY: new THREE.Vector3().setFromMatrixPosition(m.matrixWorld).y })), analysis.overhang.deg);
    }
    thinWallsCancel.current?.();
    thinWallsCancel.current = null;
    if (analysis.thinWalls.on && meshes.length) {
      thinWallsCancel.current = measureThinWalls(meshes, analysis.thinWalls.mm, (thin) => {
        thinWallsCancel.current = null;
        cb.current.onAnalysis({ ...result, thinWalls: thin });
      });
    } else {
      clearThinWalls(meshes);
    }
    cb.current.onAnalysis(result);
  };
  useEffect(() => {
    if (st.current) {
      st.current.mirror.updateMatrixWorld(true);
      applyAnalysis();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.overhang.on, analysis.overhang.deg, analysis.thinWalls.on, analysis.thinWalls.mm]);
  useEffect(() => {
    applyAppearance();
    const s = st.current;
    if (s && tab === 'model') frameView(s.viewDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isolatedIndex]);

  // ---------- section plane ----------
  const applySection = () => {
    const s = st.current;
    if (!s) return;
    const { section } = cb.current;
    const box = s.modelBox;
    const planes = section.on && box ? [s.plane] : [];
    if (section.on && box) {
      // Printer axes: z is world y, x is world x, y is world -z.
      if (section.axis === 'z') s.plane.set(new THREE.Vector3(0, -1, 0), box.min.y + (box.max.y - box.min.y) * (section.pct / 100));
      else if (section.axis === 'x') s.plane.set(new THREE.Vector3(-1, 0, 0), box.min.x + (box.max.x - box.min.x) * (section.pct / 100));
      else s.plane.set(new THREE.Vector3(0, 0, 1), -(box.max.z - (box.max.z - box.min.z) * (section.pct / 100)));
    }
    s.objectGroups.forEach((g) =>
      g.traverse((m) => {
        if (m instanceof THREE.Mesh) {
          const mat = m.material as THREE.MeshStandardMaterial;
          mat.clippingPlanes = planes;
          mat.side = planes.length ? THREE.DoubleSide : THREE.FrontSide;
          mat.needsUpdate = true;
        }
      }),
    );
  };
  useEffect(() => {
    applySection();
  }, [section.on, section.axis, section.pct]);

  // ---------- dimensions ----------
  const applyDims = () => {
    const s = st.current;
    if (!s) return;
    const { dims, tab } = cb.current;
    if (s.boxHelper) {
      s.scene.remove(s.boxHelper);
      s.boxHelper = null;
    }
    if (dims && s.modelBox) {
      s.boxHelper = new THREE.Box3Helper(s.modelBox, new THREE.Color('#f5b324'));
      s.boxHelper.visible = tab === 'model';
      s.scene.add(s.boxHelper);
    }
  };
  useEffect(() => {
    applyDims();
  }, [dims]);

  // ---------- compare ghost ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    if (s.compareGroup) {
      s.mirror.remove(s.compareGroup);
      disposeGroup(s.compareGroup);
      s.compareGroup = null;
    }
    if (!compareUrl) return;
    let cancelled = false;
    fetch(compareUrl, { headers: authHeaders() })
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error('load'))))
      .then(parse3MF)
      .then((data) => {
        const sc = st.current;
        if (cancelled || !sc) return;
        const { group } = buildObjectGroup(data, selectedPlateId, [], []);
        group.traverse((m) => {
          if (m instanceof THREE.Mesh) m.material = new THREE.MeshBasicMaterial({ color: '#f5b324', wireframe: true, transparent: true, opacity: 0.35 });
        });
        const box = new THREE.Box3().setFromObject(group);
        const centre = box.getCenter(new THREE.Vector3());
        group.position.set(-centre.x + buildVolume.x / 2, -box.min.y, -centre.z - buildVolume.y / 2);
        if (sc.modelGroup && data.buildItems.length > 0) group.position.copy(sc.modelGroup.position);
        group.visible = tab === 'model';
        sc.mirror.add(group);
        sc.compareGroup = group;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareUrl]);

  // ---------- pins ----------
  useEffect(() => {
    const s = st.current;
    if (!s) return;
    s.pinDots.clear();
    for (const pin of pins) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 12), new THREE.MeshBasicMaterial({ color: '#f5b324', depthTest: false }));
      dot.renderOrder = 20;
      dot.position.copy(fromPrinter([pin.x, pin.y, pin.z]));
      s.pinDots.add(dot);
    }
  }, [pins]);

  // ---------- pointer: hover, double-click isolate, measure, pins ----------
  useEffect(() => {
    const s = st.current;
    const el = s?.renderer.domElement;
    if (!s || !el) return;
    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const hit = (e: PointerEvent | MouseEvent) => {
      const sc = st.current;
      if (!sc || !sc.modelGroup || tab !== 'model') return null;
      const r = el.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, sc.camera);
      const inter = ray.intersectObjects(sc.objectGroups, true).find((i) => !i.object.userData.overlay);
      if (!inter) return null;
      let node: THREE.Object3D | null = inter.object;
      while (node && node.userData.index === undefined) node = node.parent;
      return { index: (node?.userData.index as number | undefined) ?? null, point: inter.point };
    };
    let down: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => {
      const h = hit(e);
      cb.current.onHover(h?.index ?? null);
    };
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const moved = !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      down = null;
      if (moved) return;
      const sc = st.current;
      const h = hit(e);
      if (!sc || !h) return;
      if (cb.current.tool === 'pin') cb.current.onPlacePin(toPrinter(h.point));
      if (cb.current.tool === 'measure') {
        sc.measurePoints = sc.measurePoints.length >= 2 ? [h.point.clone()] : [...sc.measurePoints, h.point.clone()];
        if (sc.measureLine) {
          sc.scene.remove(sc.measureLine);
          sc.measureLine = null;
        }
        if (sc.measurePoints.length === 2) {
          sc.measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sc.measurePoints), new THREE.LineBasicMaterial({ color: '#f5b324', depthTest: false }));
          sc.measureLine.renderOrder = 21;
          sc.scene.add(sc.measureLine);
          cb.current.onMeasure(sc.measurePoints[0].distanceTo(sc.measurePoints[1]));
        } else cb.current.onMeasure(null);
      }
    };
    const onDouble = (e: MouseEvent) => {
      const h = hit(e);
      if (h?.index != null) cb.current.onIsolate(h.index);
    };
    const onLeave = () => cb.current.onHover(null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('dblclick', onDouble);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('dblclick', onDouble);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [tab]);

  useEffect(() => {
    const s = st.current;
    if (!s || tool === 'measure') return;
    s.measurePoints = [];
    if (s.measureLine) {
      s.scene.remove(s.measureLine);
      s.measureLine = null;
    }
    cb.current.onMeasure(null);
  }, [tool]);

  // ---------- 2D labels over the canvas: dimensions, pins, the measurement ----------
  const drawLabels = () => {
    const s = st.current;
    const host = labelsRef.current;
    const container = containerRef.current;
    if (!s || !host || !container) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const project = (v: THREE.Vector3) => {
      const p = v.clone().project(s.camera);
      return [((p.x + 1) / 2) * w, ((1 - p.y) / 2) * h, p.z < 1] as const;
    };
    const parts: string[] = [];
    const label = (v: THREE.Vector3, text: string, cls: string) => {
      const [x, y, front] = project(v);
      if (front) parts.push(`<span class="${cls}" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px">${text}</span>`);
    };
    const dim = 'pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded border border-bambu-dark-tertiary bg-bambu-dark/85 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-white';
    if (tab === 'model') {
      if (dims && s.modelBox) {
        const b = s.modelBox;
        const size = b.getSize(new THREE.Vector3());
        label(new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, b.max.z + 6), `X ${size.x.toFixed(1)} mm`, dim);
        label(new THREE.Vector3(b.max.x + 6, b.min.y, (b.min.z + b.max.z) / 2), `Y ${size.z.toFixed(1)} mm`, dim);
        label(new THREE.Vector3(b.min.x - 6, (b.min.y + b.max.y) / 2, b.max.z), `Z ${size.y.toFixed(1)} mm`, dim);
      }
      if (s.measurePoints.length === 2) label(s.measurePoints[0].clone().lerp(s.measurePoints[1], 0.5), `${s.measurePoints[0].distanceTo(s.measurePoints[1]).toFixed(1)} mm`, dim);
      for (const pin of cb.current.pins) {
        label(fromPrinter([pin.x, pin.y, pin.z]).add(new THREE.Vector3(0, 3, 0)), pin.text.replace(/</g, '&lt;'), 'pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md bg-amber-400 px-2 py-0.5 text-[11px] font-semibold text-black whitespace-nowrap');
      }
    }
    const html = parts.join('');
    if (host.innerHTML !== html) host.innerHTML = html;
  };

  return (
    // The caller positions this box (the modal gives it `absolute inset-0`); it must never carry
    // its own `relative`, which would win over `absolute` and leave the canvas with no height.
    <div className={`overflow-hidden ${className || 'relative h-full w-full'}`}>
      <div ref={containerRef} data-testid="part-scene" className="absolute inset-0" />
      <div ref={labelsRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden />
    </div>
  );
});
