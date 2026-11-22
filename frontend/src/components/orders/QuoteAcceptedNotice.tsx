import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { quoteReason, useQuoteActions } from './useQuoteActions';

/** `undoable` is false when Books reused a draft order that existed before the click. */
export type AcceptedQuote = { quoteId: string; quote: string; salesorderId: string; order: string; undoable: boolean };

/** A bar floating at the bottom of the screen, in the quotes' violet: which quote became which order, with Undo
 *  (deletes the order in Books, the quote goes back to sent). Portalled to the body so it stays above the opened order:
 *  z-[46] is over the phone's full-screen order (z-[45]) and under the toasts (z-[60]); on a phone it clears the
 *  order's bottom action bar. An undo refused as too late, or whose order already left the board, says so in
 *  place and loses its button. */
export function QuoteAcceptedNotice({ accepted, onUndone, onDismiss }: { accepted: AcceptedQuote; onUndone: () => void; onDismiss: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { canUpdate, undo } = useQuoteActions();
  const [refused, setRefused] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Keyboard and screen-reader users land on what just happened.
  useEffect(() => box.current?.focus(), []);

  const run = async () => {
    try {
      await undo.mutateAsync({ id: accepted.quoteId, salesorderId: accepted.salesorderId });
    } catch (e) {
      if (e instanceof ApiError && (e.code ?? e.message) === 'undo_too_late') setRefused(t('orders.err.undo_too_late'));
      else if (e instanceof ApiError && e.status === 404) setRefused(t('orders.quotes.orderGone'));
      else showToast(t('orders.quotes.undoFailed', { reason: quoteReason(t, e) }), 'error');
      return;
    }
    onUndone();
  };

  const btn = `btn-press inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-md md:min-h-0 ${focusRingCls}`;
  return createPortal(
    <div
      ref={box}
      tabIndex={-1}
      data-testid="quote-accepted"
      role="status"
      className="animate-rise-sm fixed inset-x-3 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[46] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-violet-500/40 bg-violet-50 py-1 pl-4 pr-1 text-sm text-violet-800 shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 md:bottom-4 md:left-1/2 md:right-auto md:w-[36rem] md:-translate-x-1/2 dark:bg-violet-950 dark:text-violet-100"
    >
      <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
      <span className="min-w-0 grow basis-48 py-1">{t('orders.quotes.accepted', { quote: accepted.quote, order: accepted.order })}</span>
      {refused ? (
        <span className="text-violet-700/80 first-letter:uppercase dark:text-violet-200/80">{refused}</span>
      ) : canUpdate && accepted.undoable && (
        <button type="button" onClick={run} disabled={undo.isPending} className={`${btn} px-2 font-medium underline hover:bg-violet-500/15 disabled:opacity-60`}>
          {undo.isPending && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
          {t('orders.quotes.undo')}
        </button>
      )}
      <button type="button" aria-label={t('common.close')} onClick={onDismiss} className={`${btn} min-w-[44px] p-1 text-violet-700 hover:bg-violet-500/15 md:min-w-0 dark:text-violet-200`}>
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
}
