import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronDown } from 'lucide-react';
import { Button } from '../Button';
import { localDateKey } from '../../utils/date';
import { TIMEFRAME_PRESETS, type TimeframeState } from './timeframe';

/** The Stats page's timeframe dropdown — a preset list plus a custom
 *  from/to — shared with the Aito statistics view so both pages mean the
 *  same thing by "Last 30 Days". */
export function TimeframeSelector({
  timeframe,
  onChange,
}: {
  timeframe: TimeframeState;
  onChange: (next: TimeframeState | ((prev: TimeframeState) => TimeframeState)) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const today = localDateKey(new Date());

  return (
    <div className="relative">
      <Button variant="secondary" onClick={() => setOpen(!open)}>
        <Calendar className="w-4 h-4" />
        {t(`stats.timeframe.${timeframe.preset}`)}
        <ChevronDown className="w-3 h-3" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-64 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-xl z-20 p-2">
            {TIMEFRAME_PRESETS.map((preset) => (
              <button
                key={preset}
                className={`w-full px-3 py-2 text-left text-sm rounded-md transition-colors ${
                  timeframe.preset === preset ? 'bg-bambu-green text-white' : 'text-white hover:bg-bambu-dark-tertiary'
                }`}
                onClick={() => {
                  onChange({ preset, dateFrom: undefined, dateTo: undefined });
                  setOpen(false);
                }}
              >
                {t(`stats.timeframe.${preset}`)}
              </button>
            ))}

            <div className="border-t border-bambu-dark-tertiary my-2" />

            <button
              className={`w-full px-3 py-2 text-left text-sm rounded-md transition-colors ${
                timeframe.preset === 'custom' ? 'bg-bambu-green text-white' : 'text-white hover:bg-bambu-dark-tertiary'
              }`}
              onClick={() => onChange((prev) => ({ ...prev, preset: 'custom' }))}
            >
              {t('stats.timeframe.custom')}
            </button>

            {timeframe.preset === 'custom' && (
              <div className="mt-2 px-1 pb-1 space-y-2">
                <div>
                  <label className="text-xs text-bambu-gray block mb-1">{t('stats.timeframe.from')}</label>
                  <input
                    type="date"
                    value={timeframe.dateFrom || ''}
                    max={timeframe.dateTo || today}
                    onChange={(e) => onChange((prev) => ({ ...prev, dateFrom: e.target.value || undefined }))}
                    className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded-md px-3 py-1.5 text-sm text-white"
                  />
                </div>
                <div>
                  <label className="text-xs text-bambu-gray block mb-1">{t('stats.timeframe.to')}</label>
                  <input
                    type="date"
                    value={timeframe.dateTo || ''}
                    min={timeframe.dateFrom}
                    max={today}
                    onChange={(e) => onChange((prev) => ({ ...prev, dateTo: e.target.value || undefined }))}
                    className="w-full bg-bambu-dark border border-bambu-dark-tertiary rounded-md px-3 py-1.5 text-sm text-white"
                  />
                </div>
                <Button variant="primary" onClick={() => setOpen(false)} className="w-full">
                  {t('common.apply')}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
