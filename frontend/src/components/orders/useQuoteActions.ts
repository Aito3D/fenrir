import { useTranslation } from 'react-i18next';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { api, ApiError } from '../../api/client';
import type { OrderBoardResponse, QuoteOrderResult, QuoteRow, QuotesResponse } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { errorReason } from './orderErrors';
import { quotesQuery } from './quotes';

const BOARD_KEY = ['order-board'] as const;
const ACTION_KEY = ['quote-action'] as const;

export type QuoteAction = 'decline' | 'reopen' | 'accept' | 'order';
const CALL = { decline: api.declineQuote, reopen: api.reopenQuote, accept: api.acceptQuote, order: api.createOrderFromQuote };

/** True for a mutation of this hook: the page tells them from the order actions that end the accepted notice. */
export const isQuoteAction = (key: readonly unknown[] | undefined): boolean => key?.[0] === ACTION_KEY[0];

/** True while any action on this quote is in flight (from any component). */
export function useQuoteBusy(id: string | null): boolean {
  return useIsMutating({ mutationKey: ACTION_KEY, predicate: m => (m.state.variables as { id?: string } | undefined)?.id === id }) > 0;
}

/** The quote as the list showed it at the click: a converted quote leaves the list the server answers with. */
export type ClickedQuote = Pick<QuoteRow, 'id' | 'number'>;

/** A quote refusal in words: 409 another action holds the quote, 404 the quote is gone. */
export const quoteReason = (t: TFunction, e: unknown): string =>
  e instanceof ApiError && e.status === 409 ? t('orders.quotes.running')
  : e instanceof ApiError && e.status === 404 ? t('orders.quotes.gone')
  : errorReason(t, e);

/** The write actions of a quote, all to Zoho Books: refuse, reopen, accept, create its order, undo an accept, email it.
 *  Each answer carries the fresh quotes (and the board when an order moved), which go straight into the cache.
 *  After any failure both are refetched, so the screen shows what Books now holds, never a guess.
 *  `onOrdered` runs from the mutation itself, so it still fires after the footer unmounted. */
export function useQuoteActions(onOrdered?: (result: QuoteOrderResult, quote: ClickedQuote) => void) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();

  const take = async ({ quotes, board }: { quotes: QuotesResponse; board?: OrderBoardResponse }) => {
    // A poll already in flight would land after this answer and put the old list back.
    await queryClient.cancelQueries({ queryKey: quotesQuery.queryKey, exact: true });
    queryClient.setQueryData(quotesQuery.queryKey, quotes);
    if (board) {
      await queryClient.cancelQueries({ queryKey: BOARD_KEY, exact: true });
      queryClient.setQueryData(BOARD_KEY, board);
    }
    void queryClient.invalidateQueries({ queryKey: ['quote-events'] });
  };
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: quotesQuery.queryKey, exact: true });
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY, exact: true });
  };

  const act = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: ({ id, action }: { id: string; action: QuoteAction }): Promise<{ quotes: QuotesResponse } | QuoteOrderResult> => CALL[action](id),
    onMutate: ({ id }): ClickedQuote =>
      queryClient.getQueryData<QuotesResponse>(quotesQuery.queryKey)?.rows.find(q => q.id === id) ?? { id, number: '' },
    onSuccess: async (r, _v, clicked) => {
      await take(r);
      if ('salesorder_id' in r) onOrdered?.(r, clicked);
    },
    onError: e => {
      refetch();
      showToast(t('orders.quotes.failed', { reason: quoteReason(t, e) }), 'error');
    },
  });
  // The caller words an undo's failure: "too late" belongs in the notice, not a toast.
  const undo = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: ({ id, salesorderId }: { id: string; salesorderId: string }) => api.undoAcceptQuote(id, salesorderId),
    onSuccess: take,
    onError: refetch,
  });
  const email = useMutation({
    mutationKey: ACTION_KEY,
    mutationFn: ({ id, to }: { id: string; to: string }) => api.sendQuoteEmail(id, to),
    onSuccess: take,
    onError: refetch,
  });

  return { canUpdate: hasPermission('orders:update'), act, undo, email };
}
