import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { EyeOff, Loader2, Plus, RotateCcw, X } from 'lucide-react';
import { api } from '../../api/client';
import type { FinishedOrderRow, OrderBoardRow, OrderEditResult, ZohoContact } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useAitoZohoStatus } from '../../hooks/useAitoZohoStatus';
import { useNewOrderDraft } from '../../hooks/useNewOrderDraft';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { ClientCombobox } from '../aito/ClientCombobox';
import { HoldButton } from '../aito/HoldButton';
import { NewContactForm } from '../aito/NewContactForm';
import { focusRingCls } from '../formStyles';
import { NewOrderLines } from './NewOrderLines';
import { lineTotal, normDiscount } from './orderBoard';
import { OrderClientHistory } from './OrderClientHistory';
import { errorReason } from './orderErrors';

/** A counter order being put together at the top of the board. Nothing reaches Books before "Create order";
 *  the draft lives in the browser until then (abandon keeps it, the hold button clears it). */
export function NewOrderDraftRow({ hiddenCount, currency, open, finished, onCreated, onClose }: {
  hiddenCount: number;
  currency: string;
  open: OrderBoardRow[];
  finished: FinishedOrderRow[];
  onCreated: (result: OrderEditResult & { salesorder_id: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { draft, setDraft, reset } = useNewOrderDraft();
  const status = useAitoZohoStatus();
  const defaultId = status.data?.default_contact_id ?? '';
  // No client picked means the client de passage, resolved here rather than stored.
  const client = draft.client ?? (defaultId ? { id: defaultId, name: status.data?.default_contact_name ?? '', isDefault: true } : null);
  const [creatingClient, setCreatingClient] = useState(false);
  const [tried, setTried] = useState(false);

  const totals = draft.lines.map(lineTotal);
  const total = totals.reduce<number>((s, x) => s + (x ?? 0), 0);
  const why = !draft.lines.length ? t('orders.newOrder.noLines')
    : totals.includes(null) ? t('orders.newOrder.discountInvalid')
    : !client ? t('aito.noClient')
    : null;

  const create = useMutation({
    mutationFn: (customerId: string) => api.createCounterOrder({
      customer_id: customerId,
      client_ref: draft.clientRef,
      lines: draft.lines.map(l => {
        const discount = normDiscount(l.discount);
        return { item_id: l.item.id, quantity: l.quantity, ...(discount ? { discount } : {}) };
      }),
    }),
    // reset, not clearNewOrderDraft: it also mints a new client_ref, or the next order would be deduped into this one.
    onSuccess: result => {
      reset();
      onCreated(result);
    },
    onError: e => showToast(t('orders.newOrder.failed', { reason: errorReason(t, e) }), 'error'),
  });
  const busy = create.isPending;
  const canCreate = !why && !busy;
  const submit = () => {
    if (canCreate && client) create.mutate(client.id);
    else setTried(true);
  };
  const pick = (c: ZohoContact) => {
    setDraft({ ...draft, client: { id: c.id, name: c.name, isDefault: c.id === defaultId } });
    setCreatingClient(false);
  };

  return (
    <div className="space-y-3">
      <Card className="overflow-clip ring-1 ring-bambu-green/60">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <span className="font-semibold text-white">{t('orders.newOrder.title')}</span>
          <span className="rounded bg-bambu-green/15 px-1.5 py-0.5 text-[11px] text-bambu-green">{t('orders.newOrder.draft')}</span>
          <span className="ml-auto text-sm tabular-nums text-white">{formatMoney(total, currency)}</span>
          <button type="button" onClick={onClose} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-bambu-gray hover:text-white ${focusRingCls}`}>
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.newOrder.abandon')}
          </button>
        </div>
        <div className="animate-rise-sm grid gap-4 border-t border-bambu-dark-tertiary bg-bambu-dark/40 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_27rem]">
          <NewOrderLines lines={draft.lines} currency={currency} disabled={busy} onChange={lines => setDraft({ ...draft, lines })} />
          <div className="space-y-3 self-start lg:sticky lg:top-4">
            <div className="flex items-baseline justify-between rounded-lg border border-bambu-dark-tertiary px-3 py-2">
              <span className="text-sm text-bambu-gray">{t('orders.newOrder.total')}</span>
              <span data-testid="draft-total" className="text-lg font-bold tabular-nums text-white">{formatMoney(total, currency)}</span>
            </div>
            <div className="rounded-lg border border-bambu-dark-tertiary p-3">
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
            </div>
            {client && client.id !== defaultId && (
              <OrderClientHistory customerId={client.id} open={open} finished={finished} currency={currency} />
            )}
            <div className="flex items-stretch gap-2">
              <HoldButton
                onHold={reset}
                durationMs={500}
                progress="perimeter"
                label={t('orders.newOrder.reset')}
                hint={t('orders.newOrder.holdToReset')}
                className={`w-9 flex-shrink-0 justify-center border border-bambu-dark-tertiary py-2 text-bambu-gray transition-colors hover:border-red-400/40 hover:text-red-400 data-[holding=true]:border-red-400 data-[holding=true]:text-red-400 ${focusRingCls}`}
              >
                <RotateCcw className="h-4 w-4" />
              </HoldButton>
              <button
                type="button"
                // Not `disabled`: the click on a blocked button is what says why.
                aria-disabled={!canCreate}
                onClick={submit}
                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-bambu-green px-4 py-2 text-sm font-semibold text-white transition-opacity ${focusRingCls} ${canCreate ? 'hover:bg-bambu-green-light' : 'opacity-45'}`}
              >
                {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Plus aria-hidden="true" className="h-4 w-4" />}
                {busy ? t('orders.newOrder.creating') : t('orders.newOrder.create')}
              </button>
            </div>
            {tried && why && <p role="alert" className="text-xs text-red-400">{why}</p>}
          </div>
        </div>
      </Card>
      {hiddenCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-bambu-dark-tertiary px-4 py-2 text-xs text-bambu-gray">
          <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
          {t('orders.newOrder.hidden', { count: hiddenCount })}
        </div>
      )}
    </div>
  );
}
