import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeColor, FilamentTreeSummary, FilamentTreeTargets } from '../../api/client';
import { Card } from '../Card';
import type { NodeRef } from './NodePanel';
import { readPaK } from './paGcode';

export interface MaterialCardsProps {
  trees: FilamentTreeSummary[];
  targets: FilamentTreeTargets;
  selected: NodeRef | null;
  onSelect: (node: NodeRef) => void;
  /** The level every card shows: '' = all machines / all nozzles. */
  machine: string;
  nozzle: string;
  onLevel: (machine: string, nozzle: string) => void;
}

/** Accent colour per material family (from the old grouped preset page). */
function materialFamilyClass(material: string): string {
  const m = material.toUpperCase();
  if (m.startsWith('PETG') || m.startsWith('PCTG') || m.startsWith('PET-CF')) return 'text-sky-300';
  if (m.startsWith('PLA')) return 'text-green-400';
  if (m.startsWith('ABS') || m.startsWith('ASA')) return 'text-orange-400';
  if (m.startsWith('TPU')) return 'text-teal-400';
  // PPA before PP; PA before PC/PP
  if (m.startsWith('PA') || m.startsWith('PPA')) return 'text-violet-400';
  if (m.startsWith('PC')) return 'text-rose-400';
  if (m.startsWith('PP')) return 'text-amber-400';
  return 'text-sky-300';
}

const sameNode = (a: NodeRef | null, b: NodeRef) =>
  !!a && a.treeId === b.treeId && a.machine === b.machine && a.nozzle === b.nozzle && a.colorId === b.colorId;

/** skip_02 null means automatic: abrasive filaments skip the 0.2 nozzle. */
const skips02 = (tree: FilamentTreeSummary) => tree.skip_02 ?? tree.abrasive;

const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));

const pillCls = (active: boolean) =>
  `rounded-full px-2.5 py-1 text-xs font-medium ${active ? 'bg-bambu-green/20 text-bambu-green' : 'border border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`;

function Badge({ count }: { count: number | undefined }) {
  const { t } = useTranslation();
  if (!count) return null;
  return (
    <span
      aria-label={t('filamentTrees.ownCount', { count })}
      title={t('filamentTrees.ownHint')}
      className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-black"
    >
      {count}
    </span>
  );
}

