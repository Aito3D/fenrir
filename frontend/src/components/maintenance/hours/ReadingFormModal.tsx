import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HourMachine, HourReading } from '../../../api/client';
import { parseHoursInput } from '../../../utils/hoursSeries';
import { Button } from '../../Button';

interface ReadingFormModalProps {
  initialDate: string;
  today: string;
  machines: HourMachine[];
  readings: HourReading[];
  colors: Map<number, string>;
  isSaving: boolean;
  onSave: (date: string, entries: { machine_id: number; hours: number | null }[]) => void;
  onClose: () => void;
}

export function ReadingFormModal({
  initialDate, today, machines, readings, colors, isSaving, onSave, onClose,
}: ReadingFormModalProps) {
  const { t, i18n } = useTranslation();
  const active = useMemo(
    () => machines.filter((m) => !m.retired).sort((a, b) => a.name.localeCompare(b.name)),
    [machines],
  );
  const manualOn = (date: string) =>
    new Map(readings.filter((r) => r.source === 'manual' && r.reading_date === date).map((r) => [r.machine_id, r.hours]));
  const prefill = (date: string) => {
    const existing = manualOn(date);
    return Object.fromEntries(active.map((m) => [m.id, existing.has(m.id) ? String(existing.get(m.id)) : '']));
  };
  const [date, setDate] = useState(initialDate);
  const [values, setValues] = useState<Record<number, string>>(() => prefill(initialDate));
  const isEdit = manualOn(initialDate).size > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const previous = (machineId: number) =>
    readings
      .filter((r) => r.machine_id === machineId && r.source === 'manual' && r.reading_date < date)
      .sort((a, b) => b.reading_date.localeCompare(a.reading_date))[0];

  const existing = manualOn(date);
  let invalid = false;
  const entries: { machine_id: number; hours: number | null }[] = [];
  for (const m of active) {
    const parsed = parseHoursInput(values[m.id] ?? '');
    if (parsed === undefined) invalid = true;
    else if (parsed === null) {
      if (existing.has(m.id)) entries.push({ machine_id: m.id, hours: null });
    } else if (existing.get(m.id) !== parsed) entries.push({ machine_id: m.id, hours: parsed });
  }
  const fmt = (n: number) => Math.round(n).toLocaleString(i18n.language);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-overlay-in" onClick={onClose}>
      <div
        data-testid="hours-reading-form"
        role="dialog"
        aria-modal="true"
        className="max-h-[88vh] w-[min(720px,94vw)] overflow-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white">
          {isEdit ? t('maintenance.hours.form.editTitle') : t('maintenance.hours.form.title')}
        </h2>
        <p className="mt-1 text-sm text-bambu-gray">{t('maintenance.hours.form.hint')}</p>
        <label className="mt-4 flex items-center gap-3 text-sm text-bambu-gray-light">
          {t('maintenance.hours.form.date')}
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => {
              if (!e.target.value) return;
              setDate(e.target.value);
              setValues(prefill(e.target.value));
            }}
            className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-white"
          />
        </label>
        <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          {active.map((m) => {
            const raw = values[m.id] ?? '';
            const parsed = parseHoursInput(raw);
            const prev = previous(m.id);
            const lower = typeof parsed === 'number' && prev !== undefined && parsed < prev.hours;
            return (
              <div key={m.id} className="flex flex-col">
                <label className="flex items-center gap-2 text-sm">
                  <span className="flex w-24 items-center gap-1.5 text-bambu-gray-light">
                    <span className="h-2 w-2 rounded-full" style={{ background: colors.get(m.id) }} />
                    {m.name}
                  </span>
                  <input
                    name={m.name}
                    aria-label={m.name}
                    inputMode="decimal"
                    value={raw}
                    placeholder={date === today && m.current_hours != null ? fmt(m.current_hours) : ''}
                    onChange={(e) => setValues((v) => ({ ...v, [m.id]: e.target.value }))}
                    className={`w-full rounded-lg border bg-bambu-dark px-2 py-1.5 text-right tabular-nums text-white placeholder:text-bambu-gray-dark ${parsed === undefined ? 'border-red-500' : lower ? 'border-amber-500' : 'border-bambu-dark-tertiary'}`}
                  />
                </label>
                {parsed === undefined && <span className="pl-24 text-xs text-red-400">{t('maintenance.hours.form.invalid')}</span>}
                {lower && prev && (
                  <span className="pl-24 text-xs text-amber-500">
                    {t('maintenance.hours.form.lowerThanPrevious', { hours: fmt(prev.hours) })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-4 rounded-lg bg-bambu-dark p-3 text-xs text-bambu-gray">
          {date === today ? t('maintenance.hours.form.recalibrateNote') : t('maintenance.hours.form.backdatedNote')}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={invalid || entries.length === 0 || isSaving} onClick={() => onSave(date, entries)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
