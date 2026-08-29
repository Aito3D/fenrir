import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, CheckCircle2, Gauge, Info, RotateCcw, Save, X } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { Tooltip } from '../Tooltip';
import { focusRingCls } from '../formStyles';
import { formatMoney } from '../../utils/pricing';
import { checkKey, type RealityCheck, type RealityCheckKind } from '../../utils/calculatorInsights';
import { prefersReducedMotion } from '../../utils/motion';

/** Matches .calc-check-row[data-leaving] in index.css. */
const LEAVE_MS = 150;

/**
 * Measured values vs the calculator's assumptions, with one-click apply.
 * Quiet by design: a row only appears when the app's own data (print log,
 * energy readings, settings, spool inventory) meaningfully disagrees with
 * what the calculator assumes. Applying sets a session override — nothing is
 * written to the stored defaults or profiles unless the user explicitly saves.
 */
export function CalculatorRealityCheckCard({
  checks,
  impacts,
  currency,
  windowDays,
  applied,
  onApply,
  onApplyAll,
  onRevert,
  onSaveDefault,
  onUpdateFilamentCost,
  onUpdatePrinterProfile,
  onDismiss,
  dismissedCount,
  onRestoreDismissed,
  canUpdate,
  allClear,
}: {
  checks: RealityCheck[];
  /** Per-unit price delta of applying each check, keyed by checkKey; null = no price effect. */
  impacts: Record<string, number | null>;
  currency: string;
  windowDays?: number;
  applied: Partial<Record<RealityCheckKind, boolean>>;
  onApply: (check: RealityCheck) => void;
  onApplyAll: (checks: RealityCheck[]) => void;
  onRevert: (kind: RealityCheckKind) => void;
  onSaveDefault: (kind: 'failure' | 'tariff', value: number) => void;
  onUpdateFilamentCost: (filamentId: number, costPerKg: number) => void;
  onUpdatePrinterProfile: (printerId: number, patch: { power_watts?: number; daily_usage_hours?: number }) => void;
  onDismiss: (key: string) => void;
  dismissedCount: number;
  onRestoreDismissed: () => void;
  canUpdate: boolean;
  /** Insights had enough data to check something and every check agrees. */
  allClear: boolean;
}) {
  const { t } = useTranslation();
  // Rows enter with calc-tab-in; on dismiss they leave the same way (back down
  // and out) before the parent drops them, instead of vanishing and letting the
  // rows below jump. Under reduced motion the dismiss is immediate.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const dismiss = (key: string) => {
    if (prefersReducedMotion() || leaving.has(key)) {
      onDismiss(key);
      return;
    }
    setLeaving((prev) => new Set(prev).add(key));
    timers.current.push(
      window.setTimeout(() => {
        setLeaving((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        onDismiss(key);
      }, LEAVE_MS),
    );
  };

  if (checks.length === 0) {
    if (!allClear && dismissedCount === 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-bambu-gray">
        {allClear && (
          <>
            <CheckCircle2 className="w-3.5 h-3.5 text-status-ok flex-shrink-0" aria-hidden="true" />
            {t('calculator.realityCheck.allClear')}
          </>
        )}
        {dismissedCount > 0 && (
          <button type="button" onClick={onRestoreDismissed} className={`underline hover:text-white transition-colors rounded ${focusRingCls}`}>
            {t('calculator.realityCheck.restore', { count: dismissedCount })}
          </button>
        )}
      </div>
    );
  }

  const formatHours = (h: number): string => {
    const totalM = Math.round(h * 60);
    const hh = Math.floor(totalM / 60);
    const mm = totalM % 60;
    return mm > 0 ? `${hh}h${String(mm).padStart(2, '0')}` : `${hh}h`;
  };

  const fmt = (check: RealityCheck, value: number): string => {
    switch (check.kind) {
      case 'failure':
        return `${value.toFixed(1)}%`;
      case 'time':
        return formatHours(value);
      case 'power':
        return `${Math.round(value)} W`;
      case 'dailyHours':
        return `${value.toFixed(1)} h`;
      default:
        return formatMoney(value, currency);
    }
  };

  const label = (check: RealityCheck): string => {
    const scoped = (base: string): string =>
      check.scope
        ? t(`calculator.realityCheck.${base}Scoped`, { scope: check.scope })
        : t(`calculator.realityCheck.${base}`);
    switch (check.kind) {
      case 'failure':
        return scoped('failure');
      case 'tariff':
        return t('calculator.realityCheck.tariff');
      case 'time':
        return scoped('time');
      case 'power':
        return scoped('power');
      case 'dailyHours':
        return scoped('dailyHours');
      case 'spoolCost':
        return check.brand
          ? t('calculator.realityCheck.spoolCostBrand', { brand: check.brand, material: check.scope ?? '' })
          : t('calculator.realityCheck.spoolCost', { material: check.scope ?? '' });
    }
  };

  const sourceHint = (check: RealityCheck): string => {
    // Profiles usually name a model; when several machines matched, the
    // figure is a fleet average and the tooltip says over how many printers.
    const fleet = (check.printerCount ?? 1) > 1;
    switch (check.kind) {
      case 'tariff':
        return t('calculator.realityCheck.sourceSetting');
      case 'spoolCost':
        return t('calculator.realityCheck.sourceSpools', { count: check.sample });
      case 'dailyHours':
        return fleet
          ? t('calculator.realityCheck.sourceUsageFleet', {
              count: check.sample,
              days: check.observedDays ?? 0,
              printers: check.printerCount,
            })
          : t('calculator.realityCheck.sourceUsage', { count: check.sample, days: check.observedDays ?? 0 });
      default:
        return fleet
          ? t('calculator.realityCheck.sourcePrintsFleet', {
              count: check.sample,
              days: windowDays ?? 365,
              printers: check.printerCount,
            })
          : t('calculator.realityCheck.sourcePrints', { count: check.sample, days: windowDays ?? 365 });
    }
  };

  const overridable = (check: RealityCheck): boolean => check.kind !== 'spoolCost';
  const applyAllTargets = checks.filter((c) => overridable(c) && !applied[c.kind]);

  // The `daily_usage_hours` profile field is bounded `gt=0, le=24`
  // (backend/app/schemas/calculator.py). `_daily_usage` has no plausibility
  // band of its own (unlike the sibling aggregates), so a handful of very
  // short or overlapping print-log entries can produce a measured figure
  // that rounds to 0 or above 24 — a value the API would reject with a 422.
  // Compute the exact value `onUpdatePrinterProfile` would post and only
  // offer the button when it is actually postable. (`power_watts` has no
  // hazard here: its source is pre-banded to [1, 3000] W before publishing,
  // comfortably inside the backend's `gt=0, le=100_000_000` bound, so no
  // equivalent guard is needed for the power branch.)
  const postableDailyUsageHours = (check: RealityCheck): number | null => {
    if (check.kind !== 'dailyHours') return null;
    const posted = Math.round(check.measured * 10) / 10;
    return posted > 0 && posted <= 24 ? posted : null;
  };

  // `cost_per_kg` is bounded `gt=0, le=100_000_000` (backend/app/schemas/
  // calculator.py, CalculatorFilamentUpdate). `_spool_costs` averages every
  // non-archived spool with a non-null cost, so a material whose spools were
  // all entered at 0 yields an `avg_cost_per_kg` of exactly 0 — a value the
  // API would reject with a 422. Compute the exact value `onUpdateFilamentCost`
  // would post and only offer the button when it is actually postable.
  const _SPOOL_COST_CEILING = 100_000_000;
  const postableSpoolCost = (check: RealityCheck): number | null => {
    if (check.kind !== 'spoolCost') return null;
    return check.measured > 0 && check.measured <= _SPOOL_COST_CEILING ? check.measured : null;
  };

  return (
    // Delay matches the house `stagger-children` 50ms cadence; kept inline
    // because this card and its siblings live in separate grid columns, not
    // one shared parent that `stagger-children` could be applied to.
    <Card className="animate-calc-rise" style={{ animationDelay: '50ms' }}>
      <CardHeader className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Gauge className="w-4 h-4 text-bambu-gray" />
          {t('calculator.realityCheck.title')}
          <span className="text-[10px] font-normal tabular-nums px-1.5 py-0.5 rounded-full bg-bambu-dark text-bambu-gray">
            {checks.length}
          </span>
        </h2>
        {applyAllTargets.length >= 2 && (
          <Button variant="ghost" size="sm" onClick={() => onApplyAll(applyAllTargets)}>
            {t('calculator.realityCheck.applyAll')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-1.5">
        <p className="text-xs text-bambu-gray">{t('calculator.realityCheck.subtitle')}</p>
        {checks.map((check, idx) => {
          const key = checkKey(check);
          const isApplied = overridable(check) && !!applied[check.kind];
          const impact = impacts[key] ?? null;
          const hasImpact = impact !== null && Math.abs(impact) >= 0.005;
          // Color the measured figure by what applying it DOES to the price:
          // red = the quote was too cheap, green = it was too expensive.
          // Rows without a price effect fall back to direction-of-change.
          const measuredCls = hasImpact
            ? impact > 0
              ? 'text-status-error'
              : 'text-status-ok'
            : impact !== null
              ? 'text-bambu-gray-light'
              : check.measured > check.assumed
                ? 'text-status-error'
                : 'text-status-ok';
          const relDelta = check.assumed > 0 ? (check.measured - check.assumed) / check.assumed : null;
          return (
            <div
              key={key}
              // Rows are keyed by checkKey, so this entrance fires exactly when
              // a check first mounts: a gentle cascade on first paint, a lone
              // fade-in when a later check appears (material switch, fresh print
              // data) instead of teleporting into the settled card. Capped delay
              // keeps a long list from trickling in.
              data-leaving={leaving.has(key) || undefined}
              className={`calc-check-row animate-calc-tab-in rounded-lg bg-bambu-dark/50 border-l-2 px-3 py-2 text-sm ${
                check.severity === 'significant' ? 'border-status-error/70' : 'border-status-warning/60'
              }`}
              style={{ animationDelay: `${Math.min(idx * 30, 180)}ms` }}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-bambu-gray flex-1 min-w-[8rem] inline-flex items-center gap-1.5">
                  {label(check)}
                  <Tooltip content={sourceHint(check)}>
                    <Info className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                  </Tooltip>
                </span>
                <span className="flex items-center gap-1.5 tabular-nums">
                  <span className={isApplied ? 'text-bambu-gray line-through' : 'text-white'}>
                    {fmt(check, check.assumed)}
                  </span>
                  <ArrowRight className="w-3 h-3 text-bambu-gray" aria-hidden="true" />
                  <span className={measuredCls}>{fmt(check, check.measured)}</span>
                  {relDelta !== null && Math.abs(relDelta) >= 0.005 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bambu-dark text-bambu-gray">
                      {relDelta > 0 ? '+' : '−'}
                      {Math.abs(relDelta * 100) >= 9.5 ? Math.round(Math.abs(relDelta) * 100) : (Math.abs(relDelta) * 100).toFixed(1)}%
                    </span>
                  )}
                </span>
                {!isApplied && (
                  <button
                    type="button"
                    aria-label={t('calculator.realityCheck.dismiss')}
                    title={t('calculator.realityCheck.dismiss')}
                    onClick={() => dismiss(key)}
                    className={`p-2 -m-2 rounded-full text-bambu-gray hover:text-white transition-colors ${focusRingCls}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-[10px] text-bambu-gray tabular-nums flex-1 min-w-[8rem]">
                  {check.sample > 1 && <>n={check.sample}</>}
                  {hasImpact && (
                    <span className={`ml-2 ${impact > 0 ? 'text-status-error' : 'text-status-ok'}`}>
                      {t('calculator.realityCheck.deltaUnit', {
                        amount: `${impact > 0 ? '+' : '−'}${formatMoney(Math.abs(impact), currency)}`,
                      })}
                    </span>
                  )}
                </span>
                {overridable(check) && !isApplied && (
                  <Button variant="ghost" size="sm" onClick={() => onApply(check)}>
                    {t('calculator.realityCheck.apply')}
                  </Button>
                )}
                {overridable(check) && isApplied && (
                  <span className="flex items-center gap-1">
                    <span className="animate-calc-badge-pop text-xs px-2 py-0.5 rounded-full bg-bambu-green/10 text-bambu-green">
                      {t('calculator.realityCheck.applied')}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRevert(check.kind)}
                      aria-label={t('calculator.realityCheck.revert')}
                      title={t('calculator.realityCheck.revert')}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </Button>
                    {canUpdate && (check.kind === 'failure' || check.kind === 'tariff') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSaveDefault(check.kind as 'failure' | 'tariff', check.measured)}
                        aria-label={t('calculator.realityCheck.saveDefault')}
                        title={t('calculator.realityCheck.saveDefault')}
                      >
                        <Save className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </span>
                )}
                {check.kind === 'spoolCost' &&
                  canUpdate &&
                  check.filamentId !== undefined &&
                  postableSpoolCost(check) !== null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onUpdateFilamentCost(check.filamentId!, postableSpoolCost(check)!)}
                      title={t('calculator.realityCheck.updateProfileHint')}
                    >
                      {t('calculator.realityCheck.updateProfile')}
                    </Button>
                  )}
                {check.kind === 'power' &&
                  canUpdate &&
                  check.printerId !== undefined && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onUpdatePrinterProfile(check.printerId!, { power_watts: Math.round(check.measured) })}
                      title={t('calculator.realityCheck.updatePrinterHint')}
                    >
                      {t('calculator.realityCheck.updatePrinter')}
                    </Button>
                  )}
                {check.kind === 'dailyHours' &&
                  canUpdate &&
                  check.printerId !== undefined &&
                  postableDailyUsageHours(check) !== null && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        onUpdatePrinterProfile(check.printerId!, { daily_usage_hours: postableDailyUsageHours(check)! })
                      }
                      title={t('calculator.realityCheck.updatePrinterHint')}
                    >
                      {t('calculator.realityCheck.updatePrinter')}
                    </Button>
                  )}
              </div>
            </div>
          );
        })}
        {dismissedCount > 0 && (
          <button
            type="button"
            onClick={onRestoreDismissed}
            className={`text-[10px] text-bambu-gray underline hover:text-white transition-colors rounded ${focusRingCls}`}
          >
            {t('calculator.realityCheck.restore', { count: dismissedCount })}
          </button>
        )}
      </CardContent>
    </Card>
  );
}
