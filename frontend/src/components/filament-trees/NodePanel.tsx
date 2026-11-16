import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, CopyPlus, History, Lock, Palette, Undo2 } from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import type { FilamentTreeNodeRow, FilamentTreeNodeUpdate, FilamentTreePresetValue, FilamentTreeSummary } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { Skeleton } from '../Skeleton';
import { BulkApplyModal } from './BulkApplyModal';
import { errorMessage } from './errorMessage';
import { HistoryTab } from './HistoryTab';
import { JsonView } from './JsonView';
import { DEPENDENCIES_ICON, keyLabel, MAPPED_KEYS, PA_KEY, TABS, type FieldSpec, type RowSpec, type SectionSpec } from './orcaLayout';
import { normalizePaK, readPaK, writePaK } from './paGcode';
import { TreeSettingsPanel } from './TreeSettingsPanel';

/** A tree node: root, machine, machine+nozzle, colour-wide (colour only) or leaf (machine+nozzle+colour). */
export type NodeRef = { treeId: number; machine?: string; nozzle?: string; colorId?: number };

/** Mirrors the backend's NOZZLE_BOUND_KEYS: refused at the root and colour-wide levels. */
const NOZZLE_BOUND_KEYS = new Set([
  'filament_max_volumetric_speed',
  'pressure_advance',
  'enable_pressure_advance',
  'filament_start_gcode',
]);
const TAB_STORAGE_KEY = 'fenrir.filamentTree.tab';
const ORANGE = 'text-orange-400';

const display = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
/** A Bambu value repeated per extruder variant (270, 270, 270) reads as one. */
const parentText = (v: unknown) => (Array.isArray(v) && new Set(v.map(String)).size === 1 ? String(v[0]) : display(v));
const first = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : display(v));

/** Text back into the stored Orca shape: arrays (and new values, which Orca stores as arrays) stay arrays. */
const parse = (text: string, original: unknown): FilamentTreePresetValue =>
  original === undefined || Array.isArray(original) ? [text] : text;

/** A "0"/"1" flag in the same shape as the stored value. */
const writeBool = (on: boolean, original: unknown): FilamentTreePresetValue => {
  const s = on ? '1' : '0';
  if (Array.isArray(original)) return original.length > 1 ? original.map(() => s) : [s];
  return original === undefined ? [s] : s;
};

const readTab = () => {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) ?? TABS[0].id;
  } catch {
    return TABS[0].id;
  }
};

const fieldCls =
  'h-8 w-full rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 text-sm text-white transition-[color,background-color,border-color,opacity] focus:border-bambu-green focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';

function ValueInput({ label, value, unit, multiline, disabled, own, onCommit }: {
  label: string;
  value: string;
  unit?: string;
  multiline?: boolean;
  disabled?: boolean;
  own?: boolean;
  onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline || value.includes('\n')) {
    return (
      <textarea
        aria-label={label}
        value={draft}
        disabled={disabled}
        rows={multiline ? Math.max(6, Math.min(16, value.split('\n').length + 1)) : Math.min(6, value.split('\n').length)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        spellCheck={false}
        className={`${fieldCls} h-auto py-1.5 font-mono text-xs ${own ? 'font-semibold' : ''}`}
      />
    );
  }
  return (
    <div className="relative w-[9.5rem] shrink-0">
      <input
        type="text"
        aria-label={label}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur()}
        className={`${fieldCls} ${unit ? 'pr-12' : ''} ${own ? 'font-semibold' : ''}`}
      />
      {unit && (
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-bambu-gray/60">{unit}</span>
      )}
    </div>
  );
}

