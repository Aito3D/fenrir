import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { HourMachine, HourReading } from '../../../api/client';
import { checkReading, familyOf, parseHoursInput } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { readingCheckText } from './readingCheckText';

interface ReadingPassProps {
  machines: HourMachine[];
  readings: HourReading[];
  today: string;
  colors: Map<number, string>;
  isSaving: boolean;
  onSave: (entries: { machine_id: number; hours: number }[]) => void;
  onClose: () => void;
}

export function ReadingPass({ machines, readings, colors, isSaving, onSave, onClose }: ReadingPassProps) {
  const { t, i18n } = useTranslation();
  const n = machines.length;
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<number, string>>({});
  const [kept, setKept] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const { fmt, fmtDate, questionText, resultLine } = readingCheckText(t, i18n.language);

  useEffect(() => {
    if (index < n) inputRef.current?.focus();
    else rootRef.current?.focus();
  }, [index, n]);

  const parsedOf = (m: HourMachine) => parseHoursInput(values[m.id] ?? '');
  const checkOf = (m: HourMachine, typed: number) => checkReading(m.id, typed, readings, m.counter_raw_hours);

  const setValue = (m: HourMachine, text: string) => {
    setValues((v) => ({ ...v, [m.id]: text }));
    setKept((k) => {
      if (!k.has(m.id)) return k;
      const next = new Set(k);
      next.delete(m.id);
      return next;
    });
  };

  const entries = machines.flatMap((m) => {
    const p = parsedOf(m);
    return typeof p === 'number' ? [{ machine_id: m.id, hours: p }] : [];
  });

  const onRootKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };

  const titleId = 'reading-pass-title';
  const chrome = (
    <>
      <div className="flex items-center justify-between px-4 pt-4">
        <span id={titleId} className="text-xs uppercase tracking-wide text-bambu-gray">{t('maintenance.hours.pass.title')}</span>
        <button type="button" aria-label={t('common.close')} onClick={onClose} className="rounded-lg p-2 text-bambu-gray hover:text-white">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="mx-4 h-1 bg-bambu-dark-tertiary">
        <div className="h-1 bg-bambu-green" style={{ width: `${n === 0 ? 100 : (index / n) * 100}%` }} />
      </div>
    </>
  );

  let body;
  if (index < n) {
    const m = machines[index];
    const ref = checkOf(m, 0);
    const parsed = parsedOf(m);
    const invalid = parsed === undefined;
    const check = typeof parsed === 'number' ? checkOf(m, parsed) : null;
    const needsKeep = check?.level === 'question' && !kept.has(m.id);

    const go = () => {
      if (invalid) return;
      if (needsKeep) setKept((k) => new Set(k).add(m.id));
      setIndex(index + 1);
    };
    const skip = () => {
      setValue(m, '');
      setIndex(index + 1);
    };

    let result: { text: string; amber: boolean } | null = null;
    if (invalid) result = { text: t('maintenance.hours.pass.invalid'), amber: true };
    else if (check && typeof parsed === 'number') result = resultLine(check, parsed);

    body = (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <div className="text-sm text-bambu-gray">{t('maintenance.hours.pass.progress', { i: index + 1, n })}</div>
        <div>
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: colors.get(m.id) }} />
            <h2 className="text-2xl font-semibold text-white">{m.name}</h2>
          </div>
          <div className="text-sm text-bambu-gray">{familyOf(m) === 'OTHER' ? '—' : familyOf(m)}</div>
        </div>
        <div className="text-sm text-bambu-gray">
          <div>
            {ref.last
              ? t('maintenance.hours.pass.last', { hours: fmt(ref.last.hours), date: fmtDate(ref.last.date) })
              : t('maintenance.hours.pass.noLast')}
          </div>
          <div>
            {ref.last && ref.counterDelta !== null
              ? t('maintenance.hours.pass.counted', { hours: fmt(ref.counterDelta), date: fmtDate(ref.last.date) })
              : t('maintenance.hours.pass.noReference')}
          </div>
        </div>
        <input
          ref={inputRef}
          key={m.id}
          inputMode="decimal"
          autoFocus
          aria-label={m.name}
          className="w-full rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-4 text-right text-3xl tabular-nums text-white"
          value={values[m.id] ?? ''}
          onChange={(e) => setValue(m, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              go();
            }
          }}
        />
        <div className={`min-h-[2.5rem] text-sm ${result?.amber ? 'text-amber-400' : 'text-bambu-gray'}`}>{result?.text}</div>
        <div className="mt-auto flex gap-2">
          <Button variant="secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>{t('maintenance.hours.pass.back')}</Button>
          <Button variant="secondary" onClick={skip}>{t('maintenance.hours.pass.skip')}</Button>
          <Button className="ml-auto" disabled={invalid} onClick={go}>
            {needsKeep ? t('maintenance.hours.pass.keepAnyway') : t('maintenance.hours.pass.next')}
          </Button>
        </div>
      </div>
    );
  } else {
    const rows = machines.flatMap((m) => {
      const p = parsedOf(m);
      if (typeof p !== 'number') return [];
      const c = checkOf(m, p);
      return [{ m, typed: p, last: c.last, kept: kept.has(m.id), reason: questionText(c, p) }];
    });
    body = (
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 py-6">
        <h2 className="text-2xl font-semibold text-white">{t('maintenance.hours.pass.summary')}</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('maintenance.hours.pass.nothingToSave')}</p>
        ) : (
          <table className="w-full text-sm text-white">
            <tbody>
              {rows.map(({ m, typed, last, kept: isKept, reason }) => (
                <tr key={m.id} data-testid="pass-summary-row" className="border-b border-bambu-dark-tertiary align-top">
                  <td className="py-2 pr-2 font-medium">{m.name}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-bambu-gray">{last ? fmt(last.hours) : '—'}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{fmt(typed)}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-bambu-gray">{last ? `${typed < last.hours ? '−' : '+'}${fmt(Math.abs(typed - last.hours))} h` : '—'}</td>
                  <td className="py-2 text-xs text-amber-400">
                    {isKept && <div className="font-medium">{t('maintenance.hours.pass.kept')}</div>}
                    {reason && <div>{reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-auto flex gap-2">
          <Button variant="secondary" onClick={() => setIndex(n - 1)} disabled={n === 0}>{t('maintenance.hours.pass.back')}</Button>
          <Button className="ml-auto" disabled={entries.length === 0 || isSaving} onClick={() => onSave(entries)}>
            {t('maintenance.hours.pass.save', { n: entries.length })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="hours-reading-pass"
      onKeyDown={onRootKey}
      className="fixed inset-0 z-50 flex h-[100dvh] flex-col overflow-auto bg-bambu-dark outline-none"
    >
      {chrome}
      {body}
    </div>
  );
}
