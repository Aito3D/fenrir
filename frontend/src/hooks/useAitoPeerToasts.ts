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

/** `useWebSocket` relays every `aito_zoho` message (services/aito_zoho_toasts.py) as this window event. */
export const AITO_ZOHO_EVENT = 'aito-zoho-result';

export interface AitoZohoResult {
  kind?: string;
  actor?: string | null;
  doc?: string;
  client?: string | null;
  has_retainer?: boolean;
  outcome?: string | null;
  error?: string | null;
}

/** Kinds whose own mutation already toasts on success: the acting operator skips the Zoho-result toast (colleagues
 *  still get it). Background kinds (sync.*, payment_link.replaced, payment.manual.partial) always toast. */
const SELF_TOASTED_KINDS = new Set(['quote.emailed', 'invoice.emailed', 'retainer.emailed', 'invoice.created', 'payment_link.created']);

type ZohoToastType = 'success' | 'error' | 'warning';

/** The toast for one Zoho result, or null for a kind the board does not voice. */
export function zohoToast(t: TFunction, r: AitoZohoResult): { text: string; type: ZohoToastType } | null {
  const v = { doc: r.doc, error: r.error ?? '' };
  const ok = (key: string) => ({ text: t(`aito.zohoToast.${key}`, v), type: 'success' as const });
  let toast: { text: string; type: ZohoToastType };
  switch (r.kind) {
    case 'quote.created': toast = ok('quoteCreated'); break;
    case 'invoice.created': toast = ok('invoiceCreated'); break;
    case 'payment.manual.recorded': toast = ok(r.has_retainer ? 'retainerCreated' : 'paymentRecorded'); break;
    case 'quote.emailed':
    case 'invoice.emailed':
    case 'retainer.emailed': toast = ok('emailed'); break;
    case 'payment_link.created':
    case 'payment_link.replaced': toast = ok('paymentLink'); break;
    case 'invoice.deposit_applied':
      toast = r.outcome === 'unknown'
        ? { text: t('aito.zohoToast.depositUnknown', v), type: 'warning' }
        : ok('depositApplied');
      break;
    case 'payment.manual.partial': toast = { text: t('aito.zohoToast.paymentPartial', v), type: 'error' }; break;
    case 'sync.failed': toast = { text: t('aito.zohoToast.syncFailed', v), type: 'error' }; break;
    case 'sync.conflict': toast = { text: t('aito.zohoToast.syncConflict', v), type: 'warning' }; break;
    default: return null;
  }
  return r.client ? { ...toast, text: `${toast.text} · ${r.client}` } : toast;
}

/** A toast for every result of Fenrir's work in Zoho, background or not, for
 *  everyone with the board open. Mounted by AitoPage beside the peer toasts. */
export function useAitoZohoToasts(): void {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const me = user?.username ?? null;

  useEffect(() => {
    const onResult = (event: Event) => {
      const result = (event as CustomEvent<AitoZohoResult>).detail;
      if (result?.kind && SELF_TOASTED_KINDS.has(result.kind) && me !== null && result.actor === me) return;
      // ApplyDepositModal already toasts its own success.
      if (result?.kind === 'invoice.deposit_applied' && me !== null && result.actor === me && result.outcome !== 'unknown') return;
      const toast = result ? zohoToast(t, result) : null;
      if (toast) showToast(toast.text, toast.type);
    };
    window.addEventListener(AITO_ZOHO_EVENT, onResult);
    return () => window.removeEventListener(AITO_ZOHO_EVENT, onResult);
  }, [me, showToast, t]);
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
