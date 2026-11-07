import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, HandHelping, PackagePlus } from 'lucide-react';
import type { OrderBoardRow } from '../../api/client';
import { useHandOverPending } from './useOrderActions';

const ICON = 'absolute grid h-7 w-7 place-items-center rounded-md text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green disabled:opacity-50 transition-transform duration-100 ease-out active:scale-[0.94] disabled:active:scale-100';
/** Beside the payment pill on the phone (the card reserves that space), before the chevron on desktop. */
const ROW_ACTION_POS = 'bottom-2.5 right-4 lg:bottom-auto lg:right-[2.75rem] lg:top-1/2 lg:-translate-y-1/2';

const KIND = {
  pick: { icon: ClipboardList, label: 'orders.pick.open' },
  pack: { icon: PackagePlus, label: 'orders.parcel.create' },
  handover: { icon: HandHelping, label: 'orders.handover.open' },
};

/** The next step of an order as one icon next to its row: it opens the order on that step (`target`, from `nextStep`). */
export function OrderRowAction({ row, target, onStart }: { row: OrderBoardRow; target: string; onStart?: (target: string) => void }) {
  const { t } = useTranslation();
  const handingOver = useHandOverPending(row.id);
  const kind = target.split('-')[0] as keyof typeof KIND;
  const { icon: Icon, label } = KIND[kind];
  // The tick pops only when the sheet gets printed while the row is on screen, never on mount or after a filter.
  const [seenPrep, setSeenPrep] = useState(!!row.prep);
  const [pop, setPop] = useState(false);
  if (!!row.prep !== seenPrep) {
    setSeenPrep(!!row.prep);
    setPop(!!row.prep);
  }
  return (
    <button type="button" title={t(label)} aria-label={t(label)} disabled={handingOver} onClick={() => onStart?.(target)} className={`${ICON} ${ROW_ACTION_POS}`}>
      <Icon aria-hidden="true" className="h-4 w-4" />
      {kind === 'pack' && row.prep && (
        <span data-testid="row-printed" className={`${pop ? 'animate-slice-done ' : ''}absolute -right-0.5 -top-0.5 grid h-3 w-3 place-items-center rounded-full bg-bambu-green text-black`}>
          <Check aria-hidden="true" className="h-2 w-2" strokeWidth={4} />
        </span>
      )}
    </button>
  );
}
