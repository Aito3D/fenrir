import { useTranslation } from 'react-i18next';
import { Package, PackagePlus, Plus } from 'lucide-react';
import type { OrderBoardLine } from '../../api/client';
import { formatQty } from './orderBoard';
import type { ParcelEdit } from './orderBoard';
import { OrderQtyStepper } from './OrderQtyStepper';
import { TONE } from './orderStatus';

const dash = <td className="text-right"><span className="text-bambu-gray">–</span></td>;

const Tag = ({ d }: { d: number }) =>
  d ? <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] ${d > 0 ? 'bg-green-500/15 text-green-400' : 'bg-yellow-400/15 text-yellow-400'}`}>{d > 0 ? `+${formatQty(d)}` : `−${formatQty(-d)}`}</span> : null;

/** The packed group while a parcel is edited: its lines with a stepper from 0 to their ceiling, the lines of another
 *  parcel dimmed, then the "to prepare" lines the shelf covers as rows that can join the parcel. */
export function OrderParcelEditRows({
  lines, all, parcel, busy, onQty,
}: { lines: OrderBoardLine[]; all: OrderBoardLine[]; parcel: ParcelEdit; busy: boolean; onQty: (id: string, v: number) => void }) {
  const { t } = useTranslation();
  const stepper = (line: OrderBoardLine, label: string) => (
    <OrderQtyStepper id={line.id} name={line.name} label={label} value={Math.min(parcel.qty[line.id] ?? 0, parcel.max[line.id])}
      min={0} max={parcel.max[line.id]} checkbox={false} disabled={busy} onChange={v => onQty(line.id, v)} />
  );
  const product = (line: OrderBoardLine, caption: string | null) => (
    <>
      <div className="text-white">{line.name}</div>
      {line.sku && <div className="font-mono text-xs text-bambu-gray">{line.sku}</div>}
      {caption && <span className="text-[10px] text-bambu-gray">{caption}</span>}
    </>
  );
  const stock = (line: OrderBoardLine) => <td className="text-right tabular-nums text-white">{line.stock_available !== null ? formatQty(line.stock_available) : '–'}</td>;
  const adds = all.filter(l => l.id in parcel.max && !(l.id in parcel.was));
  return (
    <>
      {lines.map((line, index) => {
        const mine = line.id in parcel.was;
        const q = parcel.qty[line.id] ?? 0;
        const others = Math.round((line.packed_waiting - (parcel.was[line.id] ?? 0)) * 100) / 100;
        return (
          <tr key={line.id} className={`${index ? 'border-t border-bambu-dark-tertiary/60' : ''} ${mine ? '' : 'opacity-40'}`}>
            <td className={`border-l-2 py-2 pl-4 pr-3 ${TONE.info.rail}`}>{product(line, others > 0 ? t('orders.parcelEdit.otherParcel', { n: formatQty(others) }) : null)}</td>
            <td className="whitespace-nowrap text-right tabular-nums text-white">
              {mine ? <>{stepper(line, t('orders.parcelEdit.inParcel'))}<Tag d={Math.round((q - parcel.was[line.id]) * 100) / 100} /></> : formatQty(line.packed_waiting)}
            </td>
            {mine ? stock(line) : dash}
            {dash}
            <td className={`whitespace-nowrap pl-4 ${TONE.info.text}`}>
              <span className="inline-flex items-center gap-1">
                <Package aria-hidden="true" className="h-3.5 w-3.5" />
                {!mine ? t('orders.line.packed') : q > 0 ? t('orders.parcelEdit.inParcel') : <span className="text-yellow-400">{t('orders.parcelEdit.removedLine')}</span>}
              </span>
            </td>
          </tr>
        );
      })}
      {adds.map(line => {
        const q = parcel.qty[line.id] ?? 0;
        return (
          <tr key={`join-${line.id}`} className={`border-t border-bambu-dark-tertiary/60 ${q > 0 ? '' : 'opacity-70'}`}>
            <td className={`border-l-2 py-2 pl-4 pr-3 ${q > 0 ? TONE.info.rail : 'border-dashed border-bambu-dark-tertiary'}`}>
              {product(line, t('orders.parcelEdit.shelf', { n: formatQty(parcel.max[line.id]) }))}
            </td>
            <td className="whitespace-nowrap text-right tabular-nums text-white">{stepper(line, t('orders.parcelEdit.addRow'))}<Tag d={q} /></td>
            {stock(line)}
            {dash}
            <td className={`whitespace-nowrap pl-4 ${q > 0 ? TONE.info.text : 'text-bambu-gray'}`}>
              <span className="inline-flex items-center gap-1">
                {q > 0 ? <PackagePlus aria-hidden="true" className="h-3.5 w-3.5" /> : <Plus aria-hidden="true" className="h-3.5 w-3.5" />}
                {t(q > 0 ? 'orders.parcelEdit.addedLine' : 'orders.parcelEdit.addRow')}
              </span>
            </td>
          </tr>
        );
      })}
    </>
  );
}
