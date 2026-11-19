import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useAitoShippingServices } from '../../hooks/useAitoShippingServices';
import aito3dLogo from '../../assets/aito3d_logo.png';
import { AitoDialogFooter } from '../aito/AitoDialogFooter';
import { AitoDialogShell } from '../aito/AitoDialogShell';
import { usePrintBlob } from '../aito/usePrintBlob';

const MODAL_OUT_MS = 170;
const FIELD = 'w-full rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-sm text-white focus:border-bambu-green focus:outline-none';

/** The Aito parcel label for an order. Books has no island or air-freight service for an order, so the operator
 *  picks them here; the recipient is prefilled from the order's contact and the reference is its newest invoice
 *  (else the order number). */
export function OrderShippingLabelModal({ row, onClose }: { row: OrderPanelRow; onClose: () => void }) {
  const { t } = useTranslation();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const services = useAitoShippingServices().data?.services ?? [];
  const [name, setName] = useState(row.contact?.name ?? row.customer);
  const [phone, setPhone] = useState(row.contact?.mobile || row.contact?.phone || '');
  const [serviceKey, setServiceKey] = useState('');
  const [islandKey, setIslandKey] = useState('');
  const service = services.find(s => s.key === serviceKey);
  const island = service?.islands.find(i => i.key === islandKey);
  const invoices = row.payment?.invoices ?? [];
  const reference = invoices.length ? invoices[invoices.length - 1].number : row.number;
  const { print, busy } = usePrintBlob({ failureMessage: t('aito.shippingLabelPrintFailed'), downloadFilename: `etiquette-${reference}.html` });

  const printLabel = () => {
    if (!service || !island) return;
    void print(async () => {
      // Same lazy chunk as the Aito button: react-dom/server and the QR code belong to this click.
      const { buildShippingLabelHtml } = await import('../../utils/shippingLabel');
      const { formatPhoneDisplay } = await import('../../utils/clientDraft');
      const html = buildShippingLabelHtml(
        { recipientName: name.trim(), recipientPhone: phone.trim() ? formatPhoneDisplay(phone.trim()) : '', island: island.label, serviceName: service.name, reference },
        new URL(aito3dLogo, window.location.href).href,
      );
      return new Blob([html], { type: 'text/html' });
    });
  };

  return (
    <AitoDialogShell
      label={t('aito.printShippingLabel')}
      testId="order-shipping-label"
      icon={Tag}
      subtitle={`${row.number} · ${reference}`}
      closing={closing}
      requestClose={requestClose}
      dialogRef={dialogRef}
      busy={busy}
      maxWidthCls="max-w-[440px]"
    >
      <div className="space-y-3 px-6 pb-4 text-xs">
        <label className="block">
          <span className="text-bambu-gray">{t('aito.shippingRecipient')}</span>
          <input value={name} onChange={e => setName(e.target.value)} maxLength={120} className={FIELD} />
        </label>
        <label className="block">
          <span className="text-bambu-gray">{t('aito.shippingPhone')}</span>
          <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={50} className={FIELD} />
        </label>
        <label className="block">
          <span className="text-bambu-gray">{t('aito.shippingService')}</span>
          <select value={serviceKey} onChange={e => { setServiceKey(e.target.value); setIslandKey(''); }} className={FIELD}>
            <option value="" />
            {services.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-bambu-gray">{t('aito.shippingIsland')}</span>
          <select value={islandKey} onChange={e => setIslandKey(e.target.value)} disabled={!service} className={FIELD}>
            <option value="" />
            {(service?.islands ?? []).map(i => <option key={i.key} value={i.key}>{i.label}</option>)}
          </select>
        </label>
      </div>
      <AitoDialogFooter pending={busy} onCancel={requestClose} confirmLabel={t('aito.printShippingLabel')} confirmDisabled={!service || !island || !name.trim()} onConfirm={printLabel} />
    </AitoDialogShell>
  );
}
