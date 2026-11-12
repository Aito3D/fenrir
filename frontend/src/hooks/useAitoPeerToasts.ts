import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { ALL_COLUMNS } from '../components/aito/columns';

/** `useWebSocket` relays every `aito_changed` message as this window event. */
export const AITO_PEER_CHANGE_EVENT = 'aito-peer-change';

export interface AitoPeerChange {
  action?: string;
  actor?: string | null;
  /** Only on a move ACROSS columns (see `_broadcast_changed` in routes/aito.py). */
  column?: string;
}

/** Changes landing inside this window become one toast, so a merge or a
 *  multi-card drop by a colleague never stacks them. */
const COALESCE_MS = 1500;

/** What one change reads as, or null for the ones not worth a toast: edits,
 *  ticks and comments arrive by the dozen and the board already shows them. */
function changeText(t: TFunction, change: AitoPeerChange): string | null {
  const actor = change.actor;
  switch (change.action) {
    case 'create':
      return t('aito.peer.created', { actor });
    case 'move': {
      const column = ALL_COLUMNS.find((c) => c.id === change.column);
      return column ? t('aito.peer.moved', { actor, column: t(column.labelKey) }) : null;
    }
    case 'delete':
      return t('aito.peer.trashed', { actor });
    case 'restore':
      return t('aito.peer.restored', { actor });
    default:
      return null;
  }
}

/** Toasts for what OTHER operators do on the board ("Marie moved a card to
 *  Print"). Mounted by AitoPage, so it only speaks while the board is open.
 *  Never for the viewer's own actions, and never for a change with no named
 *  actor (the sync worker, an API key, or an install with auth off, where
 *  nobody can be told apart). */
export function useAitoPeerToasts(): void {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const me = user?.username ?? null;

  useEffect(() => {
    let batch: { actor: string; text: string }[] = [];
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      const [first] = batch;
      const actors = [...new Set(batch.map((b) => b.actor))].join(', ');
      showToast(batch.length === 1 ? first.text : t('aito.peer.many', { actors, count: batch.length }), 'info');
      batch = [];
    };
    const onChange = (event: Event) => {
      const change = (event as CustomEvent<AitoPeerChange>).detail;
      if (!change?.actor || change.actor === me) return;
      const text = changeText(t, change);
      if (text === null) return;
      batch.push({ actor: change.actor, text });
      timer ??= window.setTimeout(flush, COALESCE_MS);
    };
    window.addEventListener(AITO_PEER_CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener(AITO_PEER_CHANGE_EVENT, onChange);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [me, showToast, t]);
}
