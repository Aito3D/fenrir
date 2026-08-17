import { useEffect, useRef, useState } from 'react';
import { normaliseTaskDraft } from '../utils/taskDraft';
import { normaliseClientDraft } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
import type { TaskDraft } from '../utils/taskDraft';
import type { ShippingDraft } from '../utils/shippingDraft';

const STORAGE_KEY = 'aito.newProjectDraft.v1';
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedDraft {
  tasks: TaskDraft[];
  client: ClientDraft | null;
  summaryText: string;
  summaryEdited: boolean;
  summarySignature: string;
  /** Optional so a blob written before shipping existed still reads: the key
   *  is simply absent and reads as undefined. No storage version bump. */
  shipping?: ShippingDraft | null;
}

// Bumped by every external clear so a live hook instance's debounced write
// and unmount flush — both scheduled before the clear could reach into their
// timerRef/pendingRef — can tell their queued payload is now stale and drop
// it instead of re-writing it. Read by `save()`'s timeout and by the
// unmount effect below; neither writes if the epoch has moved since the
// write was queued.
let clearEpoch = 0;

export function clearNewProjectDraft(): void {
  clearEpoch += 1;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota) — persistence is best-effort.
  }
}

/** Every key of a shape this hook restores WHOLE rather than field by field.
 *  A blob written before one of them existed is missing it, and the drawer
 *  reads them unguarded (`draft.email.trim()`, `shipping.blurred.island`), so
 *  an incomplete half is a render crash — see `normaliseTaskDraft` for the
 *  full story. Presence only: the values themselves come from our own writer,
 *  and a type check per field here would be a second copy of two interfaces
 *  that would drift from the real ones. */
const CLIENT_KEYS = [
  'id', 'name', 'isDefault', 'isCompany', 'countryCode', 'nationalNumber', 'email',
  'touched', 'blurred', 'original',
];
const SHIPPING_KEYS = [
  'island', 'service', 'firstName', 'lastName', 'countryCode', 'nationalNumber',
  'price', 'priceEdited', 'blurred',
];

function complete<T>(value: unknown, keys: string[]): T | null {
  if (typeof value !== 'object' || value === null) return null;
  return keys.every((key) => key in value) ? (value as T) : null;
}

/** Reads the stored blob back, repairing anything an older build wrote.
 *
 *  Tasks are FILLED (a half-typed quote is worth keeping); the client and
 *  shipping halves are DROPPED when incomplete, because both are re-picked in
 *  one gesture — a contact from the combobox, an island from the list — and a
 *  half-restored contact would be worse than none: it would look chosen. */
function readDraft(): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!Array.isArray(parsed.tasks)) return null;
    return {
      ...parsed,
      tasks: parsed.tasks.map(normaliseTaskDraft),
      // Normalised, not key-checked: the two social fields arrived after this
      // blob format did, and `complete()` would drop the whole contact over
      // them. CLIENT_KEYS above deliberately does NOT list them.
      client: (() => {
        const client = complete<ClientDraft>(parsed.client, CLIENT_KEYS);
        return client && normaliseClientDraft(client);
      })(),
      shipping: complete<ShippingDraft>(parsed.shipping, SHIPPING_KEYS),
    };
  } catch {
    return null;
  }
}

/** Best-effort local persistence for the new-project drawer. `initial` is read
 *  once on mount; `save` debounces writes; `clear` wipes synchronously (reset
 *  and successful create). */
export function useNewProjectDraft() {
  const [initial] = useState<PersistedDraft | null>(readDraft);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest not-yet-written draft. Set by `save`, cleared once the debounced
  // write actually lands (or by `clear`). Unmount checks this — not the timer —
  // so a still-pending write is flushed synchronously instead of dropped.
  const pendingRef = useRef<PersistedDraft | null>(null);
  // The value of `clearEpoch` at the moment `pendingRef` was last set by
  // `save`. An external `clearNewProjectDraft()` call (AuthContext.logout(),
  // useAitoPageMutations' create-success handler) bumps the module epoch but
  // has no handle on this instance's timer/pending refs — so both the
  // debounce timeout and the unmount flush below compare against this to
  // detect a clear that happened after their write was queued, and drop the
  // payload instead of resurrecting it.
  const pendingEpochRef = useRef(0);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current && pendingEpochRef.current === clearEpoch) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingRef.current));
        } catch {
          // Best-effort only.
        }
      }
      pendingRef.current = null;
    },
    [],
  );

  const save = (draft: PersistedDraft) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = draft;
    pendingEpochRef.current = clearEpoch;
    timerRef.current = setTimeout(() => {
      if (clearEpoch === pendingEpochRef.current) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
        } catch {
          // Best-effort only.
        }
      }
      pendingRef.current = null;
    }, SAVE_DEBOUNCE_MS);
  };

  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    clearNewProjectDraft();
  };

  return { initial, save, clear };
}
