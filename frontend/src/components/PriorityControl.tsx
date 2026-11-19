import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from './formStyles';
import { formatMoney, type PriorityLevel } from '../utils/pricing';

const LEVELS: PriorityLevel[] = ['normal', 'priority', 'urgent'];

const CHECKED_CLS: Record<PriorityLevel, string> = {
  normal: 'bg-bambu-dark-tertiary text-white',
  priority: 'bg-amber-500/25 text-amber-300',
  urgent: 'bg-red-500/25 text-red-300',
};

const CHIP_CLS: Record<PriorityLevel, string> = {
  normal: 'bg-bambu-dark-tertiary text-white',
  priority: 'bg-amber-500/15 text-amber-300',
  urgent: 'bg-red-500/15 text-red-300',
};

/** Normal / Priority / Urgent segmented control with the surcharge chip. */
export function PriorityControl({
  value,
  onChange,
  surcharge,
  currency,
  hint,
}: {
  value: PriorityLevel;
  onChange: (v: PriorityLevel) => void;
  surcharge: number;
  currency: string;
  hint?: string;
}) {
  const { t } = useTranslation();
  const refs = useRef<Partial<Record<PriorityLevel, HTMLButtonElement | null>>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = LEVELS[(LEVELS.indexOf(value) + step + LEVELS.length) % LEVELS.length];
    onChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label={t('calculator.priority.label')}
          onKeyDown={onKeyDown}
          className="inline-flex gap-0.5 rounded-[10px] border border-bambu-dark-tertiary bg-bambu-dark p-[3px]"
        >
          {LEVELS.map((level) => {
            const checked = value === level;
            return (
              <button
                key={level}
                ref={(el) => {
                  refs.current[level] = el;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => onChange(level)}
                className={`min-w-[5rem] rounded-[7px] px-3 py-1.5 text-sm font-medium transition-colors ${focusRingCls} ${
                  checked ? CHECKED_CLS[level] : 'text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                }`}
              >
                {t(`calculator.priority.${level}`)}
              </button>
            );
          })}
        </div>
        {surcharge > 0 && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${CHIP_CLS[value]}`}>
            +{formatMoney(surcharge, currency)}
          </span>
        )}
      </div>
      {hint && <p className="mt-1.5 text-xs text-bambu-gray">{hint}</p>}
    </div>
  );
}
