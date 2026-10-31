import type { BuildVolume } from './printerBeds';

/** What the viewer can tell from the data it already holds (proposition 13). Pure. */
export interface ViewerCheck {
  id: 'bed' | 'sliced' | 'supports' | 'revision' | 'filaments' | 'overhangs' | 'thinWalls';
  level: 'ok' | 'warn' | 'info';
  /** i18n key under `partViewer.checks`; `params` fill it. */
  key: string;
  params?: Record<string, string | number>;
}

export interface CheckInput {
  /** The model's bounding box in printer millimetres (x right, y back, z up), once loaded. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  volume: BuildVolume;
  /** The toolpath is loaded (a sliced file exists); null while unknown. */
  sliced: boolean | null;
  /** Share of extrusion length that is support, 0..1, from the toolpath; null without one. */
  supportShare: number | null;
  /** The revision is outdated against a newer one (projects only). */
  outdatedBy: string | null;
  /** Filament slots the sliced plate uses: `A1 · PETG`. */
  filaments: string[];
  /** Share of the surface past the overhang angle, while that analysis is on; null otherwise. */
  overhangs?: { share: number; deg: number } | null;
  /** Share of the sampled surface thinner than `mm`, while that analysis is on; null otherwise. */
  thinWalls?: { share: number; mm: number } | null;
}

const EPS = 0.5;

export function runChecks(input: CheckInput): ViewerCheck[] {
  const out: ViewerCheck[] = [];
  if (input.bbox) {
    const [minX, minY, minZ] = input.bbox.min;
    const [maxX, maxY, maxZ] = input.bbox.max;
    const inside = minX >= -EPS && minY >= -EPS && minZ >= -EPS && maxX <= input.volume.x + EPS && maxY <= input.volume.y + EPS && maxZ <= input.volume.z + EPS;
    out.push(
      inside
        ? { id: 'bed', level: 'ok', key: 'insideBed', params: { x: input.volume.x, y: input.volume.y } }
        : { id: 'bed', level: 'warn', key: 'outsideBed', params: { x: input.volume.x, y: input.volume.y, z: input.volume.z } },
    );
  }
  if (input.sliced === false) out.push({ id: 'sliced', level: 'warn', key: 'notSliced' });
  if (input.supportShare !== null) {
    out.push(
      input.supportShare > 0.001
        ? { id: 'supports', level: 'info', key: 'supports', params: { pct: Math.round(input.supportShare * 100) } }
        : { id: 'supports', level: 'ok', key: 'noSupports' },
    );
  }
  if (input.outdatedBy) out.push({ id: 'revision', level: 'warn', key: 'outdated', params: { by: input.outdatedBy } });
  else if (input.outdatedBy === null) out.push({ id: 'revision', level: 'ok', key: 'newest' });
  if (input.filaments.length > 0) out.push({ id: 'filaments', level: 'info', key: 'filaments', params: { list: input.filaments.join(', ') } });
  if (input.overhangs) {
    const pct = Math.round(input.overhangs.share * 100);
    out.push(pct >= 1 ? { id: 'overhangs', level: 'warn', key: 'overhangs', params: { pct, deg: input.overhangs.deg } } : { id: 'overhangs', level: 'ok', key: 'noOverhangs', params: { deg: input.overhangs.deg } });
  }
  if (input.thinWalls) {
    const pct = Math.round(input.thinWalls.share * 1000) / 10;
    out.push(pct >= 0.5 ? { id: 'thinWalls', level: 'warn', key: 'thinWalls', params: { pct, mm: input.thinWalls.mm } } : { id: 'thinWalls', level: 'ok', key: 'noThinWalls', params: { mm: input.thinWalls.mm } });
  }
  return out;
}
