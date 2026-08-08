import { useTranslation } from 'react-i18next';
import { splitMinutes, joinMinutes } from '../../utils/taskDraft';
import { inputCls } from '../formStyles';

export interface DurationInputProps {
  minutes: number | null;
  onChange: (minutes: number | null) => void;
  id?: string;
}

/** Days / hours / minutes in, one integer of minutes out. The split is a UI
 *  concern only — storing three columns would invite "90 minutes" and "1h30"
 *  disagreeing. */
const UNIT_KEYS = {
  days: 'calculator.durationDaysShort',
  hours: 'calculator.durationHoursShort',
  minutes: 'calculator.durationMinutesShort',
} as const;

export function DurationInput({ minutes, onChange, id }: DurationInputProps) {
  const { t } = useTranslation();
  const parts = splitMinutes(minutes ?? 0);

  const set = (key: 'days' | 'hours' | 'minutes', raw: string) => {
    const next = { ...parts, [key]: raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0)) };
    const total = joinMinutes(next);
    // All-empty means "not set", which keeps the service disabled rather than
    // pinning it to zero minutes.
    onChange(raw === '' && total === 0 ? null : total);
  };

  return (
    <div className="flex items-center gap-2">
      {(['days', 'hours', 'minutes'] as const).map((key, index) => (
        <div key={key} className="flex items-center gap-1">
          <input
            id={index === 0 ? id : undefined}
            type="number"
            min={0}
            inputMode="numeric"
            value={minutes === null ? '' : parts[key]}
            onChange={(e) => set(key, e.target.value)}
            className={`${inputCls} text-right`}
          />
          {/* Reuses the calculator's existing per-locale duration suffixes
              rather than duplicating them under aito.* — they are already
              translated in all 12 files and already used for this exact
              purpose by CalculatorInputsCard. */}
          <span className="text-xs text-bambu-gray">{t(UNIT_KEYS[key])}</span>
        </div>
      ))}
    </div>
  );
}
