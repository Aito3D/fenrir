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
// the moment the work is actually finished). Done's own accent moved to
// `DONE_COLUMN` below — it is no longer one of the board's rendered columns.
export const COLUMNS: ColumnMeta[] = [
  { id: 'devis', labelKey: 'aito.columns.devis', dot: 'bg-sky-400', ring: 'ring-sky-400/30' },
  { id: 'waiting', labelKey: 'aito.columns.waiting', dot: 'bg-amber-400', ring: 'ring-amber-400/30' },
  { id: 'scan', labelKey: 'aito.columns.scan', dot: 'bg-teal-400', ring: 'ring-teal-400/30' },
  { id: 'model', labelKey: 'aito.columns.model', dot: 'bg-violet-400', ring: 'ring-violet-400/30' },
  { id: 'print', labelKey: 'aito.columns.print', dot: 'bg-orange-400', ring: 'ring-orange-400/30' },
  { id: 'finish', labelKey: 'aito.columns.finish', dot: 'bg-bambu-green', ring: 'ring-bambu-green/30' },
];

/** Done, kept out of `COLUMNS` so the board does not render it.
 *
 *  Done is an archive, not a stage: it only grows, and it was costing a full
 *  column of the horizontal space the six working stages need. It lives behind
 *  the Show Done toggle now, as a grid. The column id itself is untouched
 *  everywhere else — `COLUMN_IDS`, `buildBoard` and the cache all still carry
 *  it; only the board's rendering changed. */
const DONE_COLUMN: ColumnMeta = {
  id: 'done',
  labelKey: 'aito.columns.done',
  dot: 'bg-bambu-gray',
  ring: 'ring-bambu-gray/30',
};

/** Every column including Done, for surfaces that must LABEL whatever column a
 *  card is in rather than render the board — the detail panel. Reading
 *  `COLUMNS` there would leave every finished card with no badge at all. */
export const ALL_COLUMNS: ColumnMeta[] = [...COLUMNS, DONE_COLUMN];

/** Columns whose cards are NOT work in production.
 *
 *  A card in Quote is waiting on an acceptance and a card in Waiting is out
 *  with the client — in both the ball is in someone else's court, so neither
 *  is anybody's workload. Done is excluded for free: it is not in `COLUMNS`.  */
const PARKED_COLUMN_IDS: ColumnId[] = ['devis', 'waiting'];

/** The columns the title's count adds up: everything on the board that someone
 *  is actually doing.
 *
 *  Derived by exclusion rather than listed, and deliberately not
 *  `COLUMNS.slice(2)`. Both are correct today; only this one stays correct
 *  when a stage is reordered or a new one is inserted, which would silently
 *  change what the number beside the page title means. */
export const ACTIVE_COLUMN_IDS: ColumnId[] = COLUMNS.map((column) => column.id).filter(
  (id) => !PARKED_COLUMN_IDS.includes(id),
);
