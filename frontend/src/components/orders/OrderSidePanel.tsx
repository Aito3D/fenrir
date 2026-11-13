import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { OrderPanelRow } from '../../api/client';
import { PanelTabs } from '../aito/PanelTabs';
import { panelTabId, panelTabPanelId } from '../aito/panelTabIds';
import { usePanelTab } from '../../hooks/usePanelTab';
import { OrderActivity } from './OrderActivity';
import { OrderContactBlock } from './OrderContactBlock';
import { OrderInvoicesBlock } from './OrderInvoicesBlock';
import { OrderPaymentBlock } from './OrderPaymentBlock';
import { OrderSmsModal } from './OrderSmsModal';
import type { useOrderActions } from './useOrderActions';

const SIDE_TABS = ['details', 'activity'] as const;

/** The column beside the lines: contact, payment and invoices, or the order's history. */
export function OrderSidePanel({
  row,
  others,
  onGoto,
  canUpdate,
  createInvoice,
  smsAllowed,
  editingTotal,
}: {
  row: OrderPanelRow;
  others: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  canUpdate: boolean;
  createInvoice: ReturnType<typeof useOrderActions>['createInvoice'];
  smsAllowed: boolean;
  /** The total with the open edit applied, while one is open. */
  editingTotal: number | null;
}) {
  const { t } = useTranslation();
  const [sideTab, setSideTab] = usePanelTab(SIDE_TABS, 'orders.panel.tab');
  const tabScope = `order-${row.id}-`;
  const [smsPhone, setSmsPhone] = useState<string | null>(null);
  // `?sms=1` (the bell's "packed" row): open the pick-up SMS draft once, then drop the flag so a reload does not reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  const askedSms = searchParams.get('sms') === '1' && searchParams.get('order') === row.id;
  const contactPhone = row.contact?.mobile || row.contact?.phone || null;
  useEffect(() => {
    if (!askedSms) return;
    if (smsAllowed && contactPhone) setSmsPhone(contactPhone);
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('sms'); return next; }, { replace: true });
  }, [askedSms, smsAllowed, contactPhone, setSearchParams]);
  const invoiceSent = useRef(false);
  return (
    <div className="min-w-0 lg:self-start">
      <PanelTabs
        tabs={[
          { id: 'details', label: t('aito.panelTabDetails') },
          { id: 'activity', label: t('aito.history.title') },
        ]}
        selected={sideTab}
        onSelect={setSideTab}
        attentionLabel={t('aito.panelTabAttention')}
        scope={tabScope}
      />
      {/* Only the selected panel mounts, so the history query never runs behind a closed tab. */}
      <div role="tabpanel" id={panelTabPanelId(sideTab, tabScope)} aria-labelledby={panelTabId(sideTab, tabScope)}>
        {sideTab === 'details' ? (
          <div className="space-y-3">
            <OrderContactBlock
              contact={row.contact}
              orderNumber={row.number}
              others={others}
              onGoto={onGoto}
              sms={smsAllowed ? { contacted: row.contacted ?? null, onOpen: setSmsPhone } : undefined}
            />
            {smsPhone && <OrderSmsModal row={row} phone={smsPhone} onClose={() => setSmsPhone(null)} />}
            {row.payment && <OrderPaymentBlock payment={row.payment} currency={row.currency} total={editingTotal ?? undefined} quoteNumber={row.facts.quote_number} orderId={canUpdate && (row as { status?: string }).status !== 'finished' ? row.id : undefined} />}
            <OrderInvoicesBlock
              row={row}
              canEmail={canUpdate}
              busy={createInvoice.isPending}
              onCreateInvoice={canUpdate ? () => {
                if (createInvoice.isPending || invoiceSent.current) return;
                invoiceSent.current = true;
                createInvoice.mutate({ id: row.id, applyCredit: (row.payment?.advance ?? 0) + (row.payment?.retainer ?? 0) > 0 }, { onSettled: () => { invoiceSent.current = false; } });
              } : undefined}
              onInvoiceNow={canUpdate ? (scope, applyCredit) => {
                if (createInvoice.isPending || invoiceSent.current) return;
                invoiceSent.current = true;
                createInvoice.mutate({ id: row.id, applyCredit, scope }, { onSettled: () => { invoiceSent.current = false; } });
              } : undefined}
            />
          </div>
        ) : (
          <OrderActivity soId={row.id} currency={row.currency} />
        )}
      </div>
    </div>
  );
}