/** Orca's modified-state marker: ↶ (own value, click = use parent) or a lock (inherited, tooltip names the source). */
function Marker({ row, label, canClear, resetText, sourceText, onClear }: {
  row?: FilamentTreeNodeRow;
  label: string;
  canClear: boolean;
  resetText: string;
  sourceText: string;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const box = 'flex h-6 w-6 shrink-0 items-center justify-center';
  if (!row) return <span className={box} />;
  if (!row.own) {
    return (
      <span role="img" aria-label={sourceText} title={sourceText} className={`${box} text-bambu-gray/50`}>
        <Lock className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (!canClear) {
    return (
      <span role="img" aria-label={resetText} title={resetText} className={`${box} ${ORANGE}`}>
        <Undo2 className="h-4 w-4" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={t('filamentTrees.useParentFor', { field: label })}
      title={resetText}
      className={`btn-press ${box} rounded ${ORANGE} hover:bg-orange-400/10 ${focusRingCls}`}
    >
      <Undo2 className="h-4 w-4" />
    </button>
  );
}

/** Settings of one tree node, laid out like OrcaSlicer's filament settings: tabs, titled sections, label / input rows. */
export function NodePanel({ node, onCreated }: { node: NodeRef; onCreated?: (treeId: number) => void }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  // Bumped per key when a save of that key fails, so only that key's inputs remount with the stored value.
  const [resets, setResets] = useState<Record<string, number>>({});
  const reset = (keys: string[]) =>
    setResets((prev) => Object.fromEntries([...Object.entries(prev), ...keys.map((k) => [k, (prev[k] ?? 0) + 1])]));
  const [tab, setTabState] = useState(readTab);
  const setTab = (id: string) => {
    setTabState(id);
    // Colours / History are about the filament: opening another node goes back to its values
    if (id === 'colours' || id === 'history') return;
    try {
      localStorage.setItem(TAB_STORAGE_KEY, id);
    } catch {
      // per-viewer convenience only
    }
  };
  // Setting Overrides rows ticked on with no value yet: the input opens, the first edit creates the own value.
  const [armed, setArmed] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const { treeId, machine, nozzle, colorId } = node;

  const { data: trees } = useQuery({ queryKey: ['filament-trees'], queryFn: api.getFilamentTrees });
  const rowsQuery = useQuery({
    queryKey: ['filament-trees', treeId, 'node', machine ?? null, nozzle ?? null, colorId ?? null],
    queryFn: () => api.getFilamentTreeNode(treeId, { machine, nozzle, colorId }),
  });

  const save = useMutation({
    mutationFn: (body: FilamentTreeNodeUpdate) =>
      api.setFilamentTreeNode(treeId, {
        ...(machine !== undefined && { machine }),
        ...(nozzle !== undefined && { nozzle }),
        ...(colorId !== undefined && { color_id: colorId }),
        ...body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['filament-trees'] }),
    onError: (err, body) => {
      reset([...Object.keys(body.set ?? {}), ...(body.clear ?? [])]);
      showToast(errorMessage(err), 'error');
    },
  });

  const tree: FilamentTreeSummary | undefined = trees?.find((tr) => tr.id === treeId);
  const color = tree?.colors.find((c) => c.id === colorId);
  const colourWide = machine === undefined && colorId !== undefined;
  const isSource =
    !!tree &&
    colorId === tree.source.color_id &&
    (colourWide || (machine === tree.source.machine && nozzle === tree.source.nozzle));
  const writable = !!tree && hasPermission('filaments:update') && !isSource;
  const nozzleLocked = machine === undefined;

  const colourWideName = t('filamentTrees.allMachines', { color: color?.name ?? '' });
  const crumbs = (colourWide ? [tree?.name, colourWideName] : [tree?.name, machine, nozzle, color?.name]).filter(
    (c) => c !== undefined,
  );

  const rows = rowsQuery.data ?? [];
  // the Bambu preset this node sits on (above the nozzle level: the calibration source's)
  const baseName = rows.find((r) => r.source_label)?.source_label;
  const bambuName = baseName ?? `Bambu ${machine ?? ''} ${nozzle ?? ''}`.trim();
  const sourceName = (source: string | null | undefined): string =>
    ({
      root: tree?.name ?? '',
      machine: machine ?? '',
      nozzle: `${machine} › ${nozzle}`,
      colorwide: colourWideName,
      color: color?.name ?? '',
      bambu: bambuName,
    })[source ?? ''] ?? '';
  const sourceText = (row: FilamentTreeNodeRow) =>
    row.source === 'bambu'
      ? row.source_label
        ? t('filamentTrees.from', { source: row.source_label })
        : t('filamentTrees.fromBambu', { machine, nozzle })
      : t('filamentTrees.from', { source: sourceName(row.source) });
  const resetText = (row: FilamentTreeNodeRow) =>
    row.inherited_value == null
      ? t('filamentTrees.orca.resetEmpty')
      : t('filamentTrees.orca.resetTo', { value: display(row.inherited_value), source: sourceName(row.inherited_source) });

  const byKey = new Map(rows.map((r) => [r.key, r]));
  const modified = rows.filter((r) => r.own).length;
  const gcodeRow = byKey.get(PA_KEY);
  const gcodeText = first(gcodeRow?.value);
  const savePa = (input: string) => {
    const k = normalizePaK(input);
    if (k === null) {
      reset([PA_KEY]);
      showToast(t('filamentTrees.paInvalid'), 'error');
      return;
    }
    const old = gcodeRow?.value;
    const next = Array.isArray(old)
      ? old.map((g) => writePaK(String(g), k))
      : old == null
        ? [writePaK('', k)]
        : writePaK(String(old), k);
    save.mutate({ set: { [PA_KEY]: next } });
  };
  const set = (key: string, value: FilamentTreePresetValue) => save.mutate({ set: { [key]: value } });

  const renderField = (field: FieldSpec, label: string, enabled: boolean) => {
    const row = byKey.get(field.key);
    const tick = resets[field.key] ?? 0;
    const bound = nozzleLocked && NOZZLE_BOUND_KEYS.has(field.key);
    const editable = writable && enabled && !bound && field.kind !== 'readonly' && field.kind !== 'colour';
    const marker = (
      <Marker
        row={row}
        label={label}
        canClear={writable && !bound && field.kind !== 'pa'}
        resetText={row ? resetText(row) : ''}
        sourceText={row ? sourceText(row) : ''}
        onClear={() => save.mutate({ clear: [field.key] })}
      />
    );
    const hint = bound ? (
      <span className="text-[11px] text-bambu-gray/60">{t('filamentTrees.orca.nozzleBound')}</span>
    ) : field.kind === 'colour' ? (
      <span className="text-[11px] text-bambu-gray/60">{t('filamentTrees.orca.colourFromTree')}</span>
    ) : row?.own && field.kind !== 'gcode' ? (
      <span className="shrink-0 whitespace-nowrap text-[11px] text-bambu-gray/60" title={resetText(row)}>
        {row.inherited_value == null
          ? t('filamentTrees.parentBambu')
          : t('filamentTrees.parentValue', {
              value: field.kind === 'pa' ? readPaK(first(row.inherited_value)) : parentText(row.inherited_value),
            })}
      </span>
    ) : null;
    const elements = Array.isArray(row?.value) && row.value.length > 1 ? (row.value as Array<string | number>) : null;

    let control;
    if (field.key === 'filament_vendor') {
      // Orca's vendor is the tree's brand: editing it renames the tree and its profiles
      const brand = tree?.brand ?? '';
      control = (
        <ValueInput
          key={`${brand}:${tick}`}
          label={label}
          value={brand}
          disabled={!writable}
          onCommit={(next) =>
            next.trim()
              ? api
                  .updateFilamentTree(treeId, { brand: next.trim() })
                  .then(() => queryClient.invalidateQueries({ queryKey: ['filament-trees'] }))
                  .catch((err) => {
                    reset([field.key]);
                    showToast(errorMessage(err), 'error');
                  })
              : reset([field.key])
          }
        />
      );
    } else if (field.kind === 'pa') {
      control = (
        <ValueInput
          key={`${gcodeText}:${tick}`}
          label={t('filamentTrees.paK')}
          value={readPaK(gcodeText)}
          disabled={!editable}
          own={row?.own}
          onCommit={savePa}
        />
      );
    } else if (field.kind === 'colour') {
      const hex = first(row?.value) || color?.hex || '';
      control = (
        <span
          role="img"
          aria-label={`${label} ${hex}`}
          title={hex}
          className="h-6 w-[9.5rem] rounded border border-bambu-dark-tertiary"
          style={{ backgroundColor: /^#[0-9a-f]{3,8}$/i.test(hex) ? hex : 'transparent' }}
        />
      );
    } else if (field.kind === 'bool') {
      control = (
        <input
          type="checkbox"
          aria-label={label}
          checked={first(row?.value) === '1' || first(row?.value) === 'true'}
          disabled={!editable}
          onChange={(e) => set(field.key, writeBool(e.target.checked, row?.value))}
          className="h-4 w-4 accent-bambu-green disabled:opacity-50"
        />
      );
    } else if (elements) {
      control = (
        <div className="flex w-full min-w-0 flex-col gap-1">
          {elements.map((el, i) => (
            <div key={`${i}:${String(el)}:${tick}`} className="flex min-w-0 items-center gap-2">
              <ValueInput
                label={`${label} ${i + 1}`}
                value={String(el)}
                unit={field.unit}
                multiline={field.kind === 'gcode'}
                disabled={!editable}
                own={row?.own}
                onCommit={(next) => set(field.key, elements.map((v, j) => (j === i ? next : v)))}
              />
              {row?.variants?.[i] && (
                <span className="whitespace-nowrap text-[11px] text-bambu-gray/60">{row.variants[i]}</span>
              )}
            </div>
          ))}
        </div>
      );
    } else if (field.options) {
      const value = first(row?.value);
      const options = value && !field.options.includes(value) ? [value, ...field.options] : field.options;
      control = (
        <select
          key={`${value}:${tick}`}
          aria-label={label}
          value={value}
          disabled={!editable}
          onChange={(e) => set(field.key, parse(e.target.value, row?.value))}
          className={`${fieldCls} w-[9.5rem] ${row?.own ? 'font-semibold' : ''}`}
        >
          {!value && <option value="" />}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    } else {
      const text = display(row?.value);
      control = (
        <ValueInput
          key={`${text}:${tick}`}
          label={label}
          value={text}
          unit={field.unit}
          multiline={field.kind === 'gcode'}
          disabled={!editable}
          own={row?.own}
          onCommit={(next) => set(field.key, parse(next, row?.value))}
        />
      );
    }
    return (
      <div key={field.key} className={`flex min-w-0 gap-1.5 ${field.kind === 'gcode' ? 'w-full items-start' : 'items-center'}`}>
        {field.caption && <span className="w-[5.5rem] shrink-0 text-xs text-bambu-gray/70">{t(field.caption)}</span>}
        {marker}
        {control}
        {hint}
      </div>
    );
  };

  const renderRow = (spec: RowSpec, override: boolean) => {
    const label = t(spec.label);
    const own = spec.fields.some((f) => byKey.get(f.key)?.own);
    const key = spec.fields[0].key;
    const row = byKey.get(key);
    const gcode = spec.fields[0].kind === 'gcode';
    // Setting Overrides: ticked ⇔ a value exists here or above; unticking clears an own value, inherited ones can't be unticked here.
    const ticked = !!row || armed.has(key);
    const toggle = (on: boolean) => {
      if (on) setArmed((prev) => new Set(prev).add(key));
      else if (row?.own) save.mutate({ clear: [key] });
      else setArmed((prev) => new Set([...prev].filter((k) => k !== key)));
    };
    const fieldLabel = (f: FieldSpec) => (f.caption ? `${label} (${t(f.caption)})` : label);
    return (
      <div
        key={spec.label + key}
        className={`grid grid-cols-1 items-center gap-x-3 gap-y-1 py-1 ${gcode ? '' : 'sm:grid-cols-[14rem_minmax(0,1fr)]'}`}
      >
        {!gcode && (
          <div className="flex min-w-0 items-center gap-2" title={spec.fields.map((f) => f.key).join(', ')}>
            {override && (
              <input
                type="checkbox"
                aria-label={t('filamentTrees.orca.overrideFor', { field: label })}
                title={row && !row.own ? sourceText(row) : undefined}
                checked={ticked}
                disabled={!writable || (!!row && !row.own)}
                onChange={(e) => toggle(e.target.checked)}
                className="h-4 w-4 shrink-0 accent-bambu-green disabled:opacity-50"
              />
            )}
            <span className={`text-sm transition-colors ${own ? `${ORANGE} font-medium` : 'text-bambu-gray-light'}`}>{label}</span>
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1">
          {spec.fields.map((f) => renderField(f, fieldLabel(f), !override || ticked))}
        </div>
      </div>
    );
  };

  const renderSection = (s: Pick<SectionSpec, 'title' | 'icon'>, body: ReactNode, key: string) => {
    const Icon = s.icon;
    return (
      <section key={key} className="min-w-0">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-white">
          <Icon className="h-4 w-4 shrink-0 text-bambu-gray" aria-hidden />
          <span className="shrink-0">{t(s.title)}</span>
          <span className="h-px flex-1 bg-bambu-dark-tertiary" />
        </h3>
        <div className="pl-1">{body}</div>
      </section>
    );
  };

  const jsonTab = tab === 'json';
  // right-hand tabs about the filament itself rather than this node's values
  const extraTab = tab === 'colours' || tab === 'history' ? tab : null;
  const sideTab = (id: string, label: string, icon: ReactNode, first: boolean) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`-mb-px ${first ? 'ml-auto' : ''} flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-0.5 pb-1.5 text-sm transition-colors ${focusRingCls} ${
        tab === id ? 'border-bambu-green font-semibold text-white' : 'border-transparent text-bambu-gray hover:text-bambu-gray-light'
      }`}
    >
      {icon}
      {label}
    </button>
  );
  const activeTab = TABS.find((x) => x.id === tab) ?? TABS[0];
  const otherRows = rows.filter((r) => !MAPPED_KEYS.has(r.key));

  const tabBody = () => {
    if (activeTab.id === 'dependencies') {
      const readRow = (label: string, value: string) => (
        <div className="grid grid-cols-1 gap-x-3 py-1 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <span className="text-sm text-bambu-gray-light">{label}</span>
          <span className="break-words text-sm text-white">{value}</span>
        </div>
      );
      return renderSection(
        { title: 'filamentTrees.orca.tabDependencies', icon: DEPENDENCIES_ICON },
        <>
          {readRow(t('filamentProfiles.basePresetLabel'), baseName ?? '—')}
          {readRow(
            t('filamentTrees.orca.compatPrinters'),
            machine && nozzle ? t('filamentTrees.orca.compatibleLeaf', { machine, nozzle }) : t('filamentTrees.orca.everyTarget'),
          )}
        </>,
        'deps',
      );
    }
    const sections = activeTab.sections
      .filter((s) => !s.ifPresent || s.rows.some((r) => r.fields.some((f) => byKey.has(f.key))))
      .map((s) => renderSection(s, s.rows.map((r) => renderRow(r, !!s.override)), s.title));
    if (activeTab.id === 'advanced' && otherRows.length > 0) {
      sections.push(
        renderSection(
          { title: 'filamentTrees.orca.other', icon: activeTab.sections[0].icon },
          otherRows.map((r) => renderRow({ label: r.key, fields: [{ key: r.key }] }, false)),
          'other',
        ),
      );
    }
    return sections;
  };

  return (
    <section className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2">
        {color && <span className="h-4 w-4 shrink-0 rounded-sm" style={{ backgroundColor: color.hex }} aria-hidden />}
        <nav aria-label={t('filamentTrees.path')} className="min-w-0 flex-1 truncate text-sm font-medium text-white">
          {crumbs.join(' › ')}
        </nav>
        {modified > 0 && (
          // unfolds on the first override so the breadcrumb narrows instead of snapping
          <span className="aito-unfold-x shrink-0">
            <span className="flex items-center gap-2">
              <span className={`shrink-0 text-xs ${ORANGE}`}>{t('filamentTrees.orca.modified', { count: modified })}</span>
              {colorId === undefined && writable && (trees?.length ?? 0) > 1 && (
                <button
                  type="button"
                  onClick={() => setBulkOpen(true)}
                  className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-bambu-gray-light hover:bg-white/5 hover:text-white ${focusRingCls}`}
                >
                  <CopyPlus className="h-3.5 w-3.5" />
                  {t('filamentTrees.applyToOthers')}
                </button>
              )}
            </span>
          </span>
        )}
      </div>
      {isSource && <p className="text-sm text-sky-300">{t('filamentTrees.sourceReadOnly')}</p>}
      <div role="tablist" aria-label={t('filamentTrees.orca.tabs')} className="flex gap-4 overflow-x-auto border-b border-bambu-dark-tertiary">
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={!jsonTab && !extraTab && x.id === activeTab.id}
            onClick={() => setTab(x.id)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-0.5 pb-1.5 text-sm transition-colors ${focusRingCls} ${
              !jsonTab && !extraTab && x.id === activeTab.id
                ? 'border-bambu-green font-semibold text-white'
                : 'border-transparent text-bambu-gray hover:text-bambu-gray-light'
            }`}
          >
            {t(x.label)}
          </button>
        ))}
        {sideTab('colours', t('filamentTrees.colours'), <Palette className="h-3.5 w-3.5" />, true)}
        {sideTab('history', t('filamentTrees.history'), <History className="h-3.5 w-3.5" />, false)}
        <button
          type="button"
          role="tab"
          aria-selected={jsonTab}
          onClick={() => setTab('json')}
          className={`-mb-px flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-0.5 pb-1.5 font-mono text-sm transition-colors ${focusRingCls} ${
            jsonTab ? 'border-bambu-green font-semibold text-white' : 'border-transparent text-bambu-gray hover:text-bambu-gray-light'
          }`}
        >
          <Braces className="h-3.5 w-3.5" />
          JSON
        </button>
      </div>
      {extraTab && tree ? (
        <div role="tabpanel" aria-label={t(`filamentTrees.${extraTab}`)} className="min-w-0">
          {extraTab === 'colours' ? <TreeSettingsPanel tree={tree} onCreated={onCreated} /> : <HistoryTab tree={tree} />}
        </div>
      ) : rowsQuery.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {[...Array(8)].map((_, i) => (
            <Skeleton key={i} className="h-8 rounded" />
          ))}
        </div>
      ) : rowsQuery.isError ? (
        <p className="text-sm text-red-400">{errorMessage(rowsQuery.error)}</p>
      ) : jsonTab ? (
        <div role="tabpanel" aria-label="JSON" className="min-w-0">
          <JsonView
            rows={rows}
            leafName={tree && color && machine && nozzle ? `${tree.name} - ${color.name} @${machine} ${nozzle}` : undefined}
          />
        </div>
      ) : (
        <div role="tabpanel" aria-label={t(activeTab.label)} className="min-w-0 space-y-4">
          {tabBody()}
        </div>
      )}
      {bulkOpen && tree && trees && (
        <BulkApplyModal
          tree={tree}
          trees={trees}
          machine={machine}
          nozzle={nozzle}
          rows={rows.filter((r) => r.own)}
          label={(key) => keyLabel(t, key)}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </section>
  );
}
