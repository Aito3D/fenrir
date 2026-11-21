import { useEffect, useRef, useState } from 'react';
import type { OrderItemHit } from '../api/client';

type DraftKind = 'order' | 'quote';
const STORAGE_KEY: Record<DraftKind, string> = { order: 'orders.newOrderDraft.v1', quote: 'orders.newQuoteDraft.v1' };
const SAVE_DEBOUNCE_MS = 400;

/** `lineId`: the line this already is on the quote being edited (never stored). */
export interface NewOrderDraftLine { item: OrderItemHit; quantity: number; discount: string; lineId?: string }
export interface NewOrderDraft {
  lines: NewOrderDraftLine[];
  client: { id: string; name: string; isDefault: boolean } | null;
  /** Idempotency key the backend dedupes a double-submitted order on. */
  clientRef: string;
}

// Bumped by every clear so a queued debounced write or unmount flush knows it is stale.
const clearEpoch: Record<DraftKind, number> = { order: 0, quote: 0 };

export function clearNewOrderDraft(kind: DraftKind = 'order'): void {
  clearEpoch[kind] += 1;
  try {
    localStorage.removeItem(STORAGE_KEY[kind]);
  } catch {
    // Storage unavailable: persistence is best-effort.
  }
}

// The backend validates a UUID; plain-http LAN origins lack crypto.randomUUID.
function newClientRef(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const validItem = (i: unknown) =>
  isObj(i) && typeof i.id === 'string' && typeof i.name === 'string' && typeof i.rate === 'number' && Number.isFinite(i.rate);
// Same rule as the backend: positive, at most 3 decimals.
const validQuantity = (q: unknown) =>
  typeof q === 'number' && Number.isFinite(q) && q > 0 && Math.round(q * 1000) / 1000 === q;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function write(kind: DraftKind, d: NewOrderDraft) {
  try {
    localStorage.setItem(STORAGE_KEY[kind], JSON.stringify(d));
  } catch {
    // Best-effort only.
  }
}

function readDraft(kind: DraftKind): NewOrderDraft {
  const empty: NewOrderDraft = { lines: [], client: null, clientRef: newClientRef() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY[kind]);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!isObj(parsed)) return empty;
    const c = parsed.client;
    return {
      lines: Array.isArray(parsed.lines)
        ? parsed.lines
            .filter((l): l is NewOrderDraftLine => isObj(l) && validItem(l.item) && validQuantity(l.quantity))
            .map((l) => ({ item: l.item, quantity: l.quantity, discount: typeof l.discount === 'string' ? l.discount : '' }))
        : [],
      client: isObj(c) && typeof c.id === 'string' && typeof c.name === 'string' ? { id: c.id, name: c.name, isDefault: c.isDefault === true } : null,
      clientRef: typeof parsed.clientRef === 'string' && UUID_RE.test(parsed.clientRef) ? parsed.clientRef : empty.clientRef,
    };
  } catch {
    return empty;
  }
}

/** The counter-order (or new quote) draft, restored on mount and saved (debounced) on change.
 *  `start` holds an existing quote being edited: kept in memory only, storage is never read or written. */
export function useNewOrderDraft(kind: DraftKind = 'order', start?: NewOrderDraft) {
  const [draft, setDraftState] = useState<NewOrderDraft>(() => start ?? readDraft(kind));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<NewOrderDraft | null>(null);
  const pendingEpochRef = useRef(0);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current && pendingEpochRef.current === clearEpoch[kind]) write(kind, pendingRef.current);
      pendingRef.current = null;
    },
    [kind],
  );

  const setDraft = (d: NewOrderDraft) => {
    setDraftState(d);
    if (start) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = d;
    pendingEpochRef.current = clearEpoch[kind];
    timerRef.current = setTimeout(() => {
      if (clearEpoch[kind] === pendingEpochRef.current) write(kind, d);
      pendingRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  const reset = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    if (!start) clearNewOrderDraft(kind);
    setDraftState({ lines: [], client: null, clientRef: newClientRef() });
  };

  return { draft, setDraft, reset };
}
