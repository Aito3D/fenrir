// The Order Board's list logic: pure functions over the rows the server computed.
//
// Which number follows which filter is the part that is easy to get wrong:
//   tiles and total value  -> byBrand only
//   chip counts            -> byBrand + bySearch
//   the list               -> byBrand + bySearch + byStatus
import type {
  FinishedOrderRow,
  OrderBoardLine,
  OrderBoardResponse,
  OrderBoardRow,
  OrderEditLine,
  OrderItemHit,
  OrderPackage,
  OrderPanelRow,
  OrderPayState,
  OrderPicklist,
  OrderStatus,
} from '../../api/client';

export type StatusFilter = 'all' | OrderStatus;
export type PayFilter = 'all' | OrderPayState | 'overdue';
export type SortKey = 'age' | 'value' | 'customer' | 'ready';

/** Lower-case with accents stripped, so "LYCEE" finds "Lycée". */
export const foldText = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const byBrand = (rows: OrderBoardRow[], coreOnly: boolean): OrderBoardRow[] =>
  coreOnly ? rows.filter(r => r.is_core) : rows;

export const bySearch = (rows: OrderBoardRow[], query: string): OrderBoardRow[] => {
  const q = foldText(query).trim();
  if (!q) return rows;
  return rows.filter(r =>
    [r.number, r.customer, r.facts.reference, ...r.lines.flatMap(l => [l.name, l.sku])].some(text => foldText(text).includes(q)),
  );
};

export const byStatus = (rows: OrderBoardRow[], status: StatusFilter): OrderBoardRow[] =>
  status === 'all' ? rows : rows.filter(r => r.status === status);

export const countByStatus = (rows: OrderBoardRow[]): Record<StatusFilter, number> => {
  const counts: Record<StatusFilter, number> = { all: rows.length, to_ship: 0, partial: 0, incoming: 0, to_order: 0 };
  for (const r of rows) counts[r.status] += 1;
  return counts;
};

const PAY_FILTERS: PayFilter[] = ['all', 'unpaid', 'partial', 'paid', 'overdue'];

const matchesPayment = (p: { state: OrderPayState; overdue: number } | null, filter: PayFilter): boolean =>
  filter === 'all' || (!!p && (filter === 'overdue' ? p.overdue > 0 : p.state === filter));

export const byPayment = (rows: OrderBoardRow[], filter: PayFilter): OrderBoardRow[] =>
  rows.filter(r => matchesPayment(r.payment, filter));

export const countByPayment = (rows: OrderBoardRow[]): Record<PayFilter, number> =>
  Object.fromEntries(PAY_FILTERS.map(f => [f, byPayment(rows, f).length])) as Record<PayFilter, number>;

/** Floored, so 100 only ever means fully paid. */
export const paidPct = (rows: OrderBoardRow[]): number | null => {
  const withPay = rows.filter(r => r.payment);
  const total = withPay.reduce((n, r) => n + (r.total ?? 0), 0);
  if (total <= 0) return null;
  return Math.floor((withPay.reduce((n, r) => n + (r.payment?.paid ?? 0), 0) * 100) / total);
};

export const otherOpenOrders = (rows: OrderBoardRow[], row: OrderBoardRow): OrderBoardRow[] =>
  row.customer_id ? rows.filter(r => r.customer_id === row.customer_id && r.id !== row.id) : [];

export const finishedPayState = (row: FinishedOrderRow): OrderPayState | null => row.payment?.state ?? row.paid_flag;

export const searchFinished = (rows: FinishedOrderRow[], query: string): FinishedOrderRow[] => {
  const q = foldText(query).trim();
  if (!q) return rows;
  return rows.filter(r => [r.number, r.customer, r.reference].some(text => foldText(text).includes(q)));
};

export const byFinishedPayment = (rows: FinishedOrderRow[], filter: PayFilter): FinishedOrderRow[] =>
  rows.filter(r => (filter === 'overdue' || filter === 'all' ? matchesPayment(r.payment, filter) : finishedPayState(r) === filter));

export const totalValue = (rows: OrderBoardRow[]): number => rows.reduce((sum, r) => sum + (r.total ?? 0), 0);

/** Default directions: age oldest first, value and % ready highest first, customer A to Z. */
type Sortable = Pick<OrderBoardRow, 'age_days' | 'total' | 'customer' | 'ready_ratio'>;
export const sortRows = <T extends Sortable>(rows: T[], key: SortKey, flipped: boolean, locale: string): T[] => {
  const compare: Record<SortKey, (a: T, b: T) => number> = {
    age: (a, b) => b.age_days - a.age_days,
    value: (a, b) => (b.total ?? 0) - (a.total ?? 0),
    customer: (a, b) => (a.customer ?? '').localeCompare(b.customer ?? '', locale),
    ready: (a, b) => b.ready_ratio - a.ready_ratio,
  };
  const sign = flipped ? -1 : 1;
  return [...rows].sort((a, b) => sign * compare[key](a, b));
};

