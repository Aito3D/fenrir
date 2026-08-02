import { useEffect, useRef, useState } from 'react';
import type { ClientDraft } from '../utils/clientDraft';
import type { TaskDraft } from '../utils/taskDraft';

const STORAGE_KEY = 'aito.newProjectDraft.v1';
const SAVE_DEBOUNCE_MS = 400;

export interface PersistedDraft {
  tasks: TaskDraft[];
  client: ClientDraft | null;
  summaryText: string;
  summaryEdited: boolean;
  summarySignature: string;
}

export function clearNewProjectDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, quota) — persistence is best-effort.
  }
}

function readDraft(): PersistedDraft | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedDraft;
    if (!Array.isArray(parsed.tasks)) return null;
    return parsed;
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

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (pendingRef.current) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingRef.current));
        } catch {
          // Best-effort only.
        }
        pendingRef.current = null;
      }
    },
    [],
  );

  const save = (draft: PersistedDraft) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = draft;
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
      } catch {
        // Best-effort only.
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
