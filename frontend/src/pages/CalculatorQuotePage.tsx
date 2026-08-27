import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer as PrinterIcon } from 'lucide-react';
import { api } from '../api/client';
import { Button } from '../components/Button';
import { buildPricingInputs, foldSessionOverrides, loadCalculatorState, num } from '../hooks/useCalculatorState';
import { buildWaterfall, computePricing, formatMoney, STEP_LABEL_KEY } from '../utils/pricing';

/**
 * Client-facing printable quote. Deliberately light-on-white and free of the
 * app chrome — this is the one surface meant to leave the workshop. It
 * re-reads the calculator's persisted state, so it always shows the job the
 * calculator currently holds.
 */
export function CalculatorQuotePage() {
  const { t, i18n } = useTranslation();
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
    // Same session-override folding as the calculator page, so the printed
    // quote can't diverge from the totals the operator just saw.
    const effective = foldSessionOverrides(state, defaults, printer, buildPricingInputs(state, defaults));
    return computePricing(effective.inputs, filament, effective.printer, effective.defaults);
  }, [state, filament, printer, defaults]);

  const waterfall = useMemo(() => (result ? buildWaterfall(result) : []), [result]);
  // The quote rounds the TASK figure and derives the unit price from it, so
  // unit × quantity reproduces the printed total to the cent.
  const decimals = ['XPF', 'JPY', 'KRW'].includes(currency.toUpperCase()) ? 0 : 2;
  const scale = 10 ** decimals;
  const taskTtcRounded = result ? Math.round(result.total_ttc_qty * scale) / scale : 0;
  const unitTtcDisplayed = result && result.quantity > 1 ? taskTtcRounded / result.quantity : taskTtcRounded;
  const timeLabel = [
    num(state.timeD) > 0 ? `${Math.max(0, num(state.timeD))}${t('calculator.durationDaysShort')}` : '',
    `${Math.max(0, num(state.timeH))}h`,
    state.timeM.trim() ? `${state.timeM}min` : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Without weight AND time there is no job — the "price" would just be the
  // flat consumables constant marked up (same guard as the calculator page).
  const noJob =
    num(state.weight) <= 0 && num(state.timeD) <= 0 && num(state.timeH) <= 0 && num(state.timeM) <= 0;

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
              {/* Date in the app language, not the browser locale — this is
                  the one document that leaves the workshop. */}
              <p className="text-sm text-gray-500 mt-1">{new Date().toLocaleDateString(i18n.language)}</p>
            </header>

            <section className="mb-8">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                {t('calculator.quote.jobDetails')}
              </h2>
              <dl className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">{t('calculator.printer')}</dt>
                  <dd className="font-medium text-right">{printer.name}</dd>
                </div>
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
                <div className="text-4xl font-bold tracking-tight tabular-nums" data-testid="quote-unit-ttc">
                  {formatMoney(unitTtcDisplayed, currency)}
                </div>
              </div>
              {result.quantity > 1 && (
                <div className="text-right">
                  <div className="text-sm text-gray-500">{t('calculator.forQuantity', { count: result.quantity })}</div>
                  <div className="text-xl font-semibold tabular-nums" data-testid="quote-task-ttc">
                    {formatMoney(taskTtcRounded, currency)}
                  </div>
                </div>
              )}
            </section>

            {waterfall.length > 0 && (
              <section className="mb-8">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  {t('calculator.breakdown')}
                  {result.quantity > 1 ? ` · ${t('calculator.perUnit')}` : ''}
                </h2>
                {/* Same steps as the calculator's waterfall — per-unit amounts
                    whose sum is exactly the headline total above. */}
                <table className="w-full text-sm">
                  <tbody>
                    {waterfall.map((step) => (
                      <tr key={step.key} className="border-b border-gray-100">
                        <td className="py-1.5 text-gray-500">{t(STEP_LABEL_KEY[step.key])}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatMoney(step.value, currency)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="py-2 font-semibold">{t('calculator.totalTTC')}</td>
                      <td className="py-2 text-right font-semibold tabular-nums">
                        {formatMoney(result.total_ttc, currency)}
                      </td>
                    </tr>
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
