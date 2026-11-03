import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import type { ProjectTagCount } from '../../../api/client';
import { focusRingCls, inputCls } from '../../formStyles';
import { CHIPS, SORTS, SORT_KEYS, type CatalogChip, type CatalogFilters, type CatalogSort } from './catalogRules';

export const CATALOG_STATUSES = ['active', 'completed', 'archived', 'all'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

const chipCls = (on: boolean) =>
  `btn-press inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs ${
    on ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'
  } ${focusRingCls}`;

interface Props {
  searchRef: RefObject<HTMLInputElement | null>;
  q: string;
  onQChange: (q: string) => void;
  filters: CatalogFilters;
  onToggleChip: (chip: CatalogChip) => void;
  onToggleMaterial: (material: string) => void;
  materials: string[];
  sort: CatalogSort;
  onSortChange: (sort: CatalogSort) => void;
  status: CatalogStatus;
  onStatusChange: (status: CatalogStatus) => void;
  usedTags: ProjectTagCount[];
  tagIds: number[];
  onToggleTag: (id: number) => void;
}

/** Search, quick filter chips (in production / ready / no file / materials), tag chips, sort and status. */
export function CatalogToolbar(p: Props) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" aria-hidden />
          <input ref={p.searchRef} type="search" value={p.q} onChange={(e) => p.onQChange(e.target.value)}
            placeholder={t('projectsPdm.catalog.searchPlaceholder')} aria-label={t('projectsPdm.catalog.searchPlaceholder')}
            className={`${inputCls} pl-9 pr-10`} />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-bambu-dark-tertiary px-1.5 font-mono text-[11px] text-bambu-gray">/</kbd>
        </div>
        <select value={p.sort} onChange={(e) => p.onSortChange(e.target.value as CatalogSort)} aria-label={t('projectsPdm.catalog.sortActivity')}
          className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-2 text-xs text-bambu-gray-light">
          {SORTS.map((s) => <option key={s} value={s}>{t(SORT_KEYS[s])}</option>)}
        </select>
        <select value={p.status} onChange={(e) => p.onStatusChange(e.target.value as CatalogStatus)} aria-label={t('projectsPdm.statusFilterLabel')}
          className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-2 text-xs text-bambu-gray-light">
          {CATALOG_STATUSES.map((s) => (
            <option key={s} value={s}>{s === 'all' ? t('projectsPdm.statusAll') : t(`projectDetail.status.${s}`)}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {CHIPS.map(({ id, key, Icon, cls }) => (
          <button key={id} type="button" aria-pressed={p.filters.chips.has(id)} onClick={() => p.onToggleChip(id)} className={chipCls(p.filters.chips.has(id))}>
            <Icon className={`h-3 w-3 ${cls}`} aria-hidden />{t(key)}
          </button>
        ))}
        {p.materials.length > 0 && <span className="mx-1 h-5 w-px bg-bambu-dark-tertiary" aria-hidden />}
        {p.materials.map((m) => (
          <button key={m} type="button" aria-pressed={p.filters.materials.has(m)} onClick={() => p.onToggleMaterial(m)} className={chipCls(p.filters.materials.has(m))}>{m}</button>
        ))}
        {p.usedTags.length > 0 && <span className="mx-1 h-5 w-px bg-bambu-dark-tertiary" aria-hidden />}
        {p.usedTags.map((tag) => (
          <button key={tag.id} type="button" aria-pressed={p.tagIds.includes(tag.id)} onClick={() => p.onToggleTag(tag.id)} className={chipCls(p.tagIds.includes(tag.id))}>
            {`#${tag.name}`}
          </button>
        ))}
      </div>
    </div>
  );
}
