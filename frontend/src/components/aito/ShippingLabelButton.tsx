import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plane } from 'lucide-react';
import { api, type AitoProject } from '../../api/client';
import { buildShippingLabelHtml, shippingLabelFor } from '../../utils/shippingLabel';
import { focusRingCls } from '../formStyles';
import { usePrintBlob } from './usePrintBlob';
import aito3dLogo from '../../assets/aito3d_logo.png';

/** Print the parcel's shipping label — half an A4, recipient and island in
 *  large type, the shop as sender.
 *
 *  Lives in the Invoice card because that is where the operator already is
 *  when the parcel is being closed: the job is finished, the invoice is
 *  raised, the label is the last thing to print. It renders nothing unless
 *  the project is in Finish AND carries shipping (`shippingLabelFor` owns
 *  both gates), so on the overwhelming majority of cards — collected in
 *  person, or not yet finished — the card is exactly as it was.
 *
 *  A labelled full-width row rather than a fourth cell in the card's icon
 *  group: that group is sized to the panel's 230.4px column and reads as one
 *  object, and an action that only appears on shipped, finished jobs should
 *  say what it is the one time it shows up.
 *
 *  The document is built in the browser (`buildShippingLabelHtml`) — no
 *  endpoint, no Zoho — and printed through the same hidden-iframe machinery
 *  the PDF buttons use, so it inherits their popup and download fallbacks.
 */
export function ShippingLabelButton({
  project,
  /** The number of the invoice the card is showing, printed as the parcel's
   *  reference. Null when Books has not numbered it yet — the label then
   *  simply omits the row. */
  invoiceNumber,
}: {
  project: AitoProject;
  invoiceNumber: string | null;
}) {
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

  const { print, busy } = usePrintBlob({
    failureMessage: t('aito.shippingLabelPrintFailed'),
    downloadFilename: `etiquette${invoiceNumber ? `-${invoiceNumber}` : ''}.html`,
  });

  if (!hasLabel) return null;

  const printLabel = () =>
    print(() => {
      const label = shippingLabelFor(project, servicesQuery.data?.services ?? [], invoiceNumber);
      // Cannot be null past the render gate above; the throw lands on the
      // hook's failure toast rather than a silent no-op if that ever drifts.
      if (!label) throw new Error('no shipping label for this project');
      // The document lives at a blob: URL with no base, so the logo — a
      // root-relative asset path from Vite — must be made absolute first.
      const logoUrl = new URL(aito3dLogo, window.location.href).href;
      return new Blob([buildShippingLabelHtml(label, logoUrl)], { type: 'text/html' });
    });

  return (
    <button
      type="button"
      onClick={printLabel}
      disabled={busy}
      className={`mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary py-[.45rem] text-xs font-medium text-bambu-gray-light transition-colors motion-reduce:transition-none hover:bg-bambu-dark-tertiary hover:text-white disabled:opacity-40 disabled:cursor-not-allowed ${focusRingCls}`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plane className="h-3.5 w-3.5 text-sky-400" />}
      {t('aito.printShippingLabel')}
    </button>
  );
}