function Pills({ label, all, options, value, onChange }: {
  label: string;
  all: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-xs text-bambu-gray">{label}</span>
      <button type="button" aria-pressed={value === ''} onClick={() => onChange('')} className={pillCls(value === '')}>
        {all}
      </button>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)} className={pillCls(value === o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

/** One brand (tree) of a material card: values at the card's machine/nozzle level, then its colours. */
function BrandRow({ tree, colors, machine, nozzle, selected, onSelect }: {
  tree: FilamentTreeSummary;
  colors: FilamentTreeColor[];
  machine: string;
  nozzle: string;
  selected: NodeRef | null;
  onSelect: (node: NodeRef) => void;
}) {
  const { t } = useTranslation();
  const m = machine || undefined;
  const n = (machine && nozzle) || undefined;
  const blocked = n === '0.2' && skips02(tree);
  // same key as NodePanel's, so its cache and the ['filament-trees'] invalidation are shared
  const { data: rows } = useQuery({
    queryKey: ['filament-trees', tree.id, 'node', m ?? null, n ?? null, null],
    queryFn: () => api.getFilamentTreeNode(tree.id, { machine: m, nozzle: n }),
    enabled: !blocked,
  });
  const value = (key: string) => first(rows?.find((r) => r.key === key)?.value);
  const chips = [
    { text: value('nozzle_temperature') && `${value('nozzle_temperature')}°C`, cls: 'bg-rose-500/10 text-rose-300' },
    { text: value('filament_flow_ratio') && `×${value('filament_flow_ratio')}`, cls: 'bg-sky-500/10 text-sky-300' },
    { text: readPaK(value('filament_start_gcode')) && `PA ${readPaK(value('filament_start_gcode'))}`, cls: 'bg-amber-500/10 text-amber-300' },
    { text: n && `⌀${n}mm`, cls: 'bg-bambu-green/10 text-bambu-green' },
  ].filter((c) => c.text);

  const levelRef: NodeRef = { treeId: tree.id, machine: m, nozzle: n };
  const levelKey = n ? `${m}/${n}` : m ? m : 'root';
  const brandSelected = sameNode(selected, levelRef);
  const colorRef = (c: FilamentTreeColor): NodeRef | null =>
    !m ? { treeId: tree.id, colorId: c.id } : n ? { treeId: tree.id, machine: m, nozzle: n, colorId: c.id } : null;
  const colorKey = (c: FilamentTreeColor) => (!m ? `color:${c.id}` : n ? `${m}/${n}/${c.id}` : '');

  return (
    <div className="grid gap-3 px-4 py-3 md:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSelect(levelRef)}
            disabled={blocked}
            aria-label={tree.name}
            aria-current={brandSelected ? 'true' : undefined}
            className={`rounded px-1 -mx-1 text-xs font-bold uppercase tracking-wide disabled:opacity-40 ${brandSelected ? 'bg-bambu-green/15 text-white' : 'text-bambu-gray hover:text-white'}`}
          >
            {tree.brand || '—'}
          </button>
          <Badge count={tree.own_counts[levelKey]} />
          {!!tree.export_pending && (
            <span
              role="img"
              aria-label={t('filamentTrees.pendingExport', { n: tree.export_pending })}
              title={t('filamentTrees.pendingExport', { n: tree.export_pending })}
              className="h-2 w-2 rounded-full bg-sky-400"
            />
          )}
        </div>
        {blocked ? (
          <p className="text-xs text-amber-300/80">{t('filamentTrees.no02')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 font-mono text-xs">
            {chips.map((c) => (
              <span key={c.cls} className={`rounded px-1.5 py-0.5 ${c.cls}`}>
                {c.text}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap content-start gap-1.5">
        {colors.map((c) => {
          const ref = colorRef(c);
          const active = !!ref && sameNode(selected, ref);
          const isSource = c.id === tree.source.color_id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => ref && onSelect(ref)}
              disabled={!ref || blocked}
              title={ref ? (c.price != null ? `${c.price}/kg` : undefined) : t('filamentTrees.pickNozzle')}
              aria-current={active ? 'true' : undefined}
              className={`flex items-center gap-2 rounded-lg border py-1 pl-1 pr-2.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-bambu-dark-tertiary text-bambu-gray-light enabled:hover:border-bambu-green/40 enabled:hover:text-white'}`}
            >
              <span className="h-6 w-6 shrink-0 rounded-md ring-1 ring-white/10" style={{ backgroundColor: c.hex || '#444' }} />
              {c.name}
              {isSource && (
                <span role="img" aria-label={t('filamentTrees.calibrationSource')} title={t('filamentTrees.calibrationSource')} className="text-sky-400">
                  ★
                </span>
              )}
              {!!c.spools && (
                <span
                  aria-label={t('filamentTrees.inStock', { n: c.spools })}
                  title={t('filamentTrees.inStock', { n: c.spools })}
                  className="rounded bg-white/10 px-1 text-[10px] font-semibold leading-4 text-bambu-gray-light"
                >
                  ×{c.spools}
                </span>
              )}
              {colorKey(c) && <Badge count={tree.own_counts[colorKey(c)]} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MaterialCard({ material, rows, machine, nozzle, selected, onSelect }: {
  material: string;
  rows: { tree: FilamentTreeSummary; colors: FilamentTreeColor[] }[];
  machine: string;
  nozzle: string;
  selected: NodeRef | null;
  onSelect: (node: NodeRef) => void;
}) {
  const { t } = useTranslation();
  const colors = rows.flatMap((r) => r.colors);
  return (
    <Card className={`overflow-hidden border-l-[3px] border-l-current ${materialFamilyClass(material)}`}>
      <details open className="group/section">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-white/[.02] [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-4 w-4 text-bambu-gray transition-transform group-open/section:rotate-90" />
          <span className="font-mono text-lg font-bold">{material}</span>
          <span className="text-sm text-bambu-gray">{t('filamentTrees.colourTotal', { count: colors.length })}</span>
          <span className="flex flex-wrap gap-1">
            {colors.slice(0, 24).map((c, i) => (
              <span key={i} className="h-3 w-3 rounded-full ring-1 ring-black/40" style={{ backgroundColor: c.hex || '#444' }} />
            ))}
            {colors.length > 24 && <span className="text-xs leading-3 text-bambu-gray">+{colors.length - 24}</span>}
          </span>
        </summary>
        <div className="divide-y divide-bambu-dark-tertiary border-t border-bambu-dark-tertiary">
          {rows.map((r) => (
            <BrandRow
              key={r.tree.id}
              tree={r.tree}
              colors={r.colors}
              machine={machine}
              nozzle={nozzle}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      </details>
    </Card>
  );
}

/** The old grouped preset look on top of the trees: one card per material, one row per brand (tree). */
export function MaterialCards({ trees, targets, selected, onSelect, machine, nozzle, onLevel }: MaterialCardsProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [brand, setBrand] = useState('');
  // 0.2 is only offered when at least one filament prints with it
  const nozzles = trees.every(skips02) ? targets.nozzles.filter((n) => n !== '0.2') : targets.nozzles;
  const brands = useMemo(() => [...new Set(trees.map((tr) => tr.brand).filter(Boolean))].sort(), [trees]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byMaterial = new Map<string, { tree: FilamentTreeSummary; colors: FilamentTreeColor[] }[]>();
    for (const tree of [...trees].sort((a, b) => a.brand.localeCompare(b.brand))) {
      if (brand && tree.brand !== brand) continue;
      // a hit on the tree itself keeps every colour; otherwise only the matching colours
      const treeHit = !q || [tree.name, tree.brand, tree.material].some((v) => v.toLowerCase().includes(q));
      const colors = treeHit ? tree.colors : tree.colors.filter((c) => c.name.toLowerCase().includes(q));
      if (!treeHit && colors.length === 0) continue;
      const list = byMaterial.get(tree.material) ?? [];
      list.push({ tree, colors });
      byMaterial.set(tree.material, list);
    }
    return [...byMaterial].sort(([a], [b]) => a.localeCompare(b));
  }, [trees, brand, search]);

  return (
    <nav aria-label={t('filamentTrees.navLabel')} className="space-y-3">
      {/* one level picker for every card, pinned while the list scrolls */}
      <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-bambu-dark/95 px-1 py-2 backdrop-blur">
      <div className="relative w-full sm:max-w-[26rem]">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray/50" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('filamentProfiles.searchPlaceholder')}
          aria-label={t('filamentProfiles.searchPlaceholder')}
          className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2 pl-10 pr-3 text-sm text-white placeholder:text-bambu-gray/50 focus:border-bambu-green focus:outline-none"
        />
      </div>
      {brands.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={brand === ''} onClick={() => setBrand('')} className={pillCls(brand === '')}>
            {t('filamentProfiles.allBrands')}
          </button>
          {brands.map((b) => (
            <button key={b} type="button" aria-pressed={brand === b} onClick={() => setBrand(brand === b ? '' : b)} className={pillCls(brand === b)}>
              {b}
            </button>
          ))}
        </div>
      )}
        <Pills
          label={t('filamentTrees.machine')}
          all={t('filamentTrees.anyMachine')}
          options={targets.machines}
          value={machine}
          onChange={(v) => onLevel(v, '')}
        />
        {machine && (
          <Pills
            label={t('filamentTrees.nozzle')}
            all={t('filamentTrees.anyNozzle')}
            options={nozzles}
            value={nozzle}
            onChange={(v) => onLevel(machine, v)}
          />
        )}
      </div>
      {groups.length === 0 ? (
        <p className="py-6 text-center text-sm text-bambu-gray">{t('filamentProfiles.noResults')}</p>
      ) : (
        groups.map(([material, rows]) => (
          <MaterialCard key={material} material={material} rows={rows} machine={machine} nozzle={nozzle} selected={selected} onSelect={onSelect} />
        ))
      )}
    </nav>
  );
}
