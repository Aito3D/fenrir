import { useTranslation } from 'react-i18next';
import { Minus, Plus } from 'lucide-react';
import { formatQty } from './orderBoard';

const BTN = 'grid h-6 w-6 place-items-center rounded border border-bambu-dark-tertiary text-bambu-gray hover:text-white disabled:opacity-40';

/** − value + / max, one unit a click, kept inside 0..max. */
export function OrderQtyStepper({ id, name, value, max, disabled, onChange }: { id: string; name: string; value: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  const { t } = useTranslation();
  const step = (d: number) => onChange(Math.round(Math.min(max, Math.max(0, value + d)) * 100) / 100);
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" aria-label={`${t('orders.parcel.less')} · ${name}`} disabled={disabled} onClick={() => step(-1)} className={BTN}>
        <Minus aria-hidden="true" className="h-3 w-3" />
      </button>
      <span data-testid={`pack-qty-${id}`} className={`min-w-6 text-center font-semibold tabular-nums ${value < max ? 'text-yellow-400' : 'text-white'}`}>
        {formatQty(value)}
      </span>
      <button type="button" aria-label={`${t('orders.parcel.more')} · ${name}`} disabled={disabled} onClick={() => step(1)} className={BTN}>
        <Plus aria-hidden="true" className="h-3 w-3" />
      </button>
      <span className="text-xs text-bambu-gray">/ {formatQty(max)}</span>
    </span>
  );
}
