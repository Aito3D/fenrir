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
const SELF_TOASTED_KINDS = new Set(['quote.emailed', 'invoice.emailed', 'retainer.emailed', 'invoice.created', 'payment_link.created', 'payment.manual.recorded']);

type ZohoToastType = 'success' | 'error' | 'warning';

/** The translation key and severity of one Zoho result's toast, or null for a kind the board does not voice. */
function zohoToastParts(r: AitoZohoResult): { key: string; type: ZohoToastType } | null {
  switch (r.kind) {
    case 'quote.created': return { key: 'quoteCreated', type: 'success' };
    case 'invoice.created': return { key: 'invoiceCreated', type: 'success' };
    case 'payment.manual.recorded': return { key: r.has_retainer ? 'retainerCreated' : 'paymentRecorded', type: 'success' };
    case 'quote.emailed':
    case 'invoice.emailed':
    case 'retainer.emailed': return { key: 'emailed', type: 'success' };
    case 'payment_link.created':
    case 'payment_link.replaced': return { key: 'paymentLink', type: 'success' };
    case 'invoice.deposit_applied':
      return r.outcome === 'unknown' ? { key: 'depositUnknown', type: 'warning' } : { key: 'depositApplied', type: 'success' };
    case 'payment.manual.partial': return { key: 'paymentPartial', type: 'error' };
    case 'sync.failed': return { key: 'syncFailed', type: 'error' };
    case 'sync.conflict': return { key: 'syncConflict', type: 'warning' };
    default: return null;
  }
}

/** The toast for one Zoho result, or null for a kind the board does not voice. */
export function zohoToast(t: TFunction, r: AitoZohoResult): { text: string; type: ZohoToastType } | null {
  const parts = zohoToastParts(r);
  if (!parts) return null;
  const text = t(`aito.zohoToast.${parts.key}`, { doc: r.doc, error: r.error ?? '' });
  return { text: r.client ? `${text} · ${r.client}` : text, type: parts.type };
}

/** After a toast, further results of its kind inside this window fold into one summary, so a pass that touches many cards never stacks them. */
const ZOHO_COALESCE_MS = 1500;

/** A toast for every result of Fenrir's work in Zoho, background or not, for
 *  everyone with the board open. Mounted by AitoPage beside the peer toasts.
 *  The first result of a kind shows at once; the rest of the next ZOHO_COALESCE_MS fold into one summary. */
export function useAitoZohoToasts(): void {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const me = user?.username ?? null;

  useEffect(() => {
    // Per toast key: the first result toasts at once and opens a window; later ones of that key are counted
    // and folded into one summary when the window closes.
    const windows = new Map<string, { extra: number; type: ZohoToastType; timer: number }>();
    const onResult = (event: Event) => {
      const result = (event as CustomEvent<AitoZohoResult>).detail;
      if (result?.kind && SELF_TOASTED_KINDS.has(result.kind) && me !== null && result.actor === me) return;
      // ApplyDepositModal already toasts its own success.
      if (result?.kind === 'invoice.deposit_applied' && me !== null && result.actor === me && result.outcome !== 'unknown') return;
      const parts = result ? zohoToastParts(result) : null;
      if (!result || !parts) return;
      const open = windows.get(parts.key);
      if (open) {
        open.extra += 1;
        return;
      }
      const toast = zohoToast(t, result);
      if (toast) showToast(toast.text, toast.type);
      const timer = window.setTimeout(() => {
        const closed = windows.get(parts.key);
        windows.delete(parts.key);
        if (closed && closed.extra > 0) showToast(t(`aito.zohoToast.${parts.key}Many`, { count: closed.extra }), closed.type);
      }, ZOHO_COALESCE_MS);
      windows.set(parts.key, { extra: 0, type: parts.type, timer });
    };
    window.addEventListener(AITO_ZOHO_EVENT, onResult);
    return () => {
      window.removeEventListener(AITO_ZOHO_EVENT, onResult);
      windows.forEach((w) => window.clearTimeout(w.timer));
    };
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
