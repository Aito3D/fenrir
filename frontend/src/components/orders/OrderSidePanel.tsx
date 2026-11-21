import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { OrderPanelRow } from '../../api/client';
import { PanelTabs } from '../aito/PanelTabs';
import { panelTabId, panelTabPanelId } from '../aito/panelTabIds';
import { usePanelTab } from '../../hooks/usePanelTab';
import { OrderActivity } from './OrderActivity';
import { OrderContactBlock } from './OrderContactBlock';
import { OrderDepositAvailable } from './OrderDepositAvailable';
import { OrderInvoicesBlock } from './OrderInvoicesBlock';
import { OrderPaymentBlock } from './OrderPaymentBlock';
import { OrderSmsModal } from './OrderSmsModal';
import type { useOrderActions } from './useOrderActions';

const SIDE_TABS = ['details', 'activity'] as const;

/** The phone view's tabs: the products live in the lines panel, the rest here. */
export type PhoneTab = 'lines' | 'billing' | 'client' | 'activity';

/** The column beside the lines: contact, payment and invoices, or the order's history. */
export function OrderSidePanel({
  row,
  others,
  onGoto,
  canUpdate,
  createInvoice,
  smsAllowed,
  editingTotal,
  phoneTab,
  phoneScope,
}: {
  row: OrderPanelRow;
  others: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  canUpdate: boolean;
  createInvoice: ReturnType<typeof useOrderActions>['createInvoice'];
  smsAllowed: boolean;
  /** The total with the open edit applied, while one is open. */
  editingTotal: number | null;
  /** On the phone the panel shows one block at a time and has no tab strip of its own. */
  phoneTab?: PhoneTab;
  phoneScope?: string;
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
  const sendInvoice = (applyCredit: boolean, scope?: 'packed' | 'whole') => {
    if (createInvoice.isPending || invoiceSent.current) return;
    invoiceSent.current = true;
    createInvoice.mutate({ id: row.id, applyCredit, scope }, { onSettled: () => { invoiceSent.current = false; } });
  };
  // Built once so the desktop tab and the phone tabs render the very same blocks.
  const contactBlock = (
    <OrderContactBlock
      contact={row.contact}
      orderId={row.id}
      canEdit={canUpdate}
      orderNumber={row.number}
      others={others}
      onGoto={onGoto}
      sms={smsAllowed ? { contacted: row.contacted ?? null, onOpen: setSmsPhone } : undefined}
    />
  );
  // Fixed over the screen, so on the phone it sits outside the hidden tab wrapper.
  const smsModal = smsPhone && <OrderSmsModal row={row} phone={smsPhone} onClose={() => setSmsPhone(null)} />;
  const invoicesBlock = (
    <OrderInvoicesBlock
      row={row}
      canEmail={canUpdate}
      busy={createInvoice.isPending}
      onCreateInvoice={canUpdate ? () => sendInvoice((row.payment?.advance ?? 0) + (row.payment?.retainer ?? 0) > 0) : undefined}
      onInvoiceNow={canUpdate ? (scope, applyCredit) => sendInvoice(applyCredit, scope) : undefined}
    >
      <OrderDepositAvailable orderId={row.id} currency={row.currency} />
      {row.payment && <OrderPaymentBlock payment={row.payment} currency={row.currency} total={editingTotal ?? undefined} orderId={canUpdate ? row.id : undefined} />}
    </OrderInvoicesBlock>
  );
  if (phoneTab) {
    const tabPanel = (id: PhoneTab) => ({ role: 'tabpanel', id: panelTabPanelId(id, phoneScope), 'aria-labelledby': panelTabId(id, phoneScope) });
    return (
      <div className="min-w-0">
        <div hidden={phoneTab !== 'billing'} {...tabPanel('billing')}>{invoicesBlock}</div>
        <div hidden={phoneTab !== 'client'} {...tabPanel('client')}>{contactBlock}</div>
        {smsModal}
        {phoneTab === 'activity' && <div {...tabPanel('activity')}><OrderActivity soId={row.id} currency={row.currency} /></div>}
      </div>
    );
  }
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
      <div key={sideTab} className="animate-fade-in" role="tabpanel" id={panelTabPanelId(sideTab, tabScope)} aria-labelledby={panelTabId(sideTab, tabScope)}>
        {sideTab === 'details' ? (
          <div className="space-y-3">
            {contactBlock}
            {smsModal}
            {invoicesBlock}
          </div>
        ) : (
          <OrderActivity soId={row.id} currency={row.currency} />
        )}
      </div>
    </div>
  );
}
