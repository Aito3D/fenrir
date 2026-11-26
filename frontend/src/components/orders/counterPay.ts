import type { OrderBoardLine, OrderBoardResponse, OrderBoardRow, OrderInvoice, OrderPickLines } from '../../api/client';

export type PayStep = 'order' | 'payment' | 'invoice' | 'parcel' | 'handover' | 'done';
export const PAY_STEPS: PayStep[] = ['order', 'payment', 'invoice', 'parcel', 'handover', 'done'];

/** Goods lines the stock does not fully cover: one question each. */
export const shortLines = (row: OrderBoardRow): OrderBoardLine[] => row.lines.filter((l) => l.stock_available !== null && l.shortfall > 0);

/** What the picklist takes: Books' offer, plus the whole remaining units of each line answered "yes". */
export function pickLines(
  row: OrderBoardRow,
  offered: OrderPickLines['lines'],
  have: ReadonlySet<string>,
): { lines: OrderPickLines['lines']; force: string[] } {
  const forced = shortLines(row).filter((l) => have.has(l.id));
  const ids = new Set(forced.map((l) => l.id));
  return {
    lines: [...offered.filter((o) => !ids.has(o.line_id)), ...forced.map((l) => ({ line_id: l.id, quantity: l.remaining - l.packed_waiting }))],
    force: forced.map((l) => l.id),
  };
}

/** The invoice named `number` on the row, or undefined. */
export const invoiceOf = (row: OrderBoardRow | undefined, number: string | null): OrderInvoice | undefined =>
  number ? row?.payment?.invoices.find((i) => i.number === number) : undefined;

/** True once `paid` is on the invoice: balance ≤ total − paid (0.01 tolerance). paid 0 is always attributed. */
export const attributed = (invoice: OrderInvoice | undefined, paid: number): boolean =>
  !!invoice && invoice.balance <= invoice.total - paid + 0.01;

/** The row of one order in a board answer. */
export const rowOf = (board: OrderBoardResponse, id: string): OrderBoardRow | undefined => board.rows.find((r) => r.id === id);
