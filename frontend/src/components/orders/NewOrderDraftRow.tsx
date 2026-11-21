import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Loader2, Plus, RotateCcw, X } from 'lucide-react';
import { api } from '../../api/client';
import type { FinishedOrderRow, OrderBoardRow, OrderEditResult, QuoteRow, QuotesResponse, ZohoContact } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useAitoZohoStatus } from '../../hooks/useAitoZohoStatus';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useNewOrderDraft } from '../../hooks/useNewOrderDraft';
import type { NewOrderDraft } from '../../hooks/useNewOrderDraft';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { ClientCombobox } from '../aito/ClientCombobox';
import { HoldButton } from '../aito/HoldButton';
import { NewContactForm } from '../aito/NewContactForm';
import { focusRingCls } from '../formStyles';
import { NewOrderLines } from './NewOrderLines';
import { lineTotal, normDiscount } from './orderBoard';
import { OrderClientHistory } from './OrderClientHistory';
import { OrderContactBlock } from './OrderContactBlock';
import { errorReason } from './orderErrors';

const MODAL_OUT_MS = 170;

export type QuoteSaved = { quotes: QuotesResponse; estimate_id: string };

/** An existing quote as a draft: its customer, and its lines at the quote's own unit price. */
const fromQuote = (q: QuoteRow): NewOrderDraft => ({
  client: { id: q.customer_id, name: q.customer, isDefault: false },
  clientRef: '',
  lines: (q.lines ?? []).map(l => ({
    lineId: l.id,
    item: { id: l.item_id ?? '', name: l.name, sku: l.sku, rate: l.rate, stock_on_hand: l.available, product_type: 'goods' },
    quantity: l.quantity,
    discount: l.discount ?? '',
  })),
});

/** A counter order (or, `mode="quote"`, a quote) being put together in a modal over the board. Nothing reaches Books
 *  before "Create"; the draft lives in the browser until then (closing keeps it, the hold button clears it).
 *  With `quote`, the dialog edits that quote: it starts from the quote, keeps nothing, and closing drops the changes. */
