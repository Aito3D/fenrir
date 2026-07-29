import type { ColumnId } from '../../utils/aitoBoard';

export interface ColumnMeta {
  id: ColumnId;
  labelKey: string;
  dot: string;
  ring: string;
}

// Stage accents follow the pipeline temperature: quote (cool) → waiting (amber:
// stalled on someone else, the board's one "needs chasing" tone) → scan →
// modeling → printing (hot) → finish (brand green, the app's "done" colour, and
// the moment the work is actually finished) → done (inert grey: the archive,
// not an achievement).
export const COLUMNS: ColumnMeta[] = [
  { id: 'devis', labelKey: 'aito.columns.devis', dot: 'bg-sky-400', ring: 'ring-sky-400/30' },
  { id: 'waiting', labelKey: 'aito.columns.waiting', dot: 'bg-amber-400', ring: 'ring-amber-400/30' },
  { id: 'scan', labelKey: 'aito.columns.scan', dot: 'bg-teal-400', ring: 'ring-teal-400/30' },
  { id: 'model', labelKey: 'aito.columns.model', dot: 'bg-violet-400', ring: 'ring-violet-400/30' },
  { id: 'print', labelKey: 'aito.columns.print', dot: 'bg-orange-400', ring: 'ring-orange-400/30' },
  { id: 'finish', labelKey: 'aito.columns.finish', dot: 'bg-bambu-green', ring: 'ring-bambu-green/30' },
  { id: 'done', labelKey: 'aito.columns.done', dot: 'bg-bambu-gray', ring: 'ring-bambu-gray/30' },
];
