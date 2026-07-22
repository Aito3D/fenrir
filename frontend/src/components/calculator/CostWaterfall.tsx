import { useTranslation } from 'react-i18next';
import { formatMoney, formatPct, STEP_LABEL_KEY, type WaterfallStep } from '../../utils/pricing';
import { SegmentLegend } from './shared';
import { useSettledValue } from '../../hooks/useSettledValue';

const STEP_COLOR: Record<WaterfallStep['key'], string> = {
  filament: 'var(--viz-1)',
  printer: 'var(--viz-2)',
  energy: 'var(--viz-3)',
  provisions: 'var(--viz-4)',
  other: 'var(--viz-5)',
  labor: 'var(--viz-6)',
  marge: 'var(--color-bambu-green)',
  tax: 'transparent', // hatched via CSS — tax is collected, not kept
};

/**
 * The price assembling itself: each cost step is a floating segment starting
 * where the previous one ended, filling left-to-right with a small stagger.
 * The right edge of the last segment IS the sale price. Margin is the one
 * green step (what you keep); tax is hatched (what you collect).
 */
export function CostWaterfall({ steps, currency }: { steps: WaterfallStep[]; currency: string }) {
  const { t } = useTranslation();
  const total = steps.length > 0 ? steps[steps.length - 1].cumulative : 0;
  // Re-run the fill animation when the numbers settle, not on every keystroke.
  const settledTotal = useSettledValue(total, 300);
  if (steps.length === 0 || total <= 0) return null;

  return (
    <div className="space-y-2">
      <div
        key={settledTotal}
        className="waterfall-track relative h-9 rounded-lg bg-bambu-dark/60 overflow-hidden"
        role="img"
        aria-label={t('calculator.waterfall.aria')}
      >
        {steps.map((step, idx) => {
          const start = step.cumulative - step.value;
          return (
            <div
              key={step.key}
              title={`${t(STEP_LABEL_KEY[step.key])}: ${formatMoney(step.value, currency)} (${formatPct(step.value / total, 1)}) — ${formatMoney(step.cumulative, currency)}`}
              className={`waterfall-seg animate-waterfall-fill absolute inset-y-1 rounded-sm ${step.key === 'tax' ? 'waterfall-seg-tax' : ''}`}
              style={{
                left: `${(start / total) * 100}%`,
                width: `max(${(step.value / total) * 100}%, 3px)`,
                backgroundColor: STEP_COLOR[step.key],
                animationDelay: `${idx * 40}ms`,
              }}
            />
          );
        })}
      </div>
      <SegmentLegend
        segments={steps.map((s) => ({
          key: s.key,
          label: t(STEP_LABEL_KEY[s.key]),
          value: s.value,
          color: s.key === 'tax' ? 'color-mix(in srgb, var(--color-bambu-gray, #888) 45%, transparent)' : STEP_COLOR[s.key],
        }))}
        total={total}
      />
    </div>
  );
}
