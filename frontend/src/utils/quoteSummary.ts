// Plain-text quote summary shared by the calculator's copy button and the
// printable quote page. Pure module — the caller supplies the translator.

import type { TFunction } from 'i18next';
import type { CalculatorFilament, CalculatorPrinter } from '../api/client';
import { formatMoney, formatPct, type PricingResult } from './pricing';
import { num, type CalcState } from '../hooks/useCalculatorState';

export function buildQuoteSummary(
  result: PricingResult,
  filament: CalculatorFilament,
  printer: CalculatorPrinter,
  state: CalcState,
  currency: string,
  t: TFunction,
): string {
  const time = `${Math.max(0, num(state.timeH))}h${state.timeM.trim() ? ` ${state.timeM}min` : ''}`;
  const lines = [
    `${t('calculator.title')} — ${filament.name} · ${printer.name}`,
    `${t('calculator.weight')}: ${state.weight || '0'} · ${t('calculator.printingTime')}: ${time} · ${t('calculator.quantity')}: ${result.quantity}`,
    `${t('calculator.machineCost')}: ${formatMoney(result.machine_cost, currency)}`,
    `${t('calculator.groupLabor')}: ${formatMoney(result.labor_total, currency)}`,
    `${t('calculator.totalHT')}: ${formatMoney(result.total_ht, currency)}`,
    `${t('calculator.totalTTC')}: ${formatMoney(result.total_ttc, currency)}`,
  ];
  if (result.quantity > 1) {
    lines.push(`${t('calculator.forQuantity', { count: result.quantity })}: ${formatMoney(result.total_ttc_qty, currency)}`);
  }
  lines.push(`${t('calculator.marginPct')}: ${formatPct(result.margin_pct)}`);
  return lines.join('\n');
}
