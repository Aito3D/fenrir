import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCw, X } from 'lucide-react';

import { api } from '../../api/client';
import type { BaseFilamentPreset, FilamentPreset, FilamentPresetPayload } from '../../api/client';
import { Button } from '../Button';
import { SearchableSelect } from '../SearchableSelect';
import type { SearchableSelectOption } from '../SearchableSelect';
import { useToast } from '../../contexts/ToastContext';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import {
  DEFAULT_COMPATIBLE_PRINTERS,
  EXTRUDER_VARIANTS,
  MATERIAL_OPTIONS,
  NOZZLE_SIZES,
  QUICK_ADD_MODELS,
  VENDORS,
} from './constants';
import {
  buildJson,
  buildResolvedParent,
  computeName,
  displayColorLabel,
  mergeWithParent,
  parseContentToForm,
  parseNozzleFromName,
  rewriteCompatibleForNozzle,
} from './presetJson';
import type { PresetForm } from './types';
import { Field, NumberInput, SectionDivider, TextInput } from './editorFields';
import { TagInput } from './TagInput';
import { EditorTabTemps } from './EditorTabTemps';
import { EditorTabCooling } from './EditorTabCooling';
import { EditorTabExtrusion } from './EditorTabExtrusion';
import { EditorTabRetract } from './EditorTabRetract';

export interface PresetEditorModalProps {
  preset: FilamentPreset | null;
  presets: FilamentPreset[];
  basePresets: BaseFilamentPreset[];
  extraMaterials: string[];
  onSave: (payload: FilamentPresetPayload) => Promise<void>;
  onDelete: (() => void) | null;
  onClose: () => void;
  /** Gates the Save/Create button on the permission its own endpoint
   *  enforces (`filaments:create` when creating, `filaments:update` when
   *  editing) — defaults to true so any caller that doesn't pass it keeps
   *  today's behavior. */
  canSave?: boolean;
  /** Fired whenever the modal's own dirty flag changes (T-032). The page
   *  uses this to freeze the modal's remount key for as long as there are
   *  unsaved edits, so a background refetch that bumps `updated_at` (e.g.
   *  another operator's sync) can't silently discard them by remounting. */
  onDirtyChange?: (dirty: boolean) => void;
}

type Tab = 'general' | 'temps' | 'cooling' | 'extrusion' | 'retract' | 'json';

const TABS: { id: Tab; labelKey: string }[] = [
  { id: 'general', labelKey: 'filamentProfiles.tabGeneral' },
  { id: 'temps', labelKey: 'filamentProfiles.tabTemps' },
  { id: 'cooling', labelKey: 'filamentProfiles.tabCooling' },
  { id: 'extrusion', labelKey: 'filamentProfiles.tabExtrusion' },
  { id: 'retract', labelKey: 'filamentProfiles.tabRetract' },
  { id: 'json', labelKey: 'filamentProfiles.tabJson' },
];

/** Resolution status of the header's "↳ parent" line / base-preset panel. */
type ParentStatus = 'idle' | 'resolving' | 'found' | 'not-found';

function parseBaseData(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Derives the editor's `baseData`/`form` from a preset (or `null` for
 *  create mode). Used both for the initial mount and — for T-032's "reload"
 *  action — to re-derive them from a fresher server copy without remounting
 *  the whole modal, so it stays in exact lockstep with the mount-time logic. */
function buildFormFromPreset(preset: FilamentPreset | null): { baseData: Record<string, unknown>; form: PresetForm } {
  const baseData = parseBaseData(preset?.content);
  // Not the raw stored `color`: presets imported before the label was
  // derived have it empty, and their label lives in the name ("eSUN PETG -
  // Green"). displayColorLabel prefers the stored value when set, so a
  // hand-edited label is never overridden — and saving writes the derived
  // one back, healing the row.
  let form = parseContentToForm(baseData, preset ? displayColorLabel(preset.name, preset.color) : undefined);
  if (preset) {
    const nozzle = parseNozzleFromName(preset.name);
    if (nozzle !== null) form = { ...form, nozzle_size: nozzle };
  } else {
    form = { ...form, compatible_printers: DEFAULT_COMPATIBLE_PRINTERS };
  }
  return { baseData, form };
}

