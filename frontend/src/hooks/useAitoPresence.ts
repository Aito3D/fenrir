import { useSyncExternalStore } from 'react';

/** Which operator is viewing which Aito project, fed by the
 *  `aito_presence_state` WebSocket message. Module-level for the same reason
 *  useBoardSync is: useWebSocket (the writer) and every card (the readers)
 *  must share one store no matter how many components mount. */

let viewers: Record<string, string[]> = {};
/** Own presence, remembered so a reconnect can replay it — the server's map
 *  dropped us the moment the old socket died. */
let ownProjectId: number | null = null;
let sender: ((msg: Record<string, unknown>) => void) | null = null;

const listeners = new Set<() => void>();
const EMPTY: string[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: module state survives between tests in one file. */
export function __resetAitoPresence() {
  viewers = {};
  ownProjectId = null;
  sender = null;
  emit();
}

export function registerPresenceSender(send: ((msg: Record<string, unknown>) => void) | null) {
  sender = send;
  if (send && ownProjectId !== null) {
    send({ type: 'aito_presence', project_id: ownProjectId });
  }
  if (!send && Object.keys(viewers).length > 0) {
    // Socket dropped — the server's presence map died with it, so the
    // last-known viewers are stale until a reconnect replays a fresh
    // aito_presence_state. Clear and notify so cards/banner stop showing
    // operators whose connections are already gone.
    viewers = {};
    emit();
  }
}

export function sendAitoPresence(projectId: number | null) {
  ownProjectId = projectId;
  sender?.({ type: 'aito_presence', project_id: projectId });
}

export function setAitoPresenceState(next: Record<string, string[]>) {
  viewers = next;
  emit();
}

export function useAitoViewers(projectId: number): string[] {
  return useSyncExternalStore(subscribe, () => viewers[String(projectId)] ?? EMPTY);
}
