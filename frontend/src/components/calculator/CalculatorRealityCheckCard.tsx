import { useTranslation } from 'react-i18next';
import { ArrowRight, Gauge, RotateCcw, Save } from 'lucide-react';
import { Card, CardContent, CardHeader } from '../Card';
import { Button } from '../Button';
import { formatMoney } from '../../utils/pricing';
import type { RealityCheck } from '../../utils/calculatorInsights';

/**
 * Measured values vs the calculator's assumptions, with one-click apply.
 * Quiet by design: a row only appears when the app's own data (print log,
 * settings, spool inventory) meaningfully disagrees with what the calculator
 * assumes. Applying sets a session override — nothing is written to the
 * stored defaults unless the user explicitly saves.
 */
export function CalculatorRealityCheckCard({
  checks,
  currency,
  appliedFailure,
  appliedTariff,
  onApply,
  onRevert,
  onSaveDefault,
  onUpdateFilamentCost,
  canUpdate,
}: {
  checks: RealityCheck[];
  currency: string;
  appliedFailure: boolean;
  appliedTariff: boolean;
  onApply: (kind: 'failure' | 'tariff', value: number) => void;
  onRevert: (kind: 'failure' | 'tariff') => void;
  onSaveDefault: (kind: 'failure' | 'tariff', value: number) => void;
  onUpdateFilamentCost: (filamentId: number, costPerKg: number) => void;
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  if (checks.length === 0) return null;

  const fmt = (check: RealityCheck, value: number): string =>
    check.kind === 'failure' ? `${value.toFixed(1)}%` : formatMoney(value, currency);

  const label = (check: RealityCheck): string => {
    if (check.kind === 'failure') {
      return check.scope
        ? t('calculator.realityCheck.failureScoped', { scope: check.scope })
        : t('calculator.realityCheck.failure');
    }
    if (check.kind === 'tariff') return t('calculator.realityCheck.tariff');
    return t('calculator.realityCheck.spoolCost', { material: check.scope ?? '' });
  };

  return (
    <Card className="animate-calc-rise" style={{ animationDelay: '50ms' }}>
      <CardHeader>
        <h2 className="font-semibold text-white flex items-center gap-2">
          <Gauge className="w-4 h-4 text-bambu-gray" />
          {t('calculator.realityCheck.title')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-1.5">
        <p className="text-xs text-bambu-gray">{t('calculator.realityCheck.subtitle')}</p>
        {checks.map((check) => {
          const applied = check.kind === 'failure' ? appliedFailure : check.kind === 'tariff' ? appliedTariff : false;
          const overridable = check.kind !== 'spoolCost';
          return (
            <div
              key={`${check.kind}-${check.scope ?? 'all'}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-bambu-dark/50 px-3 py-2 text-sm"
            >
              <span className="text-bambu-gray flex-1 min-w-[8rem]">{label(check)}</span>
              <span className="flex items-center gap-1.5 tabular-nums">
                <span className={applied ? 'text-bambu-gray line-through' : 'text-white'}>
                  {fmt(check, check.assumed)}
                </span>
                <ArrowRight className="w-3 h-3 text-bambu-gray" aria-hidden="true" />
                <span className={check.measured > check.assumed ? 'text-status-error' : 'text-status-ok'}>
                  {fmt(check, check.measured)}
                </span>
                {check.sample > 1 && <span className="text-[10px] text-bambu-gray">n={check.sample}</span>}
              </span>
              {overridable && !applied && (
                <Button variant="ghost" size="sm" onClick={() => onApply(check.kind as 'failure' | 'tariff', check.measured)}>
                  {t('calculator.realityCheck.apply')}
                </Button>
              )}
              {overridable && applied && (
                <span className="flex items-center gap-1">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-bambu-green/10 text-bambu-green">
                    {t('calculator.realityCheck.applied')}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevert(check.kind as 'failure' | 'tariff')}
                    aria-label={t('calculator.realityCheck.revert')}
                    title={t('calculator.realityCheck.revert')}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </Button>
                  {canUpdate && (
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
              {check.kind === 'spoolCost' && canUpdate && check.filamentId !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onUpdateFilamentCost(check.filamentId!, check.measured)}
                  title={t('calculator.realityCheck.updateProfileHint')}
                >
                  {t('calculator.realityCheck.updateProfile')}
                </Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
