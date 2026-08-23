// Shared sort-state/parsing helpers for the calculator settings panels
// (CalculatorFilamentsPanel, CalculatorPrintersPanel). Pulled out of the
// former single-file CalculatorSettingsPanels.tsx (T-078/T-079) so the
// toggleSort logic exists in one place instead of two byte-identical copies.
//
// Non-JSX helpers live here (kept separate from ./CalculatorPanelParts.tsx
// so this file only ever exports non-components, which is what lets
// react-refresh/only-export-components pass without an extra ignore).
//
// Deliberately NOT part of the SURFACE-tracked component-exports section:
// every binding below is declared without a leading `export` keyword and
// re-exported through the bare `export { ... }` / `export type { ... }`
// statements at the bottom, which the SURFACE regex
// (`^export (default function|function|const|type|interface|class|enum) ...`)
// does not match.

import { useState } from 'react';

/** Shared `<td>` class for the filament/printer profile tables (distinct
 * from the right-aligned/tabular-nums tdCls in ../shared.tsx). */
const settingsTdCls = 'px-3 py-2 text-sm whitespace-nowrap';

const parseNum = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

type SortDir = 'asc' | 'desc';

/** Sort-key/direction state plus the toggle-on-header-click behavior shared
 *  by the filaments and printers panels: clicking the already-active column
 *  flips direction, clicking a different one selects it ascending. */
function useSortToggle<K extends string>(initialKey: K): { sortKey: K; sortDir: SortDir; toggleSort: (key: K) => void } {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: K) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return { sortKey, sortDir, toggleSort };
}

export type { SortDir };
export { parseNum, settingsTdCls, useSortToggle };
