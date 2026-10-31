/**
 * Mesh loaders shared by the file previews: 3MF (plain and sliced `.gcode.3mf`) parsing into
 * objects, build items and plate bounds; the three.js groups built from them; the STEP worker
 * round trip. Moved verbatim out of ModelViewer.tsx (2026-10-31) so the part viewer and the
 * printer-file preview load the same way.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import JSZip from 'jszip';
import type { StepWorkerMesh, StepWorkerResponse } from '../workers/stepPreview.worker';

// STEP triangulation runs in a dedicated worker (#2976): OpenCascade-as-WASM
// takes seconds on a real assembly and its embind glue needs an eval-relaxed
// CSP that only the worker's own script response carries (see the worker
// file and security_headers_middleware in backend/app/main.py). The worker —
// and with it the ~7 MB wasm — loads on the first STEP preview and is then
// kept warm for the page's lifetime.
let stepWorker: Worker | null = null;
let stepRequestId = 0;
const stepPendingRequests = new Map<
  number,
  { resolve: (meshes: StepWorkerMesh[]) => void; reject: (err: Error) => void }
>();

function failAllStepRequests(message: string): void {
  for (const pending of stepPendingRequests.values()) {
    pending.reject(new Error(message));
  }
  stepPendingRequests.clear();
}

function getStepWorker(): Worker {
  if (!stepWorker) {
    const worker = new Worker(new URL('../workers/stepPreview.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<StepWorkerResponse>) => {
      const pending = stepPendingRequests.get(event.data.id);
      if (!pending) return;
      stepPendingRequests.delete(event.data.id);
      if (event.data.ok) {
        pending.resolve(event.data.meshes);
      } else {
        pending.reject(new Error(event.data.reason));
      }
    };
    // A crashed or unloadable worker is dropped so the next preview attempt
    // starts a fresh one instead of reusing a dead instance.
    worker.onerror = () => {
      failAllStepRequests('error');
      worker.terminate();
      if (stepWorker === worker) stepWorker = null;
    };
    stepWorker = worker;
  }
  return stepWorker;
}

export function parseStepInWorker(buffer: ArrayBuffer): Promise<StepWorkerMesh[]> {
  return new Promise((resolve, reject) => {
    const id = ++stepRequestId;
    stepPendingRequests.set(id, { resolve, reject });
    getStepWorker().postMessage({ id, buffer }, [buffer]);
  });
}

// How far the user may dolly out, as a multiple of the framed distance.
// Triangulated STEP shape as posted back by the step preview worker.
export type StepMeshData = StepWorkerMesh;

export interface MeshData {
  vertices: number[];
  triangles: number[];
  extruder: number; // Per-mesh extruder index for coloring
}

export interface ObjectData {
  id: string;
  meshes: MeshData[];
  defaultExtruder: number; // Default extruder for object (used if mesh doesn't have specific one)
  plateId?: number | null;
}

export interface BuildItem {
  objectId: string;
  transform: THREE.Matrix4;
  extruder?: number; // Can override object's extruder
  plateId?: number | null;
}

export interface Parsed3MFData {
  objects: Map<string, ObjectData>;
  buildItems: BuildItem[];
  plateBounds: Map<number, { minX: number; minY: number; maxX: number; maxY: number }>;
  plateOffsets: Map<number, { offsetX: number; offsetY: number }>;
}

// Yield to the browser event loop so the main thread can repaint, process
// user input (especially the modal's close button), and avoid the
// "page unresponsive" dialog while we crunch through large 3MFs in
// straight-line JS. setTimeout(_, 0) is sufficient — we don't need rAF
// here, the goal is just to surrender control so queued tasks run.
export function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Yield once per N iterations of a hot loop. Picked so each batch is
// ~5-10 ms of work on a typical desktop — fine-grained enough to keep
// frames flowing, coarse enough not to drown the loop in setTimeout
// dispatch overhead. Adjust if profiling shows otherwise.
const YIELD_EVERY_N_VERTICES = 20000;
const YIELD_EVERY_N_TRIANGLES = 20000;

// Parse 3MF transform - keep in 3MF coordinate space (Z-up)
function parseTransform3MF(transformStr: string | null): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  if (!transformStr) {
    return matrix; // Identity matrix
  }

  // 3MF transform is a 3x4 affine matrix in row-major order:
  // "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32"
  // Where (m30, m31, m32) is the translation vector
  const values = transformStr.trim().split(/\s+/).map(parseFloat);
  if (values.length >= 12) {
    // The 3MF core spec writes the matrix for ROW vectors: p' = p · M, so each triple
    // (m00 m01 m02), (m10 m11 m12), (m20 m21 m22) is the image of a basis vector and
    // (m30 m31 m32) the translation. three.js multiplies COLUMN vectors (p' = M · p), so the
    // 3×3 block goes in transposed: n11 = m00, n12 = m10, n13 = m20, … A translation-only
    // transform looks the same either way, which is why the untransposed version held for
    // most files; a rotated object (a tusk stood upright in the slicer) came out inverted
    // — upside down — until 2026-10-31.
    matrix.set(
      values[0], values[3], values[6], values[9],   // m00, m10, m20, tx
      values[1], values[4], values[7], values[10],  // m01, m11, m21, ty
      values[2], values[5], values[8], values[11],  // m02, m12, m22, tz
      0, 0, 0, 1
    );
  }
  return matrix;
}

// Alias for backwards compatibility
const parseTransform = parseTransform3MF;

async function parseMeshFromDoc(doc: Document, defaultExtruder: number = 0): Promise<MeshData[]> {
  const meshes: MeshData[] = [];
  const meshElements = doc.getElementsByTagName('mesh');

  for (let j = 0; j < meshElements.length; j++) {
    const meshEl = meshElements[j];
    const vertices: number[] = [];
    const triangles: number[] = [];

    const vertexElements = meshEl.getElementsByTagName('vertex');
    for (let k = 0; k < vertexElements.length; k++) {
      const v = vertexElements[k];
      vertices.push(
        parseFloat(v.getAttribute('x') || '0'),
        parseFloat(v.getAttribute('y') || '0'),
        parseFloat(v.getAttribute('z') || '0')
      );
      if (k > 0 && k % YIELD_EVERY_N_VERTICES === 0) {
        await nextTick();
      }
    }

    const triangleElements = meshEl.getElementsByTagName('triangle');
    for (let k = 0; k < triangleElements.length; k++) {
      const t = triangleElements[k];
      triangles.push(
        parseInt(t.getAttribute('v1') || '0'),
        parseInt(t.getAttribute('v2') || '0'),
        parseInt(t.getAttribute('v3') || '0')
      );
      if (k > 0 && k % YIELD_EVERY_N_TRIANGLES === 0) {
        await nextTick();
      }
    }

    if (vertices.length > 0 && triangles.length > 0) {
      meshes.push({ vertices, triangles, extruder: defaultExtruder });
    }
  }
  return meshes;
}

function parsePlateIdFromAttributes(element: Element): number | null {
  const plateAttribute = Array.from(element.attributes).find((attr) => {
    const name = attr.name.toLowerCase();
    return (
      name === 'plate_id' ||
      name === 'plater_id' ||
      name === 'plateid' ||
      name === 'platerid' ||
      name.endsWith(':plate_id') ||
      name.endsWith(':plater_id')
    );
  });

  if (!plateAttribute?.value) return null;
  const parsed = Number.parseInt(plateAttribute.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function parse3MF(arrayBuffer: ArrayBuffer): Promise<Parsed3MFData> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch {
    throw new Error('Unsupported file format');
  }
  const objects = new Map<string, ObjectData>();
  const buildItems: BuildItem[] = [];
  const plateBounds = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();
  const plateOffsets = new Map<number, { offsetX: number; offsetY: number }>();
  const parser = new DOMParser();

  // Helper to load and parse a model file from the zip
  async function loadModelFile(path: string): Promise<Document | null> {
    // Normalize path (remove leading slash)
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const file = zip.files[normalizedPath];
    if (!file) return null;
    const content = await file.async('string');
    return parser.parseFromString(content, 'application/xml');
  }

  // Parse model_settings.config to get extruder assignments
  // Maps: object ID -> default extruder, and (object ID, part ID) -> part-specific extruder
  const extruderMapById = new Map<string, number>();
  const partExtruderMap = new Map<string, number>(); // Key: "objectId:partId"
  const objectNameById = new Map<string, string>();
  const plateAssignmentsByObjectId = new Map<string, number>();
  const modelSettingsFile = zip.files['Metadata/model_settings.config'];
  if (modelSettingsFile) {
    try {
      const content = await modelSettingsFile.async('string');
      const doc = parser.parseFromString(content, 'application/xml');
      const objectElements = doc.getElementsByTagName('object');
      for (let i = 0; i < objectElements.length; i++) {
        const objEl = objectElements[i];
        const objectId = objEl.getAttribute('id');
        if (!objectId) continue;

        // Find object-level extruder + name
        const directMetadata = Array.from(objEl.children).filter(
          (el) => el.tagName === 'metadata' && el.getAttribute('key') === 'extruder'
        );
        if (directMetadata.length > 0) {
          const extruderVal = directMetadata[0].getAttribute('value');
          if (extruderVal) {
            extruderMapById.set(objectId, Math.max(0, parseInt(extruderVal, 10) - 1));
          }
        }

        const nameMetadata = Array.from(objEl.children).find(
          (el) => el.tagName === 'metadata' && el.getAttribute('key') === 'name'
        );
        const objectName = nameMetadata?.getAttribute('value');
        if (objectName) {
          objectNameById.set(objectId, objectName);
        }

        // Find part-level extruders
        const partElements = objEl.getElementsByTagName('part');
        for (let j = 0; j < partElements.length; j++) {
          const partEl = partElements[j];
          const partId = partEl.getAttribute('id');
          if (!partId) continue;

          // Look for extruder in part's direct children
          const partMetadata = Array.from(partEl.children).filter(
            (el) => el.tagName === 'metadata' && el.getAttribute('key') === 'extruder'
          );
          if (partMetadata.length > 0) {
            const extruderVal = partMetadata[0].getAttribute('value');
            if (extruderVal) {
              partExtruderMap.set(`${objectId}:${partId}`, Math.max(0, parseInt(extruderVal, 10) - 1));
            }
          }
        }
      }

      // Parse plate -> object assignments
      const plateElements = doc.getElementsByTagName('plate');
      for (let i = 0; i < plateElements.length; i++) {
        const plateEl = plateElements[i];
        let plateId: number | null = null;
        const metadataElements = plateEl.getElementsByTagName('metadata');
        let plateOffsetX = 0;
        let plateOffsetY = 0;
        for (let j = 0; j < metadataElements.length; j++) {
          const metaEl = metadataElements[j];
          const key = metaEl.getAttribute('key');
          if (key === 'plater_id' || key === 'plate_id') {
            const value = metaEl.getAttribute('value');
            if (value) {
              const parsed = Number.parseInt(value, 10);
              if (Number.isFinite(parsed)) {
                plateId = parsed;
              }
            }
          } else if (key === 'pos_x') {
            const value = metaEl.getAttribute('value');
            const parsed = value ? Number.parseFloat(value) : Number.NaN;
            if (Number.isFinite(parsed)) {
              plateOffsetX = parsed;
            }
          } else if (key === 'pos_y') {
            const value = metaEl.getAttribute('value');
            const parsed = value ? Number.parseFloat(value) : Number.NaN;
            if (Number.isFinite(parsed)) {
              plateOffsetY = parsed;
            }
          }
        }
        if (plateId == null) continue;
        if (plateOffsetX !== 0 || plateOffsetY !== 0) {
          plateOffsets.set(plateId, { offsetX: plateOffsetX, offsetY: plateOffsetY });
        }

        const modelInstances = plateEl.getElementsByTagName('model_instance');
        for (let j = 0; j < modelInstances.length; j++) {
          const instanceEl = modelInstances[j];
          const instanceMetadata = instanceEl.getElementsByTagName('metadata');
          for (let k = 0; k < instanceMetadata.length; k++) {
            const metaEl = instanceMetadata[k];
            if (metaEl.getAttribute('key') === 'object_id') {
              const value = metaEl.getAttribute('value');
              if (value) {
                plateAssignmentsByObjectId.set(value, plateId);
              }
            }
          }
        }
      }
    } catch {
      // Silently ignore model_settings.config parsing errors
    }
  }

  // Parse plate_*.json for plate assignments by object name (source-only / unsliced files)
  const plateAssignmentsByName = new Map<string, number>();
  const plateJsonNames = Object.keys(zip.files).filter(
    (name) => name.startsWith('Metadata/plate_') && name.endsWith('.json')
  );
  for (const name of plateJsonNames) {
    const match = name.match(/^Metadata\/plate_(\d+)\.json$/);
    if (!match) continue;
    const plateIndex = Number.parseInt(match[1], 10);
    if (!Number.isFinite(plateIndex)) continue;
    try {
      const payload = await zip.files[name].async('string');
      const json = JSON.parse(payload) as { bbox_objects?: Array<{ name?: string }>; bbox_all?: number[] };
      const objectsList = json.bbox_objects ?? [];
      for (const entry of objectsList) {
        if (entry?.name) {
          plateAssignmentsByName.set(entry.name, plateIndex);
        }
      }
      if (Array.isArray(json.bbox_all) && json.bbox_all.length >= 4) {
        const [minX, minY, maxX, maxY] = json.bbox_all;
        if ([minX, minY, maxX, maxY].every((value) => Number.isFinite(value))) {
          plateBounds.set(plateIndex, { minX, minY, maxX, maxY });
        }
      }
    } catch {
      // Ignore plate json parsing errors
    }
  }

  // Find the main 3D model file
  const mainModelPath = Object.keys(zip.files).find(
    (name) => name === '3D/3dmodel.model' || name.endsWith('/3dmodel.model')
  );

  if (!mainModelPath) {
    // Fallback: try to find any .model file
    const anyModelPath = Object.keys(zip.files).find((name) => name.endsWith('.model'));
    if (anyModelPath) {
      const doc = await loadModelFile(anyModelPath);
      if (doc) {
        const meshes = await parseMeshFromDoc(doc, 0);
        if (meshes.length > 0) {
          objects.set('1', { id: '1', meshes, defaultExtruder: 0 });
        }
      }
    }
    return { objects, buildItems, plateBounds, plateOffsets };
  }

  const mainDoc = await loadModelFile(mainModelPath);
  if (!mainDoc) return { objects, buildItems, plateBounds, plateOffsets };

  // Parse objects - Bambu Studio uses components to reference external files
  const objectElements = mainDoc.getElementsByTagName('object');
  for (let i = 0; i < objectElements.length; i++) {
    // Yield once per top-level object so the modal stays interactive
    // throughout the parse (#1412). Inner vertex/triangle/component
    // loops yield on their own. See nextTick() comment near the top.
    if (i > 0) {
      await nextTick();
    }
    const objEl = objectElements[i];
    const objectId = objEl.getAttribute('id');
    if (!objectId) continue;

    const objectPlateId = parsePlateIdFromAttributes(objEl) ?? plateAssignmentsByObjectId.get(objectId) ?? null;

    // Get default extruder from model_settings.config map, falling back to attribute or default
    let defaultExtruder = extruderMapById.get(objectId) ?? -1;
    if (defaultExtruder < 0) {
      const extruderAttr = objEl.getAttribute('p:extruder') || objEl.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'extruder') || '1';
      defaultExtruder = Math.max(0, parseInt(extruderAttr, 10) - 1);
    }

    const meshes: MeshData[] = [];

    // Check for direct mesh in this object
    const objMeshElements = objEl.getElementsByTagName('mesh');
    for (let j = 0; j < objMeshElements.length; j++) {
      const meshEl = objMeshElements[j];
      const vertices: number[] = [];
      const triangles: number[] = [];

      const vertexElements = meshEl.getElementsByTagName('vertex');
      for (let k = 0; k < vertexElements.length; k++) {
        const v = vertexElements[k];
        vertices.push(
          parseFloat(v.getAttribute('x') || '0'),
          parseFloat(v.getAttribute('y') || '0'),
          parseFloat(v.getAttribute('z') || '0')
        );
        if (k > 0 && k % YIELD_EVERY_N_VERTICES === 0) {
          await nextTick();
        }
      }

      const triangleElements = meshEl.getElementsByTagName('triangle');
      for (let k = 0; k < triangleElements.length; k++) {
        const t = triangleElements[k];
        triangles.push(
          parseInt(t.getAttribute('v1') || '0'),
          parseInt(t.getAttribute('v2') || '0'),
          parseInt(t.getAttribute('v3') || '0')
        );
        if (k > 0 && k % YIELD_EVERY_N_TRIANGLES === 0) {
          await nextTick();
        }
      }

      if (vertices.length > 0 && triangles.length > 0) {
        meshes.push({ vertices, triangles, extruder: defaultExtruder });
      }
    }

    // Check for component references (Bambu Studio style)
    const componentElements = objEl.getElementsByTagName('component');
    for (let j = 0; j < componentElements.length; j++) {
      // Yield before each component — each one triggers another async file
      // load + DOM parse + vertex/triangle iteration. Multi-color "parted"
      // statues from MakerWorld can have dozens of components; without
      // this yield the whole chain runs as one long synchronous burst
      // between awaits and freezes the modal close button (#1412).
      await nextTick();
      const compEl = componentElements[j];
      // p:path attribute contains the external file reference
      const extPath = compEl.getAttribute('p:path') || compEl.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06', 'path');
      // objectid in component corresponds to part id in model_settings
      const compObjectId = compEl.getAttribute('objectid');

      if (extPath) {
        const extDoc = await loadModelFile(extPath);
        if (extDoc) {
          // Look up per-part extruder, falling back to object's default
          const partKey = compObjectId ? `${objectId}:${compObjectId}` : null;
          const compExtruder = partKey ? (partExtruderMap.get(partKey) ?? defaultExtruder) : defaultExtruder;

          const extMeshes = await parseMeshFromDoc(extDoc, compExtruder);

          // Apply component transform if present
          const compTransformStr = compEl.getAttribute('transform');
          const compTransform = parseTransform(compTransformStr);

          for (const mesh of extMeshes) {
            if (compTransformStr) {
              // Apply transform to vertices (in 3MF coordinate space, before Y/Z swap)
              const transformedVertices: number[] = [];
              for (let k = 0; k < mesh.vertices.length; k += 3) {
                const v = new THREE.Vector3(mesh.vertices[k], mesh.vertices[k + 1], mesh.vertices[k + 2]);
                v.applyMatrix4(compTransform);
                transformedVertices.push(v.x, v.y, v.z);
              }
              meshes.push({ vertices: transformedVertices, triangles: mesh.triangles, extruder: mesh.extruder });
            } else {
              meshes.push(mesh);
            }
          }
        }
      }
    }

    if (meshes.length > 0) {
      objects.set(objectId, { id: objectId, meshes, defaultExtruder, plateId: objectPlateId });
    }
  }

  // Parse build items (placement on build plate)
  const buildElements = mainDoc.getElementsByTagName('build');
  if (buildElements.length > 0) {
    const itemElements = buildElements[0].getElementsByTagName('item');
    for (let i = 0; i < itemElements.length; i++) {
      const itemEl = itemElements[i];
      const objectId = itemEl.getAttribute('objectid');
      if (!objectId) continue;

      const transform = parseTransform(itemEl.getAttribute('transform'));
      const itemPlateId = parsePlateIdFromAttributes(itemEl);
      const objectPlateId = objects.get(objectId)?.plateId ?? null;
      const objectName = objectNameById.get(objectId);
      const namePlateId = objectName ? plateAssignmentsByName.get(objectName) ?? null : null;
      buildItems.push({ objectId, transform, plateId: itemPlateId ?? objectPlateId ?? namePlateId ?? null });
    }
  }

  return { objects, buildItems, plateBounds, plateOffsets };
}

export function createGeometryFromMesh(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  // Convert from 3MF Z-up to Three.js Y-up coordinate system
  // 3MF: X right, Y back, Z up -> Three.js: X right, Y up, Z forward
  const positions = new Float32Array(mesh.vertices.length);
  for (let i = 0; i < mesh.vertices.length; i += 3) {
    positions[i] = mesh.vertices[i];       // X stays X
    positions[i + 1] = mesh.vertices[i + 2]; // Y becomes Z (up)
    positions[i + 2] = mesh.vertices[i + 1]; // Z becomes Y
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(mesh.triangles);

  // Compute normals
  geometry.computeVertexNormals();

  return geometry;
}

export function disposeGroup(group: THREE.Group) {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        for (const material of child.material) {
          material.dispose();
        }
      } else {
        child.material.dispose();
      }
    }
  });
}

export function buildModelGroup(
  parsedData: Parsed3MFData,
  selectedPlateId: number | null,
  filamentColors?: string[],
): THREE.Group {
  const { objects, buildItems } = parsedData;
  const group = new THREE.Group();

  // Create materials for each extruder color
  const getMaterial = (extruder: number): THREE.MeshStandardMaterial => {
    const defaultColor = '#00ae42';
    const colorStr = filamentColors?.[extruder] || defaultColor;
    // Convert hex color string to THREE.js color
    const color = new THREE.Color(colorStr);
    // Matte plastic against the scene's environment map. Phong lit only by
    // direct lights gave every same-facing surface an identical colour, which
    // is what flattened models into silhouettes. Roughness is high because
    // FDM prints are not glossy, but not 1.0 -- a little specular is what
    // makes layer-scale surface detail legible.
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.62,
      metalness: 0.0,
      envMapIntensity: 0.55,
      flatShading: false,
    });
  };

  // Group geometries by extruder index (using per-mesh extruder)
  const geometriesByExtruder = new Map<number, THREE.BufferGeometry[]>();

  const hasPlateAssignments = buildItems.some((item) => item.plateId != null);
  const plateFilteredItems = selectedPlateId == null || !hasPlateAssignments
    ? buildItems
    : buildItems.filter((item) => item.plateId === selectedPlateId);
  const activeBuildItems = plateFilteredItems.length > 0 ? plateFilteredItems : buildItems;

  // If we have build items, use them for positioning
  if (activeBuildItems.length > 0) {
    for (const item of activeBuildItems) {
      const objectData = objects.get(item.objectId);
      if (!objectData) continue;

      for (const meshData of objectData.meshes) {
        // Use mesh's extruder, or item override, or object default
        const extruder = item.extruder ?? meshData.extruder;

        // Apply build transform to vertices in 3MF space BEFORE coordinate conversion
        const transformedVertices: number[] = [];
        for (let k = 0; k < meshData.vertices.length; k += 3) {
          const v = new THREE.Vector3(
            meshData.vertices[k],
            meshData.vertices[k + 1],
            meshData.vertices[k + 2]
          );
          v.applyMatrix4(item.transform);
          transformedVertices.push(v.x, v.y, v.z);
        }
        // Now create geometry with coordinate conversion
        const geometry = createGeometryFromMesh({
          vertices: transformedVertices,
          triangles: meshData.triangles,
          extruder: extruder,
        });

        if (!geometriesByExtruder.has(extruder)) {
          geometriesByExtruder.set(extruder, []);
        }
        geometriesByExtruder.get(extruder)!.push(geometry);
      }
    }
  } else {
    // Fallback: just add all objects without transforms
    for (const objectData of objects.values()) {
      for (const meshData of objectData.meshes) {
        // Use per-mesh extruder
        const extruder = meshData.extruder;
        const geometry = createGeometryFromMesh(meshData);
        if (!geometriesByExtruder.has(extruder)) {
          geometriesByExtruder.set(extruder, []);
        }
        geometriesByExtruder.get(extruder)!.push(geometry);
      }
    }
  }

  // Create meshes for each extruder group
  for (const [extruder, geometries] of geometriesByExtruder) {
    if (geometries.length === 0) continue;

    const mergedGeometry = geometries.length === 1
      ? geometries[0]
      : mergeGeometries(geometries, false);

    if (mergedGeometry) {
      const material = getMaterial(extruder);
      const mesh = new THREE.Mesh(mergedGeometry, material);
      mesh.castShadow = true;
      group.add(mesh);
    }

    // Dispose individual geometries if merged
    if (geometries.length > 1) {
      for (const geom of geometries) {
        geom.dispose();
      }
    }
  }

  return group;
}

// One mesh per STEP shape so per-part colours survive; parts without a colour
// fall back to the same filament colour the STL path uses.
export function buildStepGroup(meshes: StepMeshData[], filamentColors?: string[]): THREE.Group {
  const group = new THREE.Group();
  const fallback = filamentColors?.[0] || '#00ae42';
  for (const meshData of meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
    if (meshData.normals) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
    }
    if (meshData.indices) {
      geometry.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
    }
    if (!meshData.normals) {
      geometry.computeVertexNormals();
    }
    // STEP is Z-up like STL; three.js is Y-up.
    geometry.rotateX(-Math.PI / 2);
    const color = meshData.color
      ? new THREE.Color(meshData.color[0], meshData.color[1], meshData.color[2])
      : new THREE.Color(fallback);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.62,
      metalness: 0.0,
      envMapIntensity: 0.55,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    group.add(mesh);
  }
  return group;
}