export function NewOrderDraftRow({ currency, open, finished, mode = 'order', quote, onCreated, onClose }: {
  currency: string;
  open: OrderBoardRow[];
  finished: FinishedOrderRow[];
  mode?: 'order' | 'quote';
  quote?: QuoteRow;
  onCreated: (result: (OrderEditResult & { salesorder_id: string }) | QuoteSaved) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [start] = useState(() => (quote ? fromQuote(quote) : undefined));
  const { draft, setDraft, reset } = useNewOrderDraft(mode, start);
  const isQuote = mode === 'quote';
  const status = useAitoZohoStatus();
  const defaultId = status.data?.default_contact_id ?? '';
  // No client picked means the client de passage, resolved here rather than stored.
  const client = draft.client ?? (defaultId ? { id: defaultId, name: status.data?.default_contact_name ?? '', isDefault: true } : null);
  const [creatingClient, setCreatingClient] = useState(false);
  const { hasPermission } = useAuth();
  const realClient = client && client.id !== defaultId ? client.id : '';
  // The live Books record: phone, mobile and email, re-read after an edit.
  const contact = useQuery({
    queryKey: ['zoho-contact', realClient],
    queryFn: () => api.getZohoContact(realClient),
    enabled: !!realClient,
    staleTime: 60_000,
  });
  const [tried, setTried] = useState(false);

  const totals = draft.lines.map(lineTotal);
  const total = totals.reduce<number>((s, x) => s + (x ?? 0), 0);
  const gross = draft.lines.reduce((s, l) => s + l.quantity * l.item.rate, 0);
  const units = draft.lines.reduce((s, l) => s + l.quantity, 0);
  const saved = totals.includes(null) ? 0 : gross - total;
  // The total rolls the way it moved: up from below when it grew, down from above when it shrank. n re-keys the roll.
  const [roll, setRoll] = useState({ total, dir: '', n: 0 });
  if (roll.total !== total) setRoll({ total, dir: total > roll.total ? 'up' : 'down', n: roll.n + 1 });
  const why = !draft.lines.length ? t('orders.newOrder.noLines')
    : totals.includes(null) ? t('orders.newOrder.discountInvalid')
    : !client ? t('aito.noClient')
    : null;

  const create = useMutation({
    mutationFn: (customerId: string): Promise<(OrderEditResult & { salesorder_id: string }) | QuoteSaved> => {
      // A kept quote line sends its line_id and its current discount (none sent removes it).
      const lines = draft.lines.map(l => {
        const discount = normDiscount(l.discount);
        return { ...(l.lineId ? { line_id: l.lineId } : {}), item_id: l.item.id, quantity: l.quantity, ...(discount ? { discount } : {}) };
      });
      if (quote) return api.editQuote(quote.id, { customer_id: customerId, lines });
      const body = { customer_id: customerId, client_ref: draft.clientRef, lines };
      return isQuote ? api.createQuote(body) : api.createCounterOrder(body);
    },
    // reset, not clearNewOrderDraft: it also mints a new client_ref, or the next order would be deduped into this one.
    onSuccess: result => {
      if (!quote) reset();
      onCreated(result);
    },
    onError: e => showToast(t(isQuote ? 'orders.newQuote.failed' : 'orders.newOrder.failed', { reason: errorReason(t, e, isQuote ? 'orders.newQuote.err' : undefined) }), 'error'),
  });
  const busy = create.isPending;
  const canCreate = !why && !busy;
  const submit = () => {
    if (canCreate && client) create.mutate(client.id);
    else setTried(true);
  };
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    onEscape: close => {
      if (creatingClient) setCreatingClient(false);
      else if (!busy) close();
    },
  });
  const title = quote ? t('orders.newQuote.editTitle') : isQuote ? t('orders.newQuote.title') : t('orders.newOrder.title');
  // Quotes wear violet, orders the board's green: the two documents never look alike.
  const tone = isQuote
    ? { bg: 'bg-violet-600', lit: 'shadow-violet-600/20 hover:bg-violet-500' }
    : { bg: 'bg-bambu-green', lit: 'shadow-bambu-green/20 hover:bg-bambu-green-light' };
  const pick = (c: ZohoContact) => {
    setDraft({ ...draft, client: { id: c.id, name: c.name, isDefault: c.id === defaultId } });
    setCreatingClient(false);
  };

  return (
    <div
      className={`fixed inset-0 z-[110] flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:pt-[8vh] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={busy ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // Not clipped: the client field sits in the bottom bar and its list opens below the card.
        className={`flex w-full max-w-[96rem] flex-col focus:outline-none ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
          <span className="text-base font-semibold text-white">{title}</span>
          {isQuote ? (
            <span className={`rounded bg-violet-500/15 px-1.5 py-0.5 text-[11px] text-violet-700 dark:text-violet-300 ${quote ? 'font-mono' : ''}`}>
              {quote ? quote.number : t('orders.newOrder.draft')}
            </span>
          ) : (
            <span className="rounded bg-bambu-green/15 px-1.5 py-0.5 text-[11px] text-bambu-green">{t('orders.newOrder.draft')}</span>
          )}
          <button type="button" onClick={requestClose} disabled={busy} className={`ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-bambu-gray hover:text-white ${focusRingCls}`}>
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.newOrder.abandon')}
          </button>
        </div>
        {/* Cart on the left, the decision rail on the right: who, then what, then pay. Stacks below md. */}
        <div className="grid border-t border-bambu-dark-tertiary md:min-h-[60vh] md:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="min-w-0 bg-bambu-dark/40 px-5 py-4 md:rounded-bl-xl">
            <NewOrderLines lines={draft.lines} currency={currency} disabled={busy} onChange={lines => setDraft({ ...draft, lines })} />
          </div>
          <aside className="flex min-w-0 flex-col border-t border-bambu-dark-tertiary md:border-l md:border-t-0">
            <section className="animate-rise space-y-4 border-b border-bambu-dark-tertiary px-5 py-4" style={{ animationDelay: '60ms' }}>
              {creatingClient ? (
                <NewContactForm onCancel={() => setCreatingClient(false)} onCreated={pick} />
              ) : (
                <ClientCombobox
                  clientName={client?.name ?? ''}
                  onSelect={pick}
                  onCreateNew={() => setCreatingClient(true)}
                  onReset={() => setDraft({ ...draft, client: null })}
                  showReset={!!client && client.id !== defaultId}
                />
              )}
              {/* Re-keyed per client: a new pick rises in instead of swapping in place. */}
              {realClient && (
                <div key={realClient} className="animate-rise space-y-4">
                  {/* Shown once Books answered: a loading card would read "no phone, no email". */}
                  {(contact.data || contact.isError) && (
                  <OrderContactBlock
                    contact={contact.data ?? { name: client?.name ?? '', email: '', phone: '', mobile: '' }}
                    orderNumber=""
                    others={[]}
                    customerId={realClient}
                    canEdit={hasPermission('aito:create') && !!contact.data}
                  />
                  )}
                  <OrderClientHistory customerId={realClient} open={open} finished={finished} currency={currency} />
                </div>
              )}
            </section>
            {/* Sticks to the bottom of the viewport while a long cart scrolls the modal. */}
            <section className="animate-rise sticky bottom-0 mt-auto space-y-4 rounded-b-xl bg-bambu-dark-secondary px-5 py-4 md:rounded-bl-none" style={{ animationDelay: '120ms' }}>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between text-bambu-gray">
                  <dt>{t('orders.units', { count: units })}</dt>
                  <dd className="tabular-nums">{formatMoney(gross, currency)}</dd>
                </div>
                {saved > 0.005 && (
                  <div className="fold-open flex justify-between text-bambu-green">
                    <dt>{t('orders.newOrder.discount')}</dt>
                    <dd className="tabular-nums">−{formatMoney(saved, currency)}</dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between border-t border-dashed border-bambu-dark-tertiary pt-3">
                  <dt className="text-bambu-gray">{t('orders.newOrder.total')}</dt>
                  <dd className="overflow-hidden text-2xl font-bold tabular-nums text-white">
                    <span key={roll.n} data-testid="draft-total" className={`inline-block ${roll.dir ? `animate-order-total-${roll.dir}` : ''}`}>
                      {formatMoney(total, currency)}
                    </span>
                  </dd>
                </div>
              </dl>
              <div className="flex items-stretch gap-2">
                {!quote && <HoldButton
                  onHold={reset}
                  durationMs={500}
                  progress="perimeter"
                  label={t('orders.newOrder.reset')}
                  hint={t('orders.newOrder.holdToReset')}
                  className={`h-12 w-12 flex-shrink-0 justify-center border border-bambu-dark-tertiary text-bambu-gray transition-colors hover:border-red-400/40 hover:text-red-400 data-[holding=true]:border-red-400 data-[holding=true]:text-red-400 ${focusRingCls}`}
                >
                  <RotateCcw className="relative h-4 w-4" />
                </HoldButton>}
                <button
                  type="button"
                  // Not `disabled`: the click on a blocked button is what says why.
                  aria-disabled={!canCreate}
                  onClick={submit}
                  className={`btn-press inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-lg ${tone.bg} px-6 text-sm font-semibold text-white transition-[opacity,background-color,box-shadow] duration-200 ${focusRingCls} ${canCreate ? `shadow-lg ${tone.lit}` : 'opacity-45'}`}
                >
                  {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : quote ? <Check aria-hidden="true" className="h-4 w-4" /> : <Plus aria-hidden="true" className="h-4 w-4" />}
                  {quote
                    ? (busy ? t('orders.newQuote.saving') : t('orders.newQuote.save'))
                    : busy ? t('orders.newOrder.creating') : t(isQuote ? 'orders.newQuote.create' : 'orders.newOrder.create')}
                </button>
              </div>
              {quote?.state === 'expired' && <p className="text-xs text-bambu-gray">{t('orders.newQuote.redated')}</p>}
              {tried && why && <p role="alert" className="animate-rise text-xs text-red-400">{why}</p>}
            </section>
          </aside>
        </div>
      </Card>
    </div>
  );
}
