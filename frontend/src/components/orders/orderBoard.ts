// The Order Board's list logic: pure functions over the rows the server computed.
//
// Which number follows which filter is the part that is easy to get wrong:
//   tiles and total value  -> byBrand only
//   chip counts            -> byBrand + bySearch
//   the list               -> byBrand + bySearch + byStatus
import type { NewOrderDraftLine } from '../../hooks/useNewOrderDraft';
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

/** 'finished' lists the orders with nothing left to ship: they never mix with the open ones. */
export type StatusFilter = 'all' | OrderStatus | 'finished';
export type PayFilter = 'all' | OrderPayState | 'overdue';
export type SortKey = 'age' | 'value' | 'customer' | 'ready';

/** Lower-case with accents stripped, so "LYCEE" finds "Lycée". */
export const foldText = (s: string | null | undefined): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const byBrand = (rows: OrderBoardRow[], coreOnly: boolean): OrderBoardRow[] =>
  coreOnly ? rows.filter(r => r.is_core) : rows;

/** A finished order the stored copy cannot place (`is_core` null) stays: hiding it would lose it for good. */
export const finishedByBrand = (rows: FinishedOrderRow[], coreOnly: boolean): FinishedOrderRow[] =>
  coreOnly ? rows.filter(r => r.is_core !== false) : rows;

const PHONE_NOISE = /[\s.\-()]/g;

export const bySearch = (rows: OrderBoardRow[], query: string): OrderBoardRow[] => {
  const q = foldText(query).trim();
  if (!q) return rows;
  // A phone number is found however it was typed or stored: "87 12 34" finds "+689 87.12.34.56".
  const digits = q.replace(PHONE_NOISE, '');
  const asPhone = digits.length >= 4 && /^\+?\d+$/.test(digits);
  return rows.filter(r =>
    [
      r.number, r.customer, r.facts.reference, r.contact?.name, r.contact?.email,
      ...r.packages.map(p => p.number),
      ...(r.payment?.invoices ?? []).map(i => i.number),
      ...r.lines.flatMap(l => [l.name, l.sku]),
    ].some(text => foldText(text).includes(q))
    || (asPhone && [r.contact?.phone, r.contact?.mobile].some(p => (p ?? '').replace(PHONE_NOISE, '').includes(digits))),
  );
};

/** "To order" is every order with units still to buy and no open PO, whatever its status: a Partial
 *  order whose printer is not in stock must show there too, or nobody orders it. */
const inStatus = (r: OrderBoardRow, status: StatusFilter): boolean =>
  status === 'all' || r.status === status || (status === 'to_order' && r.units.to_order > 0);

export const byStatus = (rows: OrderBoardRow[], status: StatusFilter): OrderBoardRow[] =>
  rows.filter(r => inStatus(r, status));

