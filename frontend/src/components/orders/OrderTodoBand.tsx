import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { formatQty } from './orderBoard';
import type { OrderCheck, OrderEdit } from './orderBoard';
import { TRASH, dash } from './orderLinesShared';
import { OrderEditBar } from './OrderEditBar';
import { OrderItemSearch } from './OrderItemSearch';
import { OrderPackBar } from './OrderPackBar';
import { OrderQtyStepper } from './OrderQtyStepper';

/** The rows under the "to prepare" band while the order is edited: added lines, the item search, the save bar. */
export function OrderTodoEditRows({
  row,
  edit,
  itemIds,
  saving,
  setEdit,
  onClose,
  onBusy,
  onSaved,
}: {
  row: OrderPanelRow;
  edit: OrderEdit;
  itemIds: Set<string>;
  saving: boolean;
  setEdit: (edit: OrderEdit) => void;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {edit.added.map(({ item, quantity }) => (
        <tr key={`add-${item.id}`} className="border-t border-bambu-dark-tertiary/60">
          <td className="border-l-2 border-bambu-green py-2 pl-4 pr-3">
            <div className="text-white">{item.name}</div>
            {item.sku && <div className="font-mono text-xs text-bambu-gray">{item.sku}</div>}
            <span className="mt-0.5 inline-block rounded bg-bambu-green/15 px-1.5 py-0.5 text-[10px] text-bambu-green">
              {t('orders.edit.newLine', { price: formatMoney(item.rate, row.currency) })}
            </span>
          </td>
          <td className="whitespace-nowrap text-right tabular-nums text-white">
            <OrderQtyStepper
              id={`add-${item.id}`}
              name={item.name}
              label={t('orders.edit.ordered')}
              value={quantity}
              positive
              checkbox={false}
              disabled={saving}
              onChange={v => setEdit({ ...edit, added: edit.added.map(a => (a.item.id === item.id ? { ...a, quantity: v } : a)) })}
            />
          </td>
          <td className="text-right tabular-nums text-white">{item.stock_on_hand !== null ? formatQty(item.stock_on_hand) : dash}</td>
          <td className="text-right">{dash}</td>
          <td className="pl-4">
            <button
              type="button"
              aria-label={`${t('orders.edit.remove')} · ${item.name}`}
              title={t('orders.edit.remove')}
              disabled={saving}
              onClick={() => setEdit({ ...edit, added: edit.added.filter(a => a.item.id !== item.id) })}
              className={TRASH}
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </td>
        </tr>
      ))}
      <tr className="border-t border-bambu-dark-tertiary/60">
        <td colSpan={5} className="py-2 pl-4">
          <OrderItemSearch
            orderItemIds={itemIds}
            currency={row.currency}
            disabled={saving}
            onAdd={item => setEdit({ ...edit, added: [...edit.added, { item, quantity: 1 }] })}
          />
        </td>
      </tr>
      <tr>
        <td colSpan={5} className="pt-2 animate-rise-sm">
          <OrderEditBar row={row} edit={edit} onClose={onClose} onBusy={onBusy} onSaved={onSaved} />
        </td>
      </tr>
    </>
  );
}

/** The row under the "to prepare" band while a pick / pack check is open. */
export function OrderTodoCheckRow({
  row,
  check,
  onClose,
  onBusy,
  onPicked,
}: {
  row: OrderPanelRow;
  check: OrderCheck;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  onPicked: React.ComponentProps<typeof OrderPackBar>['onPicked'];
}) {
  return (
    <tr>
      <td colSpan={5} className="pt-2 animate-rise-sm">
        <OrderPackBar row={row} check={check} onClose={onClose} onBusy={onBusy} onPicked={onPicked} />
      </td>
    </tr>
  );
}
