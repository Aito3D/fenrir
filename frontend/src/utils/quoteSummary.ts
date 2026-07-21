// Plain-text job spec for the calculator's copy button — a compact block the
// operator pastes into their own quote document. Pure module — the caller
// supplies the translator. The color line is deliberately left blank: the
// customer's color choice isn't something the calculator knows.

import type { TFunction } from 'i18next';
import type { CalculatorFilament, CalculatorPrinter } from '../api/client';
import { num, type CalcState } from '../hooks/useCalculatorState';

export function buildQuoteSummary(
  filament: CalculatorFilament,
  printer: CalculatorPrinter,
  state: CalcState,
  t: TFunction,
): string {
  const hours = Math.max(0, num(state.timeH)) + Math.max(0, num(state.timeM)) / 60;
  const time = String(Math.round(hours * 100) / 100);
  return [
    `${t('calculator.copyBlock.material')}: ${filament.material || filament.name}`,
    `${t('calculator.copyBlock.weight')}: ${state.weight || '0'}g`,
    `${t('calculator.copyBlock.time')}: ${time}h`,
    `${t('calculator.copyBlock.color')}: `,
    `${t('calculator.copyBlock.printer')}: ${printer.name}`,
  ].join('\n');
}
