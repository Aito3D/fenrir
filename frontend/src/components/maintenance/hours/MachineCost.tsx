import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HourMachine } from '../../../api/client';
import { dayNumber } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { inputCls } from '../../formStyles';

interface MachineCostProps {
  machine: HourMachine;
  /** Last manual reading: lifetime hours and its date. */
  lifetime: { hours: number; date: string } | null;
  currency: string;
  canEdit: boolean;
  onSave: (body: { purchase_price: number | null; purchase_date: string | null }) => void;
}

/** Purchase price and date, and the cost per lifetime hour they imply. */
export function MachineCost({ machine, lifetime, currency, canEdit, onSave }: MachineCostProps) {
  const { t, i18n } = useTranslation();
  const [price, setPrice] = useState(machine.purchase_price != null ? String(machine.purchase_price) : '');
  const [date, setDate] = useState(machine.purchase_date ?? '');
  const dayFmt = new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' });

  const priceNum = price.trim() === '' ? null : Number(price);
  const valid = priceNum === null || (Number.isFinite(priceNum) && priceNum >= 0);
  const hours = lifetime?.hours ?? 0;
  const shownPrice = machine.purchase_price;
  const amount = shownPrice != null && hours > 0
    ? new Intl.NumberFormat(i18n.language, { style: 'currency', currency, maximumFractionDigits: 0 }).format(shownPrice / hours)
    : null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-white">{t('maintenance.hours.cost.title')}</h3>
      {canEdit && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onSave({ purchase_price: priceNum, purchase_date: date || null });
          }}
        >
          <input
            type="number"
            min={0}
            step={1}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            aria-label={t('maintenance.hours.cost.price')}
            className={`${inputCls} !w-32`}
          />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label={t('maintenance.hours.cost.date')}
            className={`${inputCls} !w-auto`}
          />
          <Button type="submit" size="sm" disabled={!valid}>{t('maintenance.hours.cost.save')}</Button>
        </form>
      )}
      {amount && (
        <p className="text-sm text-white">
          {t('maintenance.hours.cost.perHour', { amount })}
          {machine.trust === 'uncalibrated' && lifetime && (
            <span className="ml-2 text-xs text-bambu-gray">
              {t('maintenance.hours.cost.basedOn', { date: dayFmt.format(dayNumber(lifetime.date) * 86_400_000) })}
            </span>
          )}
        </p>
      )}
      <p className="text-xs text-bambu-gray">{t('maintenance.hours.cost.noRevenue')}</p>
    </section>
  );
}