/** One list entry: an open order, or a finished one given an age and 100 % ready so all sorts place it. */
export type BoardEntry = Sortable & ({ open: OrderBoardRow; fin?: never } | { fin: FinishedOrderRow; open?: never });

export const withFinished = (open: OrderBoardRow[], finished: FinishedOrderRow[]): BoardEntry[] => [
  ...open.map(r => ({ ...r, open: r })),
  ...finished.map(f => ({ age_days: daysPastDue(f.date), total: f.total, customer: f.customer, ready_ratio: 1, fin: f })),
];

/** An empty or half-built board must never look like a verified answer. */
export const isBoardReady = (r: OrderBoardResponse | undefined): boolean =>
  !!r && !!r.computed_at && !!r.stock_loaded_at;

export const pollMs = (r: OrderBoardResponse | undefined): number => {
  if (!r) return 4000;
  if (r.sync.running || r.sync.pending > 0) return 4000;
  // Never computed: fast, unless nothing is going to compute it.
  return !r.computed_at && r.sync.enabled && r.sync.configured ? 4000 : 60000;
};

export const ageTone = (days: number): 'neutral' | 'warning' | 'danger' =>
  days > 45 ? 'danger' : days > 20 ? 'warning' : 'neutral';

/** Quantities can be fractional (rope by the metre): at most 2 decimals, no trailing zeros. */
export const formatQty = (n: number): string => String(Math.round(n * 100) / 100);

/** Local noon of a YYYY-MM-DD day. `new Date('2026-09-12')` is UTC midnight,
 *  which is the 11th in UTC-10. */
export const parseDay = (isoDay: string): Date => {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12);
};

export interface PanelGroup {
  id: 'todo' | 'packed' | 'shipped' | 'other';
  /** null for the "other" group: services and cancelled lines are not units to ship. */
  units: number | null;
  lines: { line: OrderBoardLine; qty: number; ofQty: number | null }[];
}

const LIVE = new Set<OrderBoardLine['state']>(['ready', 'backorder', 'to_order']);

/** The expanded panel's groups, empty ones left out. A partly shipped or
 *  partly packed line appears in more than one group, each with its share. */
export const panelGroups = (row: OrderPanelRow): PanelGroup[] => {
  const entry = (line: OrderBoardLine, qty: number) => ({ line, qty, ofQty: qty === line.quantity ? null : line.quantity });
  const live = row.lines.filter(l => LIVE.has(l.state));
  const groups: PanelGroup[] = [
    { id: 'todo', units: 0, lines: live.filter(l => l.remaining - l.packed_waiting > 0).map(l => entry(l, l.remaining - l.packed_waiting)) },
    { id: 'packed', units: 0, lines: live.filter(l => l.packed_waiting > 0).map(l => entry(l, l.packed_waiting)) },
    { id: 'shipped', units: 0, lines: row.lines.filter(l => l.state !== 'service' && l.shipped > 0).map(l => entry(l, l.shipped)) },
    { id: 'other', units: null, lines: row.lines.filter(l => l.state === 'service' || l.state === 'cancelled').map(l => ({ line: l, qty: l.quantity, ofQty: null })) },
  ];
  for (const g of groups) if (g.units !== null) g.units = Math.round(g.lines.reduce((n, l) => n + l.qty, 0) * 100) / 100;
  return groups.filter(g => g.lines.length > 0);
};

/** Whole days from a YYYY-MM-DD due date to today's local calendar day (negative before it). */
export const daysPastDue = (dueDay: string): number => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((today.getTime() - parseDay(dueDay).getTime()) / 86_400_000);
};

/** Units the shelf could put in a new parcel today, summed over the lines. */
export const packableUnits = (row: Pick<OrderBoardRow, 'lines'>): number =>
  Math.round(row.lines.reduce((n, l) => n + (l.packable ?? 0), 0) * 100) / 100;

/** What is being chosen for a new picklist, or checked for the parcel of one: per line, the most Books allows and the units chosen. */
export interface OrderCheck { kind: 'pick' | 'pack'; picklist?: { id: string; number: string }; max: Record<string, number>; qty: Record<string, number> }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The lines a check would send: the chosen quantity, never above its maximum, zeros dropped. */
export const checkLines = (check: Pick<OrderCheck, 'max' | 'qty'>): { line_id: string; quantity: number }[] =>
  Object.entries(check.max)
    .map(([line_id, max]) => ({ line_id, quantity: round2(Math.min(check.qty[line_id] ?? 0, max)) }))
    .filter(l => l.quantity > 0);