const BRAND_ID = 'fp-editor-brand';

/**
 * The preset editor (spec §6): a fixed-height modal with header / tab bar /
 * scrollable content / footer. General (§7.1), Temps/Cooling/Extrusion/
 * Retract (§7.2/§7.4-7.6), and the bidirectional JSON tab (§7.7) are
 * implemented here (the middle four delegate to their own EditorTab*
 * components).
 */
export function PresetEditorModal({
  preset,
  presets,
  basePresets,
  extraMaterials,
  onSave,
  onDelete,
  onClose,
  canSave = true,
  onDirtyChange,
}: PresetEditorModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const isCreate = preset === null;

  const [baseData, setBaseData] = useState<Record<string, unknown>>(() => buildFormFromPreset(preset).baseData);
  const [form, setForm] = useState<PresetForm>(() => buildFormFromPreset(preset).form);

  const [resolvedParent, setResolvedParent] = useState<PresetForm | null>(null);
  const [parentStatus, setParentStatus] = useState<ParentStatus>('idle');
  // The create-mode base-preset picker's own selection, e.g. "user:Name" /
  // "base:Name" — kept separate from `form.inherits` (a bare name) so the
  // SearchableSelect always has a value matching one of its own options.
  const [selectedBase, setSelectedBase] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('general');
  // Regenerated from the form on entering the JSON tab; re-parsed on every
  // keystroke (spec §7.7 — bidirectional JSON tab).
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState(false);
  const [saving, setSaving] = useState(false);

  // "Material Sheet" design state. `dirty` is an explicit user-edit flag, not
  // a form diff: the mount-time inherits merge and the JSON-tab regeneration
  // both rewrite `form` without the user having touched anything, and a diff
  // against an initial snapshot would count those as edits. Every USER-facing
  // change goes through `editForm`; programmatic writes keep plain `setForm`.
  const [dirty, setDirty] = useState(false);
  const editForm: typeof setForm = (updater) => {
    setDirty(true);
    setForm(updater);
  };
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // T-032: a background refetch (another operator's sync, or React Query's
  // refetchOnWindowFocus) can bump `preset.updated_at` while this instance
  // is still mounted — the page freezes our remount key while `dirty` so
  // that no longer blows away in-progress edits (T-006's fix, kept for the
  // non-dirty case only). Instead, track the `updated_at` our fields were
  // last derived from; if it moves while the user has unsaved edits, show a
  // banner instead of silently keeping (or silently adopting) either copy.
  const syncedUpdatedAtRef = useRef<string | undefined>(preset?.updated_at);
  const [serverConflict, setServerConflict] = useState(false);
  useEffect(() => {
    if (!preset) return;
    if (!dirty) {
      // Clean editor: the page's live remount key already guarantees a
      // fresh `preset` here means a brand-new instance (T-006), so this
      // just keeps the ref in step for if/when the user starts typing.
      syncedUpdatedAtRef.current = preset.updated_at;
      return;
    }
    if (preset.updated_at !== syncedUpdatedAtRef.current) {
      setServerConflict(true);
    }
  }, [preset, dirty]);

  // Ink bar under the active tab: measured from the real button, so it fits
  // each label in every locale. Direction of the pane slide comes from
  // whether the user moved left or right in the tab row.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);
  const [paneDir, setPaneDir] = useState(14);
  useEffect(() => {
    const el = tabRefs.current[TABS.findIndex((tab) => tab.id === activeTab)];
    if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeTab]);

  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: 220,
    // Escape must respect the same in-flight-save guard as the Cancel button
    // and the overlay click — bypassing it let Escape close (and discard)
    // the modal mid-save.
    onEscape: (doRequestClose) => {
      if (saving) return;
      doRequestClose();
    },
  });

  const fetchBaseContent = (filename: string) => api.getBaseFilamentPresetContent(filename).then((r) => r.content);

  const resolveInherits = async (name: string, mergeOnto: (parent: PresetForm) => void) => {
    setParentStatus('resolving');
    try {
      const parent = await buildResolvedParent(name, presets, basePresets, fetchBaseContent);
      setResolvedParent(parent);
      setParentStatus(parent ? 'found' : 'not-found');
      if (parent) mergeOnto(parent);
    } catch {
      // Defensive: buildResolvedParent already swallows fetch/parse failures
      // internally, but a stuck 'resolving' state (Reload spinning forever)
      // is worse than surfacing this the same way as an unresolvable chain.
      setResolvedParent(null);
      setParentStatus('not-found');
    }
  };

  // Mount: focus the dialog itself, and resolve an existing `inherits`
  // immediately. NOT the Brand field: SearchableSelect opens its dropdown on
  // focus (deliberately — a click or Tab into it should open it), so focusing
  // it programmatically popped the brand list over a freshly opened editor
  // before the user touched anything. The dialog has tabIndex={-1} exactly so
  // it can take this initial focus; keyboard users reach Brand with one Tab.
  useEffect(() => {
    dialogRef.current?.focus();
    if (form.inherits) {
      void resolveInherits(form.inherits, (parent) => setForm((f) => mergeWithParent(f, parent)));
    }
    // Mount-once — `form.inherits` here is only ever the initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReload = () => {
    if (!form.inherits) return;
    void resolveInherits(form.inherits, (parent) => setForm((f) => mergeWithParent(f, parent)));
  };

  // T-032's banner action: discard the in-progress edit and adopt the fresh
  // server copy `preset` already holds (the page always passes the latest
  // query data, independent of the frozen remount key). Reuses the exact
  // derivation the initial mount uses so the two never drift apart.
  const handleReloadFromServer = () => {
    if (!preset) return;
    const next = buildFormFromPreset(preset);
    setBaseData(next.baseData);
    setForm(next.form);
    setRawJson('');
    setJsonError(false);
    setResolvedParent(null);
    setParentStatus('idle');
    syncedUpdatedAtRef.current = preset.updated_at;
    setServerConflict(false);
    setDirty(false);
    if (next.form.inherits) {
      void resolveInherits(next.form.inherits, (parent) => setForm((f) => mergeWithParent(f, parent)));
    }
  };

  const basePresetOptions = useMemo<SearchableSelectOption[]>(() => {
    const seen = new Set<string>();
    const options: SearchableSelectOption[] = [{ value: '', label: t('filamentProfiles.basePresetNone') }];
    // User presets first — they shadow a same-named base preset (spec §9.12).
    for (const p of presets) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      options.push({ value: `user:${p.name}`, label: `${t('filamentProfiles.basePresetMine')}: ${p.name}` });
    }
    for (const b of basePresets) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      options.push({ value: `base:${b.name}`, label: `${t('filamentProfiles.basePresetBase')}: ${b.name}` });
    }
    return options;
  }, [presets, basePresets, t]);

  const handleBasePresetSelect = (selection: string) => {
    setSelectedBase(selection);
    setDirty(true);
    if (selection === '') {
      setForm((f) => ({ ...f, inherits: '' }));
      setResolvedParent(null);
      setParentStatus('idle');
      return;
    }
    const name = selection.slice(selection.indexOf(':') + 1);
    setForm((f) => ({ ...f, inherits: name }));
    void resolveInherits(name, (parent) => setForm((f) => mergeWithParent(f, parent)));
  };

  const materialOptions = useMemo<SearchableSelectOption[]>(() => {
    const set = new Set<string>([...MATERIAL_OPTIONS, ...extraMaterials]);
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((m) => ({ value: m, label: m }));
  }, [extraMaterials]);

  const vendorOptions = useMemo<SearchableSelectOption[]>(() => VENDORS.map((v) => ({ value: v, label: v })), []);

  const computedName = computeName(form.filament_vendor.trim(), form.filament_type.trim(), form.color.trim());

  const handleNozzleChange = (size: string) => {
    editForm((f) => ({
      ...f,
      nozzle_size: size,
      compatible_printers: rewriteCompatibleForNozzle(f.compatible_printers, size),
    }));
  };

  const handlePaKChange = (v: string) => {
    editForm((f) => ({
      ...f,
      pa_k_value: v,
      filament_start_gcode: v ? `M900 L1000 M10\nM900 K${v}` : '',
    }));
  };

  const toggleExtruderVariant = (variant: string) => {
    editForm((f) => ({
      ...f,
      filament_extruder_variant: f.filament_extruder_variant.includes(variant)
        ? f.filament_extruder_variant.filter((v) => v !== variant)
        : [...f.filament_extruder_variant, variant],
    }));
  };

  const handleQuickAdd = () => {
    editForm((f) => {
      const current = f.compatible_printers
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const additions = QUICK_ADD_MODELS.map((model) => `Bambu Lab ${model} ${f.nozzle_size} nozzle`).filter(
        (tag) => !current.includes(tag),
      );
      if (additions.length === 0) return f;
      return { ...f, compatible_printers: [...current, ...additions].join(', ') };
    });
  };

  const handleDismiss = () => {
    if (saving) return;
    requestClose();
  };

  const handleDeleteClick = () => {
    if (saving) return;
    requestClose();
    onDelete?.();
  };

  const handleTabClick = (tab: Tab) => {
    if (tab === 'json' && activeTab !== 'json') {
      setRawJson(buildJson(form, baseData, resolvedParent, computedName));
      setJsonError(false);
    }
    const from = TABS.findIndex((t2) => t2.id === activeTab);
    const to = TABS.findIndex((t2) => t2.id === tab);
    setPaneDir(to >= from ? 14 : -14);
    setActiveTab(tab);
  };

  const handleRawJsonChange = (text: string) => {
    setRawJson(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      setJsonError(false);
      const parsedObject = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      setBaseData(parsedObject);
      editForm((f) => ({ ...parseContentToForm(parsedObject, f.color), nozzle_size: f.nozzle_size }));
    } catch {
      setJsonError(true);
      // Leave form/baseData untouched — an in-progress edit shouldn't blow
      // away the last-known-good state.
    }
  };

  const handleSave = async () => {
    // Before the JSON tab has ever been entered, `rawJson` is '' and must
    // never be sent as the saved content.
    const content =
      activeTab === 'json' && rawJson !== '' ? rawJson : buildJson(form, baseData, resolvedParent, computedName);
    let material = form.filament_type.trim();
    if (!material) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        const ft = parsed.filament_type;
        if (Array.isArray(ft) && typeof ft[0] === 'string') material = ft[0];
      } catch {
        // content didn't parse — material falls back to '', same as an
        // unresolvable Raw JSON edit; jsonError already gates Save there.
      }
    }
    const payload: FilamentPresetPayload = {
      name: computedName,
      brand: form.filament_vendor.trim(),
      material,
      color: form.color.trim(),
      color_hex: form.default_filament_colour,
      filename: `${computedName}.json`,
      content,
    };
    setSaving(true);
    try {
      await onSave(payload);
      requestClose();
    } catch (err) {
      // Surface the failure ourselves — the page's onSave only performs the
      // API call and query invalidation, it doesn't toast — and stay open
      // so nothing is lost.
      const message = err instanceof Error ? err.message : String(err);
      showToast(t('filamentProfiles.saveFailed', { error: message }), 'error');
    } finally {
      setSaving(false);
    }
  };

  const filename = computedName ? `${computedName}.json` : (preset?.filename ?? '');

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 ${
        closing ? 'animate-overlay-out' : 'animate-overlay-in'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleDismiss();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={computedName || t(isCreate ? 'filamentProfiles.editorNewTitle' : 'filamentProfiles.editorEditTitle')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl focus:outline-none sm:flex-row ${
          closing ? 'opacity-0 transition-opacity duration-200' : 'animate-modal-in'
        }`}
      >
        {/* Identity rail ("Material Sheet" design): the filament itself is the
            modal's spine. The material band and spool coin are painted with the
            live picker colour, and the identity fields — the ones that name the
            preset — live here rather than in a tab, so the name being assembled
            and the fields assembling it sit together. On phones the rail
            becomes a compact header block above the tabs. */}
        <div className="flex max-h-[42%] flex-none flex-col border-b border-bambu-dark-tertiary bg-bambu-dark sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r">
          <div
            className="relative h-10 flex-none sm:h-28"
            style={{
              backgroundColor: form.default_filament_colour || 'var(--color-bambu-dark-tertiary)',
              backgroundImage:
                'linear-gradient(120deg, rgba(255,255,255,.22), rgba(255,255,255,0) 42%), linear-gradient(0deg, rgba(0,0,0,.28), rgba(0,0,0,0) 55%)',
            }}
          >
            <span
              className="absolute -bottom-6 right-4 hidden h-14 w-14 rounded-full border-4 border-bambu-dark shadow-lg sm:block"
              style={{
                backgroundColor: form.default_filament_colour || 'var(--color-bambu-dark-tertiary)',
                backgroundImage: 'radial-gradient(circle at 35% 30%, rgba(255,255,255,.35), rgba(255,255,255,0) 45%)',
              }}
            />
          </div>
          <div className="px-4 pb-1 pt-3 sm:pt-5">
            {form.filament_vendor !== '' && (
              <div className="text-[10.5px] font-bold uppercase tracking-widest text-bambu-gray/70">
                {form.filament_vendor}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-lg font-bold leading-snug tracking-tight text-white">
                {computedName || t(isCreate ? 'filamentProfiles.editorNewTitle' : 'filamentProfiles.editorEditTitle')}
              </h2>
              {form.filament_type !== '' && (
                <span className="rounded-full bg-bambu-dark-tertiary px-2 py-0.5 font-mono text-xs text-bambu-gray-light">
                  {form.filament_type}
                </span>
              )}
            </div>
          </div>
          {form.inherits !== '' && (
            <div className="mx-4 mt-2 flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2.5 py-2 text-xs">
              <span
                className={`min-w-0 truncate ${
                  parentStatus === 'resolving'
                    ? 'animate-pulse text-bambu-gray'
                    : parentStatus === 'found'
                      ? 'text-bambu-green'
                      : 'text-bambu-gray'
                }`}
              >
                ↳ {form.inherits}
                {parentStatus === 'not-found' && (
                  <span className="ml-1 text-amber-400">{t('filamentProfiles.inheritsNotFound')}</span>
                )}
              </span>
              <button
                type="button"
                onClick={handleReload}
                aria-label={t('filamentProfiles.reload')}
                className="ml-auto shrink-0 rounded p-0.5 text-bambu-gray/60 hover:text-white"
              >
                <RotateCw className={`h-3 w-3 ${parentStatus === 'resolving' ? 'animate-spin' : ''}`} />
              </button>
            </div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto p-4 sm:grid-cols-1">
            <Field label={t('filamentProfiles.brand')}>
              <SearchableSelect
                id={BRAND_ID}
                value={form.filament_vendor}
                onChange={(v) => editForm((f) => ({ ...f, filament_vendor: v }))}
                options={vendorOptions}
                allowCustom={false}
                placeholderKey="filamentProfiles.brandSelect"
              />
            </Field>
            <Field label={t('filamentProfiles.colorLabel')}>
              <TextInput
                value={form.color}
                onChange={(v) => editForm((f) => ({ ...f, color: v }))}
                placeholder={t('filamentProfiles.colorPlaceholder')}
              />
            </Field>
            <Field label={t('filamentProfiles.filamentColour')}>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(form.default_filament_colour) ? form.default_filament_colour : '#000000'}
                  onChange={(e) => editForm((f) => ({ ...f, default_filament_colour: e.target.value }))}
                  aria-label={t('filamentProfiles.filamentColour')}
                  className="h-9 w-9 shrink-0 cursor-pointer rounded border border-bambu-dark-tertiary bg-transparent p-0.5"
                />
                <TextInput
                  value={form.default_filament_colour}
                  onChange={(v) => editForm((f) => ({ ...f, default_filament_colour: v }))}
                  placeholder="#RRGGBB"
                />
              </div>
            </Field>
            <Field label={t('filamentProfiles.cost')} unit="€/kg">
              <NumberInput
                value={form.filament_cost}
                onChange={(v) => editForm((f) => ({ ...f, filament_cost: v }))}
              />
            </Field>
          </div>
        </div>

        {/* Main column: tabs, content, footer */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={t('filamentProfiles.close')}
            className="absolute right-3 top-7 z-10 shrink-0 rounded p-1 text-bambu-gray/60 hover:bg-bambu-dark-tertiary hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>

        {/* Tab bar with a sliding ink underline — measured from the active
            button so it fits any locale's label; the same slightly
            overshooting curve as the pane slide (see index.css .fp-ink). */}
        {/* pt-6 and the close button's top-7 move together on purpose: the X is
            centred on the tab row (X centre = top + 12.6px, tab centre = pt +
            16.2px at this app's 14.4px root rem), so changing one alone knocks
            them out of alignment. At pt-6 that puts both centres at 37.8px. */}
        <div className="relative flex gap-1 border-b border-bambu-dark-tertiary px-5 pr-12 pt-6">
          {TABS.map((tab, i) => (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              onClick={() => handleTabClick(tab.id)}
              aria-current={activeTab === tab.id}
              className={`rounded-t-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id ? 'text-white' : 'text-bambu-gray hover:text-white'
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
          {ink && (
            <span
              aria-hidden="true"
              className="fp-ink absolute bottom-0 h-0.5 rounded-t bg-bambu-green"
              style={{ left: ink.left, width: ink.width }}
            />
          )}
        </div>

        {/* T-032: dirty edits are never silently discarded, but a change
            landing on the server underneath them can't be silently ignored
            either — surface it and let the user choose. */}
        {serverConflict && (
          <div
            role="alert"
            className="flex flex-none items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-5 py-2 text-xs text-amber-200"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{t('filamentProfiles.serverChangedBanner')}</span>
            </span>
            <button
              type="button"
              onClick={handleReloadFromServer}
              className="shrink-0 rounded px-2 py-1 font-semibold text-amber-100 underline decoration-amber-300/60 underline-offset-2 hover:text-white"
            >
              {t('filamentProfiles.serverChangedReload')}
            </button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div key={activeTab} className="fp-pane-in h-full" style={{ '--fp-dir': `${paneDir}px` } as CSSProperties}>
          {activeTab === 'general' && (
            <div className="flex flex-col gap-5">
              {isCreate && (
                <div className="rounded-lg border border-bambu-dark-tertiary p-3">
                  <Field label={t('filamentProfiles.basePresetLabel')}>
                    <SearchableSelect
                      id="fp-editor-base-preset"
                      value={selectedBase}
                      onChange={handleBasePresetSelect}
                      options={basePresetOptions}
                      allowCustom={false}
                      disabled={parentStatus === 'resolving'}
                    />
                  </Field>
                  {parentStatus === 'resolving' && (
                    <p className="mt-1 text-xs text-bambu-gray">{t('filamentProfiles.basePresetLoading')}</p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('filamentProfiles.material')}>
                  <SearchableSelect
                    id="fp-editor-material"
                    value={form.filament_type}
                    onChange={(v) => editForm((f) => ({ ...f, filament_type: v }))}
                    options={materialOptions}
                    allowCustom
                  />
                </Field>
                <Field label={t('filamentProfiles.nozzleSize')}>
                  <div className="flex gap-1.5">
                    {NOZZLE_SIZES.map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => handleNozzleChange(size)}
                        aria-pressed={form.nozzle_size === size}
                        className={`flex-1 rounded-lg border px-2 py-2 text-sm font-medium transition-colors ${
                          form.nozzle_size === size
                            ? 'border-bambu-green bg-bambu-green/20 text-bambu-green'
                            : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label={t('filamentProfiles.paKValue')} unit="M900">
                  <NumberInput value={form.pa_k_value} onChange={handlePaKChange} step="0.001" />
                </Field>
                <Field label={t('filamentProfiles.density')} unit="g/cm³">
                  <NumberInput
                    value={form.filament_density}
                    onChange={(v) => editForm((f) => ({ ...f, filament_density: v }))}
                  />
                </Field>
              </div>

              <div>
                <SectionDivider label={t('filamentProfiles.extruder')} />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EXTRUDER_VARIANTS.map((variant) => (
                    <button
                      key={variant}
                      type="button"
                      onClick={() => toggleExtruderVariant(variant)}
                      aria-pressed={form.filament_extruder_variant.includes(variant)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        form.filament_extruder_variant.includes(variant)
                          ? 'border-bambu-green bg-bambu-green/20 text-bambu-green'
                          : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'
                      }`}
                    >
                      {variant}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <SectionDivider label={t('filamentProfiles.compatiblePrinters')} />
                <div className="mt-2 mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs text-bambu-gray/70">{t('filamentProfiles.tagHint')}</span>
                  <button
                    type="button"
                    onClick={handleQuickAdd}
                    className="whitespace-nowrap text-xs font-medium text-bambu-green hover:text-bambu-green-light"
                  >
                    {t('filamentProfiles.quickAdd')}
                  </button>
                </div>
                <TagInput
                  value={form.compatible_printers}
                  onChange={(v) => editForm((f) => ({ ...f, compatible_printers: v }))}
                  placeholder={t('filamentProfiles.tagPlaceholder')}
                />
              </div>

              <Field label={t('filamentProfiles.notes')}>
                <textarea
                  rows={2}
                  value={form.filament_notes}
                  onChange={(e) => editForm((f) => ({ ...f, filament_notes: e.target.value }))}
                  className="w-full resize-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white placeholder-bambu-gray focus:border-bambu-green focus:outline-none"
                />
              </Field>
            </div>
          )}

          {activeTab === 'temps' && <EditorTabTemps form={form} setForm={editForm} />}
          {activeTab === 'cooling' && <EditorTabCooling form={form} setForm={editForm} />}
          {activeTab === 'extrusion' && <EditorTabExtrusion form={form} setForm={editForm} />}
          {activeTab === 'retract' && <EditorTabRetract form={form} setForm={editForm} />}

          {activeTab === 'json' && (
            <div className="flex h-full flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-bambu-gray/70">{t('filamentProfiles.jsonCaption')}</p>
                {jsonError && (
                  <span className="shrink-0 rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">
                    {t('filamentProfiles.invalidJson')}
                  </span>
                )}
              </div>
              <textarea
                rows={24}
                spellCheck={false}
                aria-label={t('filamentProfiles.tabJson')}
                value={rawJson}
                onChange={(e) => handleRawJsonChange(e.target.value)}
                className="w-full flex-1 resize-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 font-mono text-xs text-white focus:border-bambu-green focus:outline-none sm:text-sm"
              />
            </div>
          )}
          </div>
        </div>

        {/* Footer. Always present (Delete/Cancel must stay reachable), but it
            acknowledges the dirty state the way the Material Sheet design's
            save bar does: an accent dot rises in beside the filename and Save
            gets its glow the moment the first edit lands. */}
        <div
          className={`flex items-center justify-between gap-3 border-t px-5 py-3 transition-colors duration-300 ${
            dirty ? 'border-bambu-green/30' : 'border-bambu-dark-tertiary'
          }`}
        >
          <div className="min-w-0">
            {dirty ? (
              <p className="fp-rise flex items-center gap-1.5 text-xs text-bambu-gray-light">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-bambu-green" />
                <span className="min-w-0 truncate font-mono">{filename}</span>
              </p>
            ) : (
              <p className="truncate font-mono text-xs text-bambu-gray/70">{filename}</p>
            )}
            {!computedName && <p className="text-xs text-amber-400">{t('filamentProfiles.nameRequiredHint')}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onDelete && (
              <Button variant="danger" size="sm" onClick={handleDeleteClick}>
                {t('filamentProfiles.deletePreset')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={handleDismiss} disabled={saving}>
              {t('filamentProfiles.cancel')}
            </Button>
            {canSave && (
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving || !computedName || jsonError}
                className={dirty ? 'shadow-[0_4px_18px_rgba(0,174,66,0.35)]' : ''}
              >
                {saving ? t('filamentProfiles.saving') : t(isCreate ? 'filamentProfiles.create' : 'filamentProfiles.save')}
              </Button>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
