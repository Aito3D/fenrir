import { useTranslation } from 'react-i18next';
import { HandHelping, Loader2, Pencil } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { waitingPackages } from './orderBoard';
import type { ParcelEdit } from './orderBoard';
import { FIT_VIEWPORT } from './orderStatus';
import { EDIT_BTN } from './orderLinesShared';
import { OrderHandoverBar } from './OrderHandoverBar';
import { OrderParcelEditBar } from './OrderParcelEditBar';

/** The "packed" band's header buttons: edit a waiting parcel, or hand it over. */
export function OrderPackedActions({
  row,
  showEdit,
  opening,
  onOpenParcel,
  onHandover,
}: {
  row: OrderPanelRow;
  /** False while a pick / pack check is open. */
  showEdit: boolean;
  opening: string | null;
  onOpenParcel: (packageId: string) => void;
  onHandover: (packageId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <span className={`flex basis-full flex-wrap items-center gap-2 lg:ml-auto lg:basis-auto ${FIT_VIEWPORT}`}>
      {waitingPackages(row).map((p, _i, all) => (
        <span key={p.id} className="contents">
        {showEdit && (
          <button
            type="button"
            data-opens={`parcel-${p.id}`}
            disabled={opening !== null}
            onClick={() => onOpenParcel(p.id)}
            className={EDIT_BTN}
          >
            {opening === `parcel-${p.id}` ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Pencil aria-hidden="true" className="h-3.5 w-3.5" />}
            {all.length > 1 ? t('orders.parcelEdit.openNumber', { number: p.number }) : t('orders.parcelEdit.open')}
          </button>
        )}
        <button
          type="button"
          data-opens={`handover-${p.id}`}
          onClick={() => onHandover(p.id)}
          className="btn-press inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-blue-400 hover:text-blue-400"
        >
          <HandHelping aria-hidden="true" className="h-3.5 w-3.5" />
          {all.length > 1 ? t('orders.handover.openNumber', { number: p.number }) : t('orders.handover.open')}
        </button>
        </span>
      ))}
    </span>
  );
}

/** The bars under the "packed" band: the open parcel edit, the open hand-over. */
export function OrderPackedBars({
  row,
  parcel,
  handover,
  onParcelClose,
  onParcelBusy,
  onParcelSaved,
  onHandoverClose,
}: {
  row: OrderPanelRow;
  parcel: ParcelEdit | null;
  /** The package id of the open hand-over bar, already known to still be waiting. */
  handover: string | null;
  onParcelClose: () => void;
  onParcelBusy: (busy: boolean) => void;
  onParcelSaved: () => void;
  onHandoverClose: () => void;
}) {
  return (
    <>
      {parcel && (
        <tr>
          <td colSpan={5} className="pt-2 animate-rise-sm">
            <OrderParcelEditBar row={row} parcel={parcel} onClose={onParcelClose} onBusy={onParcelBusy} onSaved={onParcelSaved} />
          </td>
        </tr>
      )}
      {handover && (
        <tr>
          <td colSpan={5} className="pt-2 animate-rise-sm">
            <OrderHandoverBar key={handover} row={row} packageId={handover} onClose={onHandoverClose} />
          </td>
        </tr>
      )}
    </>
  );
}
