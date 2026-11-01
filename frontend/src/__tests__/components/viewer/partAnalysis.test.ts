/** The Model tab's mesh analyses, on hand-built geometry: the overhang share from the face
 *  normals (the bed skin excluded) and the thin-wall sampling through the BVH, in time slices. */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { clearThinWalls, measureThinWalls, overhangShare } from '../../../components/viewer/partAnalysis';

/** A horizontal quad at height `y` spanning [x0,x1]×[z0,z1], its normal straight up or down. */
function quad(y: number, x0: number, x1: number, z0: number, z1: number, up: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1];
  const ny = up ? 1 : -1;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, ny, 0, 0, ny, 0, 0, ny, 0, 0, ny, 0], 3));
  // Counter-clockwise seen from above for an upward normal, so the cross product points the same way.
  g.setIndex(up ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  let base = 0;
  for (const p of parts) {
    positions.push(...Array.from(p.attributes.position.array));
    normals.push(...Array.from(p.attributes.normal.array));
    index.push(...Array.from(p.index!.array).map((i) => i + base));
    base += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(index);
  return g;
}

describe('overhangShare', () => {
  it('a box on the bed overhangs nothing: the underside is bed skin, the walls are vertical', () => {
    const box = new THREE.BoxGeometry(10, 10, 10).translate(0, 5, 0);
    expect(overhangShare([{ geometry: box, worldY: 0 }], 45)).toBe(0);
  });

  it('the same box lifted off the bed overhangs by its underside: one face in six', () => {
    const box = new THREE.BoxGeometry(10, 10, 10).translate(0, 5, 0);
    expect(overhangShare([{ geometry: box, worldY: 20 }], 45)).toBeCloseTo(1 / 6, 6);
    // Non-indexed geometry walks the same triangles.
    expect(overhangShare([{ geometry: box.toNonIndexed(), worldY: 20 }], 45)).toBeCloseTo(1 / 6, 6);
  });

  it('counts by area, past the angle only, and skips degenerate triangles and geometry with no positions', () => {
    // A 10×10 downward-facing quad (area 100) above a 20×20 upward one (area 400), both in the air.
    const under = quad(5, 0, 10, 0, 10, false);
    const top = quad(5, 0, 20, 0, 20, true);
    expect(overhangShare([{ geometry: under, worldY: 10 }, { geometry: top, worldY: 10 }], 45)).toBeCloseTo(100 / 500, 6);
    // A slope: a face whose normal points 30° below horizontal passes a 20° threshold, not 45°.
    const slope = new THREE.BufferGeometry();
    const a = Math.sin(THREE.MathUtils.degToRad(30));
    const b = Math.cos(THREE.MathUtils.degToRad(30));
    slope.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 10, 0, 0, 0, 10 * b, -10 * a], 3));
    slope.setIndex([0, 1, 2]);
    const dir = new THREE.Vector3().subVectors(new THREE.Vector3(10, 0, 0), new THREE.Vector3(0, 0, 0)).cross(new THREE.Vector3(0, 10 * b, -10 * a)).normalize();
    const facesDown = dir.y < 0;
    const shareAt = (deg: number) => overhangShare([{ geometry: slope, worldY: 10 }], deg);
    expect(shareAt(20)).toBe(facesDown ? 1 : 0);
    expect(shareAt(45)).toBe(0);
    // Degenerate: three collinear points (area 0) contribute nothing; no positions at all is skipped.
    const flat = new THREE.BufferGeometry();
    flat.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0], 3));
    expect(overhangShare([{ geometry: flat, worldY: 10 }, { geometry: new THREE.BufferGeometry(), worldY: 0 }], 45)).toBe(0);
  });
});

describe('measureThinWalls', () => {
  const done = (meshes: THREE.Mesh[], mm: number) =>
    new Promise<{ share: number; sampled: number }>((resolve) => {
      measureThinWalls(meshes, mm, resolve);
    });

  it('marks the vertices whose opposite wall is nearer than the threshold, writes the per-vertex attribute and caches the BVH', async () => {
    // A slab: a 10×10 top at y=0.5 over a wider bottom at y=0. Looking inward, the top's four
    // vertices meet the bottom 0.5 mm away; the bottom's four look up past the smaller top.
    const slab = merge([quad(0.5, 0, 10, 0, 10, true), quad(0, -1, 11, -1, 11, false)]);
    const mesh = new THREE.Mesh(slab);
    const result = await done([mesh], 1);
    expect(result).toEqual({ share: 0.5, sampled: 8 });
    const thin = slab.attributes.thin as THREE.BufferAttribute;
    expect(Array.from(thin.array)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(slab.userData.bvh).toBeDefined();
    const bvh = slab.userData.bvh;
    // A thicker threshold finds nothing new; a thinner slab limit finds nothing at all. The BVH is reused.
    expect(await done([mesh], 0.4)).toEqual({ share: 0, sampled: 8 });
    expect(slab.userData.bvh).toBe(bvh);
    clearThinWalls([mesh]);
    expect(slab.attributes.thin).toBeUndefined();
    clearThinWalls([mesh]); // idempotent
  });

  it('skips meshes without positions or normals and reports zero over nothing sampled', async () => {
    const bare = new THREE.Mesh(new THREE.BufferGeometry());
    expect(await done([bare], 1)).toEqual({ share: 0, sampled: 0 });
  });

  it('cancel() before the first slice runs means onDone never fires', async () => {
    const slab = merge([quad(0.5, 0, 10, 0, 10, true), quad(0, -1, 11, -1, 11, false)]);
    const onDone = vi.fn();
    const cancel = measureThinWalls([new THREE.Mesh(slab)], 1, onDone);
    cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(onDone).not.toHaveBeenCalled();
    expect(slab.attributes.thin).toBeUndefined();
  });

  it('a mesh too big for one slice is finished across several timeouts', async () => {
    // Force a slice boundary after the first vertex by making the clock jump past SLICE_MS.
    let now = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (now += 6));
    try {
      const slab = merge([quad(0.5, 0, 10, 0, 10, true), quad(0, -1, 11, -1, 11, false)]);
      const result = await done([new THREE.Mesh(slab)], 1);
      expect(result).toEqual({ share: 0.5, sampled: 8 });
    } finally {
      spy.mockRestore();
    }
  });
});
