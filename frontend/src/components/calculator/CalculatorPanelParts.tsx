// Shared header/search/empty-state components for the calculator settings
// panels (CalculatorFilamentsPanel, CalculatorPrintersPanel). Pulled out of
// the former single-file CalculatorSettingsPanels.tsx (T-078/T-079) so the
// header count badge and the "no matches" paragraph exist in one place
// instead of two byte-identical copies.
//
// Deliberately NOT part of the SURFACE-tracked component-exports section:
// every component below is declared without a leading `export` keyword and
// re-exported through the bare `export { ... }` statement at the bottom,
// which the SURFACE regex
// (`^export (default function|function|const|type|interface|class|enum) ...`)
// does not match.

import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { inputCls } from '../formStyles';
import type { SortDir } from './calculatorSettingsShared';

const thBtnCls =
  'flex items-center gap-1 text-[11px] uppercase tracking-wide font-medium text-bambu-gray hover:text-white transition-colors whitespace-nowrap';

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = 'right',
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={onClick} className={`${thBtnCls} ${align === 'right' ? 'ml-auto' : ''}`}>
        {label}
        {active &&
          (dir === 'asc' ? (
            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

function SearchBox({ value, onChange, className = '' }: { value: string; onChange: (v: string) => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`relative ${className}`}>
      <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        type="search"
        className={`${inputCls} !pl-9`}
        placeholder={t('common.search')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('common.search')}
      />
    </div>
  );
}

/** The "N" / "visible / total" badge next to a panel's tab title. */
function CountBadge({ visible, total }: { visible: number; total: number }) {
  return (
    <span className="ml-2 text-sm font-normal text-bambu-gray tabular-nums">
      {visible === total ? total : `${visible} / ${total}`}
    </span>
  );
}

/** The paragraph shown instead of the table when a search/filter leaves
 *  nothing to list. */
function NoMatches() {
  const { t } = useTranslation();
  return <p className="text-sm text-bambu-gray text-center py-6">{t('calculator.noMatches')}</p>;
}

export { SortHeader, SearchBox, CountBadge, NoMatches };