/** Picklists a parcel can be made from: the open ones, and the completed ones while picked units wait for a box. */
export const boxablePicklists = (row: Pick<OrderBoardRow, 'picklists' | 'picked'>): OrderPicklist[] =>
  (row.picklists ?? []).filter(p => p.status !== 'completed' || (row.picked ?? 0) > 0);

/** A new picklist is possible: the shelf holds something and no picklist is open (Books takes one at a time here). */
export const canPick = (row: Pick<OrderBoardRow, 'lines' | 'picklists'>): boolean =>
  packableUnits(row) > 0 && !(row.picklists ?? []).some(p => p.status !== 'completed');

/** Parcels boxed in Books and not handed over yet. */
export const waitingPackages = (row: Pick<OrderBoardRow, 'packages'>): OrderPackage[] =>
  row.packages.filter(p => p.status === 'not_shipped');

/** What the operator does next with this order, as the target the panel opens: box the open picklist,
 *  choose what to pick, or hand a boxed parcel over. A completed picklist with units left is not a target:
 *  the row cannot tell which one holds them, the band of the opened order offers each. */
export const nextStep = (row: Pick<OrderBoardRow, 'lines' | 'packages' | 'picklists'>): string | null => {
  const open = (row.picklists ?? []).find(p => p.status !== 'completed');
  const parcel = waitingPackages(row)[0];
  return open ? `pack-${open.id}` : canPick(row) ? 'pick' : parcel ? `handover-${parcel.id}` : null;
};

/** An edit of the order's lines: the new ordered quantity of each live line, the lines removed, the items added. */
export interface OrderEdit { qty: Record<string, number>; gone: Set<string>; added: { item: OrderItemHit; quantity: number }[] }

const liveLines = (row: Pick<OrderBoardRow, 'lines'>) => row.lines.filter(l => LIVE.has(l.state));

export const startEdit = (row: Pick<OrderBoardRow, 'lines'>): OrderEdit => ({
  qty: Object.fromEntries(liveLines(row).map(l => [l.id, l.quantity])),
  gone: new Set(),
  added: [],
});

const editedQty = (edit: OrderEdit, line: OrderBoardLine) => round2(edit.qty[line.id] ?? line.quantity);

export interface OrderEditChange { kind: 'qty' | 'gone' | 'add'; line?: OrderBoardLine; item?: OrderItemHit; from?: number; to?: number }

/** What the edit changes, in the order of the lines, the added items last. */
export const editChanges = (row: Pick<OrderBoardRow, 'lines'>, edit: OrderEdit): OrderEditChange[] => [
  ...liveLines(row).flatMap((line): OrderEditChange[] =>
    edit.gone.has(line.id) ? [{ kind: 'gone', line }]
    : editedQty(edit, line) !== line.quantity ? [{ kind: 'qty', line, from: line.quantity, to: editedQty(edit, line) }]
    : []),
  ...edit.added.map((a): OrderEditChange => ({ kind: 'add', item: a.item, to: round2(a.quantity) })),
];

/** The lines sent: every live line kept at its quantity, then the added items. Service, cancelled and fully
 *  shipped lines are not sent: the server keeps them. */
export const editPayload = (row: Pick<OrderBoardRow, 'lines'>, edit: OrderEdit): OrderEditLine[] => [
  ...liveLines(row).filter(l => !edit.gone.has(l.id)).map(l => ({ line_id: l.id, quantity: editedQty(edit, l) })),
  ...edit.added.map(a => ({ item_id: a.item.id, quantity: round2(a.quantity) })),
];

/** The order total after the edit, or null when Books' arithmetic cannot be reproduced (discounts, shipping, tax exclusive).
 *  Live lines count at their edited ordered quantity, every other line except a cancelled one at its quantity. */
export const editTotal = (row: Pick<OrderBoardRow, 'lines' | 'estimable'>, edit: OrderEdit): number | null => {
  if (!row.estimable) return null;
  const lines = row.lines.reduce(
    (n, l) => n + (LIVE.has(l.state) ? (edit.gone.has(l.id) ? 0 : editedQty(edit, l)) : l.state === 'cancelled' ? 0 : l.quantity) * l.rate,
    0,
  );
  return round2(lines + edit.added.reduce((n, a) => n + a.quantity * a.item.rate, 0));
};
