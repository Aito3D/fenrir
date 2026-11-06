import { useTranslation } from 'react-i18next';
import { Check, Loader2, PackagePlus, Printer } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { usePrintBlob } from '../aito/usePrintBlob';
import { useOrderActions } from './useOrderActions';

/** Local HH:mm of an ISO timestamp. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Right side of the "À préparer" band: who printed the sheet, the print button, and the way into the parcel check. */
export function OrderPrepActions({ row, onCreate }: { row: OrderPanelRow; onCreate: () => void }) {
  const { t } = useTranslation();
  const { canUpdate, printSheet } = useOrderActions();
  const { print, busy } = usePrintBlob({ failureMessage: t('orders.prep.printFailed'), downloadFilename: `${row.number}-prep.pdf` });
  const printed = row.prep;
  return (
    <span className="ml-auto flex flex-wrap items-center gap-2">
      {printed && (
        <span className="inline-flex items-center gap-1 text-[11px] text-bambu-gray">
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-bambu-green" />
          {printed.by ? t('orders.prep.printed', { time: clock(printed.at), name: printed.by }) : t('orders.prep.printedNoName', { time: clock(printed.at) })}
        </span>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void print(printSheet(row.id))}
        className="inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-bambu-green hover:text-bambu-green disabled:opacity-50"
      >
        {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Printer aria-hidden="true" className="h-3.5 w-3.5" />}
        {t(printed ? 'orders.prep.reprint' : 'orders.prep.sheet')}
      </button>
      {canUpdate && (
        <button
          type="button"
          onClick={onCreate}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
            printed
              ? 'bg-bambu-green font-semibold text-black hover:bg-bambu-green-light'
              : 'border border-bambu-dark-tertiary bg-bambu-dark/60 text-white hover:border-bambu-green hover:text-bambu-green'
          }`}
        >
          <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" />
          {t('orders.parcel.create')}
        </button>
      )}
    </span>
  );
}
