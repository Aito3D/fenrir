// Plain-text job spec for the calculator's copy button — a compact block the
// operator pastes into their quote document. Deliberately in French and NOT
// localized: the pasted document is French regardless of the app language.
// The color line is left blank — the customer's color choice isn't something
// the calculator knows.

import type { CalculatorFilament, CalculatorPrinter } from '../api/client';
import { num, type CalcState } from '../hooks/useCalculatorState';

export function buildQuoteSummary(
  filament: CalculatorFilament,
  printer: CalculatorPrinter,
  state: CalcState,
): string {
  const hours =
    Math.max(0, num(state.timeD)) * 24 + Math.max(0, num(state.timeH)) + Math.max(0, num(state.timeM)) / 60;
  const time = String(Math.round(hours * 100) / 100);
  return [
    `Matériau: ${filament.material || filament.name}`,
    `Poids: ${state.weight || '0'}g`,
    `Temps: ${time}h`,
    'Couleur: ',
    `Imprimante: ${printer.name}`,
  ].join('\n');
}
