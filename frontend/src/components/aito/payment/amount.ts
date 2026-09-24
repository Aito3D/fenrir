/** Whole francs only: digits (spaces tolerated), > 0.
 *
 *  Split out from `AmountField.tsx` so that file can stay component-only —
 *  `react-refresh/only-export-components` flags a `.tsx` file that exports
 *  both a component and a plain function. */
export function parseAmount(raw: string): number | null {
  const digits = raw.replace(/\s/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
