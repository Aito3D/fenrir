import { useSyncExternalStore } from 'react';

/** "This just snapped back" — a 600 ms marker on one project id.
 *
 *  Optimistic actions make rejection visible as motion: a card jumps back to
 *  Quote, a checkbox un-ticks, a deleted card reappears. A toast alone leaves
 *  that unexplained — the user reads "Save failed", looks at the panel in
 *  front of them, and never notices the card behind it moved. The flash gives
 *  the toast a referent.
 *
 *  A module store rather than a context: `flashRevert` is called from mutation
 *  callbacks, which are not components, and threading a provider through every
 *  hook that owns a mutation would buy nothing. */

const REVERT_FLASH_MS = 600;

let flashedId: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One id at a time. Two reverts inside one window is a case that does not
 *  happen in practice — the mutations are serialised on a shared scope — and
 *  a per-id map would be state to clean up for no gain. */
export function flashRevert(id: number) {
  if (timer !== null) clearTimeout(timer);
  flashedId = id;
  emit();
  timer = setTimeout(() => {
    flashedId = null;
    timer = null;
    emit();
  }, REVERT_FLASH_MS);
}

export function useIsReverting(id: number): boolean {
  return useSyncExternalStore(
    subscribe,
    () => flashedId === id,
    () => false,
  );
}
