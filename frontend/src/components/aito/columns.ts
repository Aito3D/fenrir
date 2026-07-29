import type { ColumnId } from '../../utils/aitoBoard';

export interface ColumnMeta {
  id: ColumnId;
  labelKey: string;
  dot: string;
  ring: string;
}

// Stage accents follow the pipeline temperature: quote (cool) → modeling →
// printing (hot) → pickup (cooling off the bench) → finished (brand green, the
// app's "done" color).
export const COLUMNS: ColumnMeta[] = [
  { id: 'devis', labelKey: 'aito.columns.devis', dot: 'bg-sky-400', ring: 'ring-sky-400/30' },
  { id: 'model', labelKey: 'aito.columns.model', dot: 'bg-violet-400', ring: 'ring-violet-400/30' },
  { id: 'print', labelKey: 'aito.columns.print', dot: 'bg-orange-400', ring: 'ring-orange-400/30' },
  { id: 'pickup', labelKey: 'aito.columns.pickup', dot: 'bg-amber-400', ring: 'ring-amber-400/30' },
  { id: 'finish', labelKey: 'aito.columns.finish', dot: 'bg-bambu-green', ring: 'ring-bambu-green/30' },
];
