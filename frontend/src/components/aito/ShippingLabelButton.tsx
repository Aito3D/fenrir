import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Printer } from 'lucide-react';
import { api, type AitoProject } from '../../api/client';
import { buildShippingLabelHtml, shippingLabelFor } from '../../utils/shippingLabel';
import { usePrintBlob } from './usePrintBlob';
import { useAitoInvoice } from './useAitoInvoice';
import aito3dLogo from '../../assets/aito3d_logo.png';

/** Shared look of the Shipping card's header cells — Print, Edit, Remove —
 *  so the three read as one row. Exported for the card's own two. */
export const SHIPPING_HEADER_CELL =
  'inline-flex items-center justify-center rounded-md p-1 text-bambu-gray transition-colors ' +
  'motion-reduce:transition-none hover:bg-bambu-dark-tertiary hover:text-white ' +
  'disabled:opacity-40 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40';

/** Print the parcel's shipping label — half an A4, recipient and island in
 *  large type, the shop as sender.
 *
 *  A cell in the Shipping card's header, beside Edit and Remove: the label
 *  is a fact about the shipment, and the operator who is closing the box is
 *  looking at the shipment card. Renders nothing unless the project is in
 *  Finish AND carries shipping (`shippingLabelFor` owns both gates), so on a
 *  shipment still in production the header is exactly as it was.
 *
 *  The reference printed on the label is the invoice number when Books has
 *  one (`useAitoInvoice`, the same cache entry the Invoice card reads, so
 *  this costs no extra request), else the quote number, else nothing.
 *
 *  The document is built in the browser (`buildShippingLabelHtml`) — no
 *  endpoint, no Zoho — and printed through the same hidden-iframe machinery
 *  the PDF buttons use, so it inherits their popup and download fallbacks.
 */
export function ShippingLabelButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const hasLabel = project.column === 'finish' && project.shipping_island !== null;

  // Same key as ShippingCard and the create drawer, so this shares their
  // cache — and only when a label can exist: a card with no shipping has no
  // island to name, so no reason to ask.
  const servicesQuery = useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    staleTime: 60 * 60_000,
    enabled: hasLabel,
  });
  const invoiceQuery = useAitoInvoice(project, hasLabel);
  const reference = invoiceQuery.data?.number || project.quote_number || null;

  const { print, busy } = usePrintBlob({
    failureMessage: t('aito.shippingLabelPrintFailed'),
    downloadFilename: `etiquette${reference ? `-${reference}` : ''}.html`,
  });

  if (!hasLabel) return null;

  const printLabel = () =>
    print(() => {
      const label = shippingLabelFor(project, servicesQuery.data?.services ?? [], reference);
      // Cannot be null past the render gate above; the throw lands on the
      // hook's failure toast rather than a silent no-op if that ever drifts.
      if (!label) throw new Error('no shipping label for this project');
      // The document lives at a blob: URL with no base, so the logo — a
      // root-relative asset path from Vite — must be made absolute first.
      const logoUrl = new URL(aito3dLogo, window.location.href).href;
      return new Blob([buildShippingLabelHtml(label, logoUrl)], { type: 'text/html' });
    });

  const label = t('aito.printShippingLabel');
  return (
    <button type="button" onClick={printLabel} disabled={busy} aria-label={label} title={label} className={SHIPPING_HEADER_CELL}>
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
    </button>
  );
}
