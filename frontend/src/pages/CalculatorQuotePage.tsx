import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer as PrinterIcon } from 'lucide-react';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { buildPricingInputs, loadCalculatorState, num } from '../hooks/useCalculatorState';
import { computePricing, discountMatrix, formatMoney, formatPct } from '../utils/pricing';

/**
 * Client-facing printable quote. Deliberately light-on-white and free of the
 * app chrome — this is the one surface meant to leave the workshop. It
 * re-reads the calculator's persisted state, so it always shows the job the
 * calculator currently holds.
 */
export function CalculatorQuotePage() {
  const { t } = useTranslation();
  const state = useMemo(() => loadCalculatorState(), []);

  const { data: filaments = [] } = useQuery({ queryKey: ['calculatorFilaments'], queryFn: api.getCalculatorFilaments });
  const { data: printers = [] } = useQuery({ queryKey: ['calculatorPrinters'], queryFn: api.getCalculatorPrinters });
  const { data: defaults } = useQuery({ queryKey: ['calculatorDefaults'], queryFn: api.getCalculatorDefaults });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';

  const filament = filaments.find((f) => f.id === state.filamentId) ?? filaments[0];
  const printer = printers.find((p) => p.id === state.printerId) ?? printers[0];
  const result = useMemo(() => {
    if (!defaults || !filament || !printer) return null;
    const effectiveDefaults = {
      ...defaults,
      failure_rate_pct:
        state.failureRateOverride !== '' ? num(state.failureRateOverride, defaults.failure_rate_pct) : defaults.failure_rate_pct,
      electricity_tariff:
        state.tariffOverride !== '' ? num(state.tariffOverride, defaults.electricity_tariff) : defaults.electricity_tariff,
    };
    return computePricing(buildPricingInputs(state, defaults), filament, printer, effectiveDefaults);
  }, [state, filament, printer, defaults]);

  const discounts = useMemo(() => (result ? discountMatrix(result).filter((c) => c.discount > 0) : []), [result]);
  const timeLabel = `${Math.max(0, num(state.timeH))}h${state.timeM.trim() ? ` ${state.timeM}min` : ''}`;
  // Without weight AND time there is no job — the "price" would just be the
  // flat consumables constant marked up (same guard as the calculator page).
  const noJob = num(state.weight) <= 0 && num(state.timeH) <= 0 && num(state.timeM) <= 0;

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-2xl mx-auto px-8 py-10">
        {/* Screen-only toolbar */}
        <div className="flex items-center justify-between mb-8 print:hidden">
          <Link to="/calculator" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900">
            <ArrowLeft className="w-4 h-4" />
            {t('calculator.quote.back')}
          </Link>
          <Button onClick={() => window.print()}>
            <PrinterIcon className="w-4 h-4 mr-1.5" />
            {t('calculator.quote.print')}
          </Button>
        </div>

        {!result || !filament || !printer || noJob ? (
          <p className="text-gray-500">{t('calculator.quote.empty')}</p>
        ) : (
          <>
            <header className="border-b-2 border-gray-900 pb-4 mb-6">
              <h1 className="text-2xl font-bold tracking-tight">{t('calculator.quote.title')}</h1>
              <p className="text-sm text-gray-500 mt-1">{new Date().toLocaleDateString()}</p>
            </header>

            <section className="mb-8">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                {t('calculator.quote.jobDetails')}
              </h2>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">{t('calculator.filament')}</dt>
                  <dd className="font-medium text-right">{filament.name}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">{t('calculator.weight')}</dt>
                  <dd className="font-medium text-right">{state.weight || '0'} g</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">{t('calculator.printingTime')}</dt>
                  <dd className="font-medium text-right">{timeLabel}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">{t('calculator.quantity')}</dt>
                  <dd className="font-medium text-right">{result.quantity}</dd>
                </div>
              </dl>
            </section>

            <section className="rounded-xl border border-gray-200 px-6 py-5 mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-sm text-gray-500">
                  {t('calculator.totalTTC')}
                  {result.quantity > 1 ? ` · ${t('calculator.perUnit')}` : ''}
                </div>
                <div className="text-4xl font-bold tracking-tight tabular-nums">
                  {formatMoney(result.total_ttc, currency)}
                </div>
              </div>
              {result.quantity > 1 && (
                <div className="text-right">
                  <div className="text-sm text-gray-500">{t('calculator.forQuantity', { count: result.quantity })}</div>
                  <div className="text-xl font-semibold tabular-nums">{formatMoney(result.total_ttc_qty, currency)}</div>
                </div>
              )}
            </section>

            {discounts.length > 0 && (
              <section className="mb-8">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  {t('calculator.quote.volumePricing')}
                </h2>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-gray-500">
                      <th className="text-left py-1.5 font-medium">{t('calculator.quote.discount')}</th>
                      <th className="text-right py-1.5 font-medium">{t('calculator.quote.unitPrice')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discounts.map((column) => (
                      <tr key={column.discount} className="border-b border-gray-100">
                        <td className="py-1.5">{formatPct(column.discount, 0)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(column.price, currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <footer className="text-xs text-gray-400 border-t border-gray-200 pt-4">
              {t('calculator.quote.footnote')}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
