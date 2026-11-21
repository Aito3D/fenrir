import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { quoteReason, useQuoteActions } from './useQuoteActions';

export type AcceptedQuote = { quoteId: string; quote: string; salesorderId: string; order: string };

/** Above the orders, in the quotes' violet: which quote became which order, with Undo (deletes the order in Books,
 *  the quote goes back to sent). An undo refused as too late says so in place and loses its button. */
export function QuoteAcceptedNotice({ accepted, onUndone, onDismiss }: { accepted: AcceptedQuote; onUndone: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { canUpdate, undo } = useQuoteActions();
  const [late, setLate] = useState(false);

  const run = async () => {
    try {
      await undo.mutateAsync({ id: accepted.quoteId, salesorderId: accepted.salesorderId });
    } catch (e) {
      if (e instanceof ApiError && (e.code ?? e.message) === 'undo_too_late') setLate(true);
      else showToast(t('orders.quotes.undoFailed', { reason: quoteReason(t, e) }), 'error');
      return;
    }
    onUndone();
  };

  return (
    <div data-testid="quote-accepted" role="status" className="animate-rise-sm mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-violet-500/40 bg-violet-500/10 px-4 py-2 text-sm text-violet-800 dark:text-violet-100">
      <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
      <span className="min-w-0 grow basis-48">{t('orders.quotes.accepted', { quote: accepted.quote, order: accepted.order })}</span>
      {late ? (
        <span className="text-bambu-gray first-letter:uppercase">{t('orders.err.undo_too_late')}</span>
      ) : canUpdate && (
        <button type="button" onClick={run} disabled={undo.isPending} className="btn-press inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium underline hover:bg-violet-500/15 disabled:opacity-60">
          {undo.isPending && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          {t('orders.quotes.undo')}
        </button>
      )}
      <button type="button" aria-label={t('common.close')} onClick={onDismiss} className="btn-press rounded-md p-1 text-bambu-gray hover:text-white">
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>
  );
}
