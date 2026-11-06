import { useTranslation } from 'react-i18next';
import { Check, HandHelping, Loader2, Printer } from 'lucide-react';
import type { OrderBoardRow } from '../../api/client';
import { usePrintBlob } from '../aito/usePrintBlob';
import { useOrderActions } from './useOrderActions';

const ICON = 'absolute grid h-7 w-7 place-items-center rounded-md text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green disabled:opacity-50';
/** Bottom right on the phone, before the chevron on desktop. */
export const ROW_ACTION_POS = 'bottom-2.5 right-4 lg:bottom-auto lg:right-[2.75rem] lg:top-1/2 lg:-translate-y-1/2';

/** The next step of an order as one icon next to its row: print the sheet, or go and hand a parcel over. */
export function OrderRowAction({ row, step, onHandover }: { row: OrderBoardRow; step: 'print' | 'handover'; onHandover?: (packageId: string) => void }) {
  const { t } = useTranslation();
  const { printSheet } = useOrderActions();
  const { print, busy } = usePrintBlob({ failureMessage: t('orders.prep.printFailed'), downloadFilename: `${row.number}-prep.pdf` });
  if (step === 'handover') {
    const pkg = row.packages.find(p => p.status === 'not_shipped');
    return (
      <button type="button" title={t('orders.handover.open')} aria-label={t('orders.handover.open')} onClick={() => pkg && onHandover?.(pkg.id)} className={`${ICON} ${ROW_ACTION_POS}`}>
        <HandHelping aria-hidden="true" className="h-4 w-4" />
      </button>
    );
  }
  return (
    <button type="button" title={t('orders.prep.sheet')} aria-label={t('orders.prep.sheet')} disabled={busy} onClick={() => void print(printSheet(row.id))} className={`${ICON} ${ROW_ACTION_POS}`}>
      {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Printer aria-hidden="true" className="h-4 w-4" />}
      {row.prep && (
        <span data-testid="row-printed" className="absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-bambu-green text-black">
          <Check aria-hidden="true" className="h-2 w-2" strokeWidth={4} />
        </span>
      )}
    </button>
  );
}