export const countByStatus = (rows: OrderBoardRow[]): Record<StatusFilter, number> => {
  const counts: Record<StatusFilter, number> = { all: rows.length, to_ship: 0, partial: 0, incoming: 0, to_order: 0, finished: 0 };
  for (const r of rows) {
    counts[r.status] += 1;
    if (r.status !== 'to_order' && r.units.to_order > 0) counts.to_order += 1;
  }
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

/** The board's "to chase" pills, the Aito strip's order twins: handed over without an invoice, and told it is
 *  ready (pickup SMS sent) with a parcel still waiting. */
export type FollowKey = 'unbilled' | 'notCollected';
export const FOLLOW_KEYS: FollowKey[] = ['unbilled', 'notCollected'];

export const isFollowup = (r: Pick<OrderBoardRow, 'unbilled_units' | 'contacted' | 'packed'>, key: FollowKey): boolean =>
  key === 'unbilled' ? r.unbilled_units > 0 : !!r.contacted && r.packed > 0;

/** Whole days since the pickup SMS of the longest-waiting row of the bucket; 0 when none is dated. */
export const followDays = (rows: Pick<OrderBoardRow, 'contacted'>[], now = Date.now()): number =>
  rows.reduce((max, r) => {
    const at = r.contacted ? Date.parse(r.contacted.at) : NaN;
    return Number.isFinite(at) ? Math.max(max, Math.floor((now - at) / 86_400_000)) : max;
  }, 0);

export const totalValue = (rows: OrderBoardRow[]): number => rows.reduce((sum, r) => sum + (r.total ?? 0), 0);

const DAY_MS = 86_400_000;
const utcMs = (isoDay: string) => Date.parse(`${isoDay}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Today as the server dates orders: the UTC calendar day. */
export const utcToday = (): string => isoDay(Date.now());

/** Orders per week over the last `weeks` weeks, oldest first, the week of `today` last. Weeks start on Monday. */
export const weeklyCounts = (days: string[], today: string, weeks = 8): { start: string; n: number }[] => {
  const monday = utcMs(today) - ((new Date(utcMs(today)).getUTCDay() + 6) % 7) * DAY_MS;
  const starts = Array.from({ length: weeks + 1 }, (_, i) => isoDay(monday + (i - weeks + 1) * 7 * DAY_MS));
  return starts.slice(0, weeks).map((start, i) => ({ start, n: days.filter(d => d >= start && d < starts[i + 1]).length }));
};

/** Average days from order date to hand-over, over the orders handed over in the last `windowDays`; null without any. */
export const avgLeadDays = (
  rows: Pick<FinishedOrderRow, 'date' | 'handed_over'>[],
  today: string,
  windowDays = 90,
): { days: number; n: number } | null => {
  const since = isoDay(utcMs(today) - windowDays * DAY_MS);
  const leads = rows
    .filter(r => r.handed_over && r.handed_over >= since)
    .map(r => (utcMs(r.handed_over!) - utcMs(r.date)) / DAY_MS)
    .filter(Number.isFinite);
  if (!leads.length) return null;
  return { days: Math.round((leads.reduce((sum, d) => sum + Math.max(0, d), 0) / leads.length) * 10) / 10, n: leads.length };
};

/** Default directions: age oldest first, value and % ready highest first, customer A to Z. */
type Sortable = Pick<OrderBoardRow, 'age_days' | 'number' | 'total' | 'customer' | 'ready_ratio'>;
export const sortRows = <T extends Sortable>(rows: T[], key: SortKey, flipped: boolean, locale: string): T[] => {
  const compare: Record<SortKey, (a: T, b: T) => number> = {
    // Same-day orders tie on whole days: the lower order number is the older one.
    age: (a, b) => b.age_days - a.age_days || a.number.localeCompare(b.number, undefined, { numeric: true }),
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
  ...finished.map(f => ({ age_days: daysPastDue(f.date), number: f.number, total: f.total, customer: f.customer, ready_ratio: 1, fin: f })),
];

/** An empty or half-built board must never look like a verified answer. */
export const isBoardReady = (r: OrderBoardResponse | undefined): boolean =>
  !!r && !!r.computed_at && !!r.stock_loaded_at;

/** The slow fallback poll once nothing is computing: changes arrive as WebSocket pings. */
export const SETTLED_POLL_MS = 180000;

export const pollMs = (r: OrderBoardResponse | undefined): number => {
  if (!r) return 4000;
  if (r.sync.running || r.sync.pending > 0) return 4000;
  // Never computed: fast, unless nothing is going to compute it. Otherwise a slow fallback: a change to the board
  // arrives as an order_board_updated WebSocket ping.
  return !r.computed_at && r.sync.enabled && r.sync.configured ? 4000 : SETTLED_POLL_MS;
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

/** A scanned code on an open check: one more unit on the first matching line that still has room. */
export function scanCheck(
  check: OrderCheck,
  lines: Pick<OrderBoardLine, 'id' | 'name' | 'codes'>[],
  code: string,
): { check: OrderCheck; hit: 'added' | 'full' | 'unknown'; name: string; id?: string } {
  const want = code.trim().toLowerCase();
  const matches = want ? lines.filter(l => check.max[l.id] > 0 && (l.codes ?? []).some(c => c.toLowerCase() === want)) : [];
  if (!matches.length) return { check, hit: 'unknown', name: '' };
  const line = matches.find(l => (check.qty[l.id] ?? 0) < check.max[l.id]);
  if (!line) return { check, hit: 'full', name: matches[0].name };
  const qty = Math.min(check.max[line.id], round2((check.qty[line.id] ?? 0) + 1));
  return { check: { ...check, qty: { ...check.qty, [line.id]: qty } }, hit: 'added', name: line.name, id: line.id };
}

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

/** An edit of the order's lines: the new ordered quantity of each live line, the lines removed, the items added.
 *  `version` is the order's Books version when the edit opened: a save over a later change is refused, never applied. */
/** `rate` and `discount` hold only the lines the operator touched (by line id). */
export interface OrderEdit { version: string; qty: Record<string, number>; gone: Set<string>; added: { item: OrderItemHit; quantity: number }[]; rate: Record<string, number>; discount: Record<string, string> }

const liveLines = (row: Pick<OrderBoardRow, 'lines'>) => row.lines.filter(l => LIVE.has(l.state));

export const startEdit = (row: Pick<OrderBoardRow, 'lines' | 'version'>): OrderEdit => ({
  version: row.version,
  qty: Object.fromEntries(liveLines(row).map(l => [l.id, l.quantity])),
  gone: new Set(),
  added: [],
  rate: {},
  discount: {},
});

const editedQty = (edit: OrderEdit, line: OrderBoardLine) => round2(edit.qty[line.id] ?? line.quantity);
// A line edited down to 0 is a removal: Books refuses a zero quantity.
/** Books' "10.00%" or "500.00" as the operator types it: "10%", "500". */
export const shownDiscount = (raw: string | null | undefined): string =>
  !raw ? '' : raw.endsWith('%') ? `${Number(raw.slice(0, -1))}%` : `${Number(raw)}`;
export const editedRate = (edit: OrderEdit, line: OrderBoardLine) => edit.rate[line.id] ?? line.rate;
export const editedDiscount = (edit: OrderEdit, line: OrderBoardLine) => normDiscount(edit.discount[line.id] ?? shownDiscount(line.discount));
/** False while a touched line holds a price or a discount the server would refuse. */
export const editValid = (row: Pick<OrderBoardRow, 'lines'>, edit: OrderEdit): boolean =>
  liveLines(row).every(l => removed(edit, l) || (editedRate(edit, l) >= 0 && Number.isFinite(editedRate(edit, l))
    && lineTotal({ item: { rate: editedRate(edit, l) }, quantity: editedQty(edit, l), discount: editedDiscount(edit, l) } as NewOrderDraftLine) !== null));
const removed = (edit: OrderEdit, line: OrderBoardLine) => edit.gone.has(line.id) || editedQty(edit, line) <= 0;

export interface OrderEditChange { kind: 'qty' | 'gone' | 'add' | 'price' | 'discount'; line?: OrderBoardLine; item?: OrderItemHit; from?: number; to?: number; text?: string }

/** What the edit changes, in the order of the lines, the added items last. */
export const editChanges = (row: Pick<OrderBoardRow, 'lines'>, edit: OrderEdit): OrderEditChange[] => [
  ...liveLines(row).flatMap((line): OrderEditChange[] =>
    removed(edit, line) ? [{ kind: 'gone', line }]
    : [
      ...(editedQty(edit, line) !== line.quantity ? [{ kind: 'qty' as const, line, from: line.quantity, to: editedQty(edit, line) }] : []),
      ...(editedRate(edit, line) !== line.rate ? [{ kind: 'price' as const, line, from: line.rate, to: editedRate(edit, line) }] : []),
      ...(editedDiscount(edit, line) !== shownDiscount(line.discount) ? [{ kind: 'discount' as const, line, text: editedDiscount(edit, line) }] : []),
    ]),
  ...edit.added.map((a): OrderEditChange => ({ kind: 'add', item: a.item, to: round2(a.quantity) })),
];

/** The lines sent: every live line kept at its quantity, then the added items. Service, untracked, cancelled and
 *  fully shipped lines are not sent: the server sends them back to Books unchanged. */
export const editPayload = (row: Pick<OrderBoardRow, 'lines'>, edit: OrderEdit): OrderEditLine[] => [
  ...liveLines(row).filter(l => !removed(edit, l)).map(l => ({
    line_id: l.id,
    quantity: editedQty(edit, l),
    ...(editedRate(edit, l) !== l.rate ? { rate: editedRate(edit, l) } : {}),
    ...(editedDiscount(edit, l) !== shownDiscount(l.discount) ? { discount: editedDiscount(edit, l) } : {}),
  })),
  ...edit.added.map(a => ({ item_id: a.item.id, quantity: round2(a.quantity) })),
];

/** The order total after the edit, or null when Books' arithmetic cannot be reproduced (discounts, shipping, tax exclusive).
 *  Live lines count at their edited ordered quantity, every other line except a cancelled one at its quantity. */
export const editTotal = (row: Pick<OrderBoardRow, 'lines' | 'estimable'>, edit: OrderEdit): number | null => {
  // Books rounds a discounted, tax-inclusive line its own way: with one, the total is Books' to compute.
  if (!row.estimable || liveLines(row).some(l => !removed(edit, l) && editedDiscount(edit, l))) return null;
  const lines = row.lines.reduce(
    (n, l) => n + (LIVE.has(l.state) ? (removed(edit, l) ? 0 : editedQty(edit, l) * editedRate(edit, l)) : l.state === 'cancelled' ? 0 : l.quantity * l.rate),
    0,
  );
  return round2(lines + edit.added.reduce((n, a) => n + a.quantity * a.item.rate, 0));
};

/** An edit of a waiting parcel: per line, the units it held when opened, the most it may hold (its units plus what
 *  the shelf still covers) and the units chosen. `picklist` is the number of the picklist the parcel was made from. */
export interface ParcelEdit { packageId: string; number: string; picklist: string; version: string; was: Record<string, number>; max: Record<string, number>; qty: Record<string, number>; pending?: boolean }

const parcelQty = (p: ParcelEdit, id: string) => round2(Math.min(p.qty[id] ?? 0, p.max[id]));

/** Units in the parcel now and when opened, units taken from the shelf and units sent back to prepare. */
export const parcelDiff = (p: ParcelEdit): { added: number; removed: number; units: number; wasUnits: number } => {
  let added = 0, removed = 0, units = 0;
  for (const id of Object.keys(p.max)) {
    const q = parcelQty(p, id), d = q - (p.was[id] ?? 0);
    units += q;
    if (d > 0) added += d;
    else removed -= d;
  }
  return { added: round2(added), removed: round2(removed), units: round2(units), wasUnits: round2(Object.values(p.was).reduce((n, q) => n + q, 0)) };
};

/** What the parcel should hold after the save, zeros dropped (an empty list deletes it). */
export const parcelLines = (p: ParcelEdit): { line_id: string; quantity: number }[] =>
  Object.keys(p.max).map(line_id => ({ line_id, quantity: parcelQty(p, line_id) })).filter(l => l.quantity > 0);

/** The parcel as the editor showed it when it opened: the server refuses the save if Books moved since. */
export const parcelWas = (p: ParcelEdit): { line_id: string; quantity: number }[] =>
  Object.entries(p.was).filter(([, q]) => q > 0).map(([line_id, quantity]) => ({ line_id, quantity }));

// Same grammar as the server: "N%" or a plain amount, dot decimals.
const DISCOUNT = /^(\d+(?:\.\d+)?)(%?)$/;

/** The discount as the server reads it: spaces dropped, a decimal comma made a dot ("10 %" → "10%"). */
export const normDiscount = (raw: string) => raw.replace(/\s/g, '').replace(',', '.');

/** The line total after its discount (prices are tax inclusive); null when the discount is neither "N%" with N ≤ 100
 *  nor an amount up to the line total. */
export function lineTotal(l: NewOrderDraftLine): number | null {
  const gross = l.quantity * l.item.rate;
  const d = normDiscount(l.discount);
  if (!d) return gross;
  const m = DISCOUNT.exec(d);
  if (!m) return null;
  const n = Number(m[1]);
  if (m[2]) return n <= 100 ? gross * (1 - n / 100) : null;
  return n <= gross + 1e-9 ? gross - n : null;
}

export const PAY_CHIPS: Exclude<PayFilter, 'all' | 'overdue'>[] = ['unpaid', 'partial', 'paid'];
export const chipCls = (active: boolean) =>
  `btn-press rounded-full border px-3 py-1.5 text-xs ${active ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray hover:text-white'}`;

/** One order of a client's history. `lines` is null for a finished order (fetched on expand), `status` for a shipped one. */
export interface ClientOrder {
  id: string;
  number: string;
  date: string;
  total: number | null;
  currency: string;
  state: OrderPayState | null;
  left: number;
  status: OrderStatus | null;
  lines: OrderBoardLine[] | null;
}

/** A client's orders, open and shipped, newest first. */
export const clientOrders = (customerId: string, open: OrderBoardRow[], finished: FinishedOrderRow[]): ClientOrder[] =>
  !customerId
    ? []
    : [
        ...open.filter(r => r.customer_id === customerId).map(r => ({ id: r.id, number: r.number, date: r.date, total: r.total, currency: r.currency, state: r.payment?.state ?? null, left: r.payment?.left ?? 0, status: r.status, lines: r.lines })),
        ...finished.filter(r => r.customer_id === customerId).map(r => ({ id: r.id, number: r.number, date: r.date, total: r.total, currency: r.currency, state: finishedPayState(r), left: r.payment?.left ?? 0, status: null, lines: null })),
      ].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
