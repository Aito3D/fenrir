import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HourImportBody, HourMachine } from '../../../api/client';
import { parseSheetPaste, planImport, type ColumnChoice } from '../../../utils/hoursSeries';
import { Button } from '../../Button';

interface PasteImportModalProps {
  machines: HourMachine[];
  today: string;
  isImporting: boolean;
  onImport: (body: HourImportBody) => void;
  onClose: () => void;
}

export function PasteImportModal({ machines, today, isImporting, onImport, onClose }: PasteImportModalProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [choices, setChoices] = useState<Record<string, ColumnChoice>>({});
  const paste = useMemo(() => parseSheetPaste(text), [text]);
  const plan = useMemo(() => planImport(paste, machines, choices, today), [paste, machines, choices, today]);
  const placeholder = useMemo(
    () => ['Date', ...machines.slice(0, 3).map((m) => m.name)].join('\t') + '\n19/07/2024\t1470\t212\t491',
    [machines],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasText = text.trim() !== '';
  const noRows = hasText && paste.rows.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-overlay-in" onClick={onClose}>
      <div
        data-testid="hours-paste-import"
        role="dialog"
        aria-modal="true"
        className="max-h-[88vh] w-[min(760px,94vw)] overflow-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-white">{t('maintenance.hours.paste.title')}</h2>
        <p className="mt-1 text-sm text-bambu-gray">{t('maintenance.hours.paste.hint')}</p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="mt-3 h-36 w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-2 font-mono text-xs text-white"
        />
        {noRows && <p className="mt-2 text-sm text-amber-500">{t('maintenance.hours.paste.noRows')}</p>}
        {hasText && !noRows && (
          <>
            <p className="mt-3 text-sm text-white">
              {t('maintenance.hours.paste.summary', {
                dates: plan.dates,
                columns: plan.columns.filter((c) => c.action !== 'ignore').length,
                readings: plan.body.readings.length,
              })}
            </p>
            {plan.futureRows > 0 && (
              <p className="text-xs text-amber-500">{t('maintenance.hours.paste.futureRows', { n: plan.futureRows })}</p>
            )}
            <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {plan.columns.map((c) => (
                <div key={c.header} data-testid={`paste-column-${c.header}`} className="flex items-center gap-2 text-sm">
                  <span className="w-24 truncate text-white">{c.header}</span>
                  {c.action === 'match' ? (
                    <span className="text-bambu-green">{t('maintenance.hours.paste.matched')}</span>
                  ) : (
                    <select
                      aria-label={`${c.header} · ${t('maintenance.hours.paste.unmatched')}`}
                      value={c.action}
                      onChange={(e) => setChoices((prev) => ({ ...prev, [c.header]: e.target.value as ColumnChoice }))}
                      className="flex-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white"
                    >
                      <option value="create">{t('maintenance.hours.paste.createRetired')}</option>
                      <option value="ignore">{t('maintenance.hours.paste.ignore')}</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-3 rounded-lg bg-bambu-dark p-3 text-xs text-bambu-gray">{t('maintenance.hours.paste.replaceNote')}</p>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={plan.body.readings.length === 0 || isImporting} onClick={() => onImport(plan.body)}>
            {t('maintenance.hours.paste.import')}
          </Button>
        </div>
      </div>
    </div>
  );
}
