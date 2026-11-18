import { useEffect, useRef, useState } from 'react';
import type { OrderItemHit } from '../api/client';

const STORAGE_KEY = 'orders.newOrderDraft.v1';
const SAVE_DEBOUNCE_MS = 400;

export interface NewOrderDraftLine { item: OrderItemHit; quantity: number; discount: string }
export interface NewOrderDraft {
  lines: NewOrderDraftLine[];
  client: { id: string; name: string; isDefault: boolean } | null;
  /** Idempotency key the backend dedupes a double-submitted order on. */
  clientRef: string;
}

// Bumped by every clear so a queued debounced write or unmount flush knows it is stale.
let clearEpoch = 0;

export function clearNewOrderDraft(): void {
  clearEpoch += 1;
  try {
    localStorage.removeItem(STORAGE_KEY);
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

function readDraft(): NewOrderDraft {
  const empty: NewOrderDraft = { lines: [], client: null, clientRef: newClientRef() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

/** The counter-order draft, restored on mount and saved (debounced) on change. */
export function useNewOrderDraft() {
  const [draft, setDraftState] = useState<NewOrderDraft>(readDraft);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<NewOrderDraft | null>(null);
  const pendingEpochRef = useRef(0);

  const write = (d: NewOrderDraft) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
    } catch {
      // Best-effort only.
    }
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current && pendingEpochRef.current === clearEpoch) write(pendingRef.current);
      pendingRef.current = null;
    },
    [],
  );

  const setDraft = (d: NewOrderDraft) => {
    setDraftState(d);
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = d;
    pendingEpochRef.current = clearEpoch;
    timerRef.current = setTimeout(() => {
      if (clearEpoch === pendingEpochRef.current) write(d);
      pendingRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  const reset = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    clearNewOrderDraft();
    setDraftState({ lines: [], client: null, clientRef: newClientRef() });
  };

  return { draft, setDraft, reset };
}
