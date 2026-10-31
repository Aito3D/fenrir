/** Mesh analysis for the Model tab (propositions 1 and 2): how much of the surface overhangs
 *  past an angle, and which vertices sit on a wall thinner than a threshold. The overhang share
 *  is a pass over the triangle normals; the thickness samples the mesh with a BVH, in time
 *  slices so the frame loop keeps running, and writes a per-vertex `thin` attribute the shader
 *  tints. Both work in the scene's frame, where +y is up and the model sits on y = 0. */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Faces lower than this above the bed are the first layer, never an overhang. */
const BED_SKIN = 0.3;
const SLICE_MS = 10;

/** Share (0..1) of the surface area whose overhang angle is at or past `deg` (walls are 0°,
 *  a flat underside 90°), ignoring the faces resting on the bed. */
export function overhangShare(geometries: Array<{ geometry: THREE.BufferGeometry; worldY: number }>, deg: number): number {
  const threshold = Math.sin(THREE.MathUtils.degToRad(deg));
  let over = 0;
  let total = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const { geometry, worldY } of geometries) {
    const pos = geometry.attributes.position;
    if (!pos) continue;
    const idx = geometry.index;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const ia = idx ? idx.getX(i) : i;
      const ib = idx ? idx.getX(i + 1) : i + 1;
      const ic = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const area = n.length() / 2;
      if (area === 0) continue;
      n.divideScalar(area * 2);
      total += area;
      const lowest = Math.min(a.y, b.y, c.y) + worldY;
      if (lowest <= BED_SKIN) continue;
      if (-n.y >= threshold) over += area;
    }
  }
  return total > 0 ? over / total : 0;
}

export interface ThinWallsResult {
  /** Share (0..1) of the sampled vertices on a wall thinner than the threshold. */
  share: number;
  sampled: number;
}

/** Samples every vertex (or a stride of them on very large meshes), casting a ray inward along
 *  the inverted normal to the opposite wall; a hit closer than `mm` marks the vertex thin. The
 *  work is chunked; `onDone` fires unless `cancel()` was called. The BVH is cached on the
 *  geometry for the next run. */
export function measureThinWalls(
  meshes: THREE.Mesh[],
  mm: number,
  onDone: (result: ThinWallsResult) => void,
): () => void {
  let cancelled = false;
  const ray = new THREE.Ray();
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const jobs = meshes
    .filter((m) => m.geometry.attributes.position && m.geometry.attributes.normal)
    .map((m) => {
      const geometry = m.geometry;
      const count = geometry.attributes.position.count;
      const stride = Math.max(1, Math.ceil(count / 200_000));
      const thin = new Float32Array(count);
      return { geometry, count, stride, thin, at: 0 };
    });
  let thinCount = 0;
  let sampled = 0;
  let job = 0;
  const step = () => {
    if (cancelled) return;
    const started = performance.now();
    while (job < jobs.length) {
      const j = jobs[job];
      const bvh = (j.geometry.userData.bvh as MeshBVH | undefined) ?? new MeshBVH(j.geometry);
      j.geometry.userData.bvh = bvh;
      const pos = j.geometry.attributes.position;
      const normal = j.geometry.attributes.normal;
      while (j.at < j.count) {
        const i = j.at;
        p.fromBufferAttribute(pos, i);
        nrm.fromBufferAttribute(normal, i).normalize();
        ray.origin.copy(p).addScaledVector(nrm, -0.02);
        ray.direction.copy(nrm).negate();
        const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, mm + 0.02);
        const isThin = hit !== null && hit.distance <= mm;
        sampled += 1;
        if (isThin) thinCount += 1;
        // Unsampled neighbours (in index order, which is spatially coherent) take the same value.
        const v = isThin ? 1 : 0;
        for (let k = i; k < Math.min(j.count, i + j.stride); k += 1) j.thin[k] = v;
        j.at += j.stride;
        if (performance.now() - started > SLICE_MS) {
          setTimeout(step, 0);
          return;
        }
      }
      j.geometry.setAttribute('thin', new THREE.BufferAttribute(j.thin, 1));
      job += 1;
    }
    onDone({ share: sampled > 0 ? thinCount / sampled : 0, sampled });
  };
  setTimeout(step, 0);
  return () => {
    cancelled = true;
  };
}

/** Removes the `thin` attribute again (the shader then tints nothing). */
export function clearThinWalls(meshes: THREE.Mesh[]) {
  for (const m of meshes) if (m.geometry.attributes.thin) m.geometry.deleteAttribute('thin');
}
