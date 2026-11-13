import { useTranslation } from 'react-i18next';
import { Check, Package, Trash2, Undo2 } from 'lucide-react';
import type { OrderBoardLine } from '../../api/client';
import { formatQty } from './orderBoard';
import type { OrderCheck, OrderEdit, PanelGroup } from './orderBoard';
import { TONE } from './orderStatus';
import { GROUP, LINE_STATE, TRASH, dash } from './orderLinesShared';
import { OrderQtyStepper } from './OrderQtyStepper';

/** One product row of a band: read-only, or carrying the stepper / trash of an open edit or pick check. */
export function OrderLineRow({
  groupId,
  line,
  qty,
  ofQty,
  index,
  edit,
  check,
  checkLabel,
  saving,
  pending,
  editQty,
  setGone,
  setCheck,
}: {
  groupId: PanelGroup['id'];
  line: OrderBoardLine;
  qty: number;
  ofQty: number | null;
  index: number;
  edit: OrderEdit | null;
  check: OrderCheck | null;
  checkLabel: string | null;
  saving: boolean;
  pending: boolean;
  editQty: (id: string, v: number) => void;
  setGone: (id: string, gone: boolean) => void;
  setCheck: (check: OrderCheck) => void;
}) {
  const { t } = useTranslation();
  const meta = GROUP[groupId];
  const todo = groupId === 'todo';
  const short = todo && (line.state === 'backorder' || line.state === 'to_order');
  const editing = todo && edit;
  const gone = !!edit && todo && edit.gone.has(line.id);
  return (
    <tr className={`transition-opacity duration-150 ease-out ${index ? 'border-t border-bambu-dark-tertiary/60' : ''} ${(todo && check && !(check.max[line.id] > 0)) || gone ? 'opacity-40' : ''}`}>
      <td className={`border-l-2 py-2 pl-4 pr-3 ${TONE[meta.tone].rail} ${gone ? 'line-through' : ''}`}>
        <div className="text-white">{line.name}</div>
        {line.sku && <div className="font-mono text-xs text-bambu-gray">{line.sku}</div>}
      </td>
      <td className="whitespace-nowrap text-right tabular-nums text-white">
        {editing && gone ? (
          <span className="line-through">{formatQty(line.quantity)}</span>
        ) : editing ? (
          <>
            <OrderQtyStepper
              id={line.id}
              name={line.name}
              label={t('orders.edit.ordered')}
              value={edit.qty[line.id] ?? line.quantity}
              min={line.floor}
              positive // removing a line is the trash's job, never a 0
              checkbox={false}
              disabled={saving}
              onChange={v => editQty(line.id, v)}
            />
            {line.floor > 0 && (
              <span title={t('orders.edit.cannotRemove')} className="ml-1.5 text-[10px] text-bambu-gray">{t('orders.edit.min', { n: formatQty(line.floor) })}</span>
            )}
          </>
        ) : todo && check && checkLabel && check.max[line.id] > 0 ? (
          <OrderQtyStepper
            id={line.id}
            name={line.name}
            label={t(checkLabel)}
            value={Math.min(check.qty[line.id] ?? 0, check.max[line.id])}
            max={check.max[line.id]}
            disabled={pending}
            onChange={v => setCheck({ ...check, qty: { ...check.qty, [line.id]: v } })}
          />
        ) : (
          formatQty(qty)
        )}
        {ofQty !== null && !editing && <span className="ml-1 text-xs text-bambu-gray">{t('orders.ofOrdered', { n: formatQty(ofQty) })}</span>}
        {todo && line.invoiced > 0 && (
          <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] ${TONE.info.soft} ${TONE.info.text}`}>{t('orders.line.invoiced')}</span>
        )}
      </td>
      <td className={`text-right tabular-nums ${todo && line.state === 'ready' ? TONE.success.text : 'text-white'}`}>
        {todo && line.stock_available !== null ? formatQty(line.stock_available) : dash}
      </td>
      <td className={`text-right tabular-nums ${short ? LINE_STATE[line.state].cls : ''}`}>
        {short ? <>−{formatQty(line.shortfall)}</> : dash}
      </td>
      {editing ? (
        <td className="whitespace-nowrap pl-4">
          {gone ? (
            <button type="button" disabled={saving} onClick={() => setGone(line.id, false)} className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-white disabled:opacity-50">
              <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
              {t('orders.edit.restore')}
            </button>
          ) : (
            <button
              type="button"
              aria-label={`${t('orders.edit.remove')} · ${line.name}`}
              title={t(line.floor > 0 ? 'orders.edit.cannotRemove' : 'orders.edit.remove')}
              disabled={saving || line.floor > 0}
              onClick={() => setGone(line.id, true)}
              className={TRASH}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          )}
        </td>
      ) : (
      <td className="whitespace-nowrap pl-4">
        {groupId === 'packed' && (
          <span className={`inline-flex items-center gap-1 ${TONE.info.text}`}>
            <Package aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.line.packed')}
          </span>
        )}
        {groupId === 'shipped' && (
          <span className="inline-flex items-center gap-1 text-bambu-gray">
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.line.shipped')}
          </span>
        )}
        {(todo || groupId === 'other') && <span className={LINE_STATE[line.state].cls}>{t(LINE_STATE[line.state].label)}</span>}
        {todo && line.covered_by_po > 0 && (
          <span className="ml-1.5 text-xs text-bambu-gray">
            {line.po_numbers.join(', ')} · +{formatQty(line.covered_by_po)}
          </span>
        )}
      </td>
      )}
    </tr>
  );
}
