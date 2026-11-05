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
  OrderPanelRow,
  OrderPayState,
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
export const sortRows = (rows: OrderBoardRow[], key: SortKey, flipped: boolean, locale: string): OrderBoardRow[] => {
  const compare: Record<SortKey, (a: OrderBoardRow, b: OrderBoardRow) => number> = {
    age: (a, b) => b.age_days - a.age_days,
    value: (a, b) => (b.total ?? 0) - (a.total ?? 0),
    customer: (a, b) => (a.customer ?? '').localeCompare(b.customer ?? '', locale),
    ready: (a, b) => b.ready_ratio - a.ready_ratio,
  };
  const sign = flipped ? -1 : 1;
  return [...rows].sort((a, b) => sign * compare[key](a, b));
};

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
