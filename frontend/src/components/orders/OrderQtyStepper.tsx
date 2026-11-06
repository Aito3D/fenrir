import { useTranslation } from 'react-i18next';
import { Minus, Plus } from 'lucide-react';
import { NumberInput } from '../NumberInput';
import { formatQty } from './orderBoard';

const BTN = 'grid h-6 w-6 place-items-center rounded border border-bambu-dark-tertiary text-bambu-gray hover:text-white disabled:opacity-40';

/** One line of a check: a tick to take the line or leave it, and its units, typed or one a click, kept inside 0..max. */
export function OrderQtyStepper({ id, name, label, value, max, disabled, onChange }: { id: string; name: string; label: string; value: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  const { t } = useTranslation();
  const set = (v: number) => onChange(Math.round(Math.min(max, Math.max(0, v)) * 100) / 100);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="checkbox"
        aria-label={`${label} · ${name}`}
        checked={value > 0}
        disabled={disabled}
        onChange={e => onChange(e.target.checked ? max : 0)}
        className="mr-1 h-4 w-4 accent-bambu-green"
      />
      <button type="button" aria-label={`${t('orders.parcel.less')} · ${name}`} disabled={disabled} onClick={() => set(value - 1)} className={BTN}>
        <Minus aria-hidden="true" className="h-3 w-3" />
      </button>
      <NumberInput
        data-testid={`pack-qty-${id}`}
        aria-label={`${t('orders.col.qty')} · ${name}`}
        value={value}
        onChange={set}
        min={0}
        max={max}
        integer={false}
        step="any"
        disabled={disabled}
        className={`h-6 w-12 rounded border border-bambu-dark-tertiary bg-bambu-dark px-1 text-center text-sm font-semibold tabular-nums [appearance:textfield] focus:border-bambu-green focus:outline-none disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${value <= 0 ? 'text-bambu-gray' : value < max ? 'text-yellow-400' : 'text-white'}`}
      />
      <button type="button" aria-label={`${t('orders.parcel.more')} · ${name}`} disabled={disabled} onClick={() => set(value + 1)} className={BTN}>
        <Plus aria-hidden="true" className="h-3 w-3" />
      </button>
      <span className="text-xs text-bambu-gray">/ {formatQty(max)}</span>
    </span>
  );
}
