import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, Loader2, PackagePlus, Printer } from 'lucide-react';
import type { OrderPanelRow, OrderPicklist } from '../../api/client';
import { boxablePicklists, canPick } from './orderBoard';
import { FIT_VIEWPORT } from './orderStatus';
import { useOrderActions } from './useOrderActions';

/** Local HH:mm of an ISO timestamp. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

const QUIET = 'inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-bambu-green hover:text-bambu-green disabled:opacity-50';
const STRONG = 'inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-2.5 py-1 text-xs font-semibold text-black hover:bg-bambu-green-light disabled:opacity-50';

/** Right side of the "À préparer" band: who printed the sheet, each picklist with its sheet and the way into
 *  its parcel check, and the way into a new picklist. */
export function OrderPrepActions({
  row,
  opening,
  printing,
  onPick,
  onPack,
  onPrint,
  lead,
}: {
  row: OrderPanelRow;
  /** Shown first: the order's Edit button, or its lock while a picklist is open. */
  lead?: ReactNode;
  /** The check being loaded from Zoho: 'pick', or a picklist id. */
  opening: string | null;
  printing: boolean;
  onPick: () => void;
  onPack: (picklist: OrderPicklist) => void;
  onPrint: (picklist: OrderPicklist) => void;
}) {
  const { t } = useTranslation();
  const { canUpdate } = useOrderActions();
  const printed = row.prep;
  const spin = <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />;
  return (
    <span className={`flex basis-full flex-wrap items-center gap-2 lg:ml-auto lg:basis-auto ${FIT_VIEWPORT}`}>
      {lead}
      {printed && (
        <span className="inline-flex items-center gap-1 text-[11px] text-bambu-gray">
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-bambu-green" />
          {printed.by ? t('orders.prep.printed', { time: clock(printed.at), name: printed.by }) : t('orders.prep.printedNoName', { time: clock(printed.at) })}
        </span>
      )}
      {boxablePicklists(row).map(p => (
        <span key={p.id} className="inline-flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-bambu-dark-tertiary bg-bambu-dark/40 px-2 py-0.5 font-mono text-[10px] text-bambu-gray">{p.number}</span>
          <button type="button" disabled={printing} aria-label={`${t(printed ? 'orders.prep.reprint' : 'orders.prep.sheet')} · ${p.number}`} onClick={() => onPrint(p)} className={QUIET}>
            {printing ? spin : <Printer aria-hidden="true" className="h-3.5 w-3.5" />}
            {t(printed ? 'orders.prep.reprint' : 'orders.prep.sheet')}
          </button>
          {canUpdate && (
            <button type="button" data-opens={`pack-${p.id}`} disabled={opening !== null} aria-label={`${t('orders.parcel.create')} · ${p.number}`} onClick={() => onPack(p)} className={STRONG}>
              {opening === p.id ? spin : <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" />}
              {t('orders.parcel.create')}
            </button>
          )}
        </span>
      ))}
      {canUpdate && canPick(row) && (
        <button type="button" data-opens="pick" disabled={opening !== null} onClick={onPick} className={boxablePicklists(row).length ? QUIET : STRONG}>
          {opening === 'pick' ? spin : <ClipboardList aria-hidden="true" className="h-3.5 w-3.5" />}
          {t('orders.pick.open')}
        </button>
      )}
    </span>
  );
}
