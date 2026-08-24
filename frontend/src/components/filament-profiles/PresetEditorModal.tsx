import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCw, X } from 'lucide-react';

import { api } from '../../api/client';
import type { BaseFilamentPreset, FilamentPreset, FilamentPresetPayload } from '../../api/client';
import { Button } from '../Button';
import { SearchableSelect } from '../SearchableSelect';
import type { SearchableSelectOption } from '../SearchableSelect';
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
  mergeWithParent,
  parseContentToForm,
  parseNozzleFromName,
  rewriteCompatibleForNozzle,
} from './presetJson';
import type { PresetForm } from './types';
import { Field, NumberInput, SectionDivider, TextInput } from './editorFields';
import { TagInput } from './TagInput';

export interface PresetEditorModalProps {
  preset: FilamentPreset | null;
  presets: FilamentPreset[];
  basePresets: BaseFilamentPreset[];
  extraMaterials: string[];
  onSave: (payload: FilamentPresetPayload) => Promise<void>;
  onDelete: (() => void) | null;
  onClose: () => void;
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

const BRAND_ID = 'fp-editor-brand';

/**
 * The preset editor (spec §6): a fixed-height modal with header / tab bar /
 * scrollable content / footer. Only the General tab (§7.1) is implemented
 * here — Temps/Cooling/Extrusion/Retract land in Task 13, the JSON tab in
 * Task 14; their tab buttons already exist and render an empty placeholder.
 */
export function PresetEditorModal({
  preset,
  presets,
  basePresets,
  extraMaterials,
  onSave,
  onDelete,
  onClose,
}: PresetEditorModalProps) {
  const { t } = useTranslation();
  const isCreate = preset === null;

  const [baseData] = useState<Record<string, unknown>>(() => parseBaseData(preset?.content));
  const [form, setForm] = useState<PresetForm>(() => {
    let initial = parseContentToForm(baseData, preset?.color);
    if (preset) {
      const nozzle = parseNozzleFromName(preset.name);
      if (nozzle !== null) initial = { ...initial, nozzle_size: nozzle };
    } else {
      initial = { ...initial, compatible_printers: DEFAULT_COMPATIBLE_PRINTERS };
    }
    return initial;
  });

  const [resolvedParent, setResolvedParent] = useState<PresetForm | null>(null);
  const [parentStatus, setParentStatus] = useState<ParentStatus>('idle');
  // The create-mode base-preset picker's own selection, e.g. "user:Name" /
  // "base:Name" — kept separate from `form.inherits` (a bare name) so the
  // SearchableSelect always has a value matching one of its own options.
  const [selectedBase, setSelectedBase] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('general');
  // Both wired for real in Task 14 (JSON tab): regenerated on tab-switch,
  // re-parsed on every keystroke.
  const [rawJson] = useState('');
  const [jsonError] = useState(false);
  const [saving, setSaving] = useState(false);

  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: 220 });

  const fetchBaseContent = (filename: string) => api.getBaseFilamentPresetContent(filename).then((r) => r.content);

  const resolveInherits = async (name: string, mergeOnto: (parent: PresetForm) => void) => {
    setParentStatus('resolving');
    const parent = await buildResolvedParent(name, presets, basePresets, fetchBaseContent);
    setResolvedParent(parent);
    setParentStatus(parent ? 'found' : 'not-found');
    if (parent) mergeOnto(parent);
  };

  // Mount: focus Brand, and resolve an existing `inherits` immediately.
  useEffect(() => {
    document.getElementById(BRAND_ID)?.focus();
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

  const basePresetOptions = useMemo<SearchableSelectOption[]>(() => {
    const seen = new Set<string>();
    const options: SearchableSelectOption[] = [{ value: '', label: t('filamentProfiles.basePresetNone') }];
    // User presets first — they shadow a same-named base preset (spec §9.12).
    for (const p of presets) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      options.push({ value: `user:${p.name}`, label: p.name });
    }
    for (const b of basePresets) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      options.push({ value: `base:${b.name}`, label: b.name });
    }
    return options;
  }, [presets, basePresets, t]);

  const handleBasePresetSelect = (selection: string) => {
    setSelectedBase(selection);
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
    setForm((f) => ({
      ...f,
      nozzle_size: size,
      compatible_printers: rewriteCompatibleForNozzle(f.compatible_printers, size),
    }));
  };

  const handlePaKChange = (v: string) => {
    setForm((f) => ({
      ...f,
      pa_k_value: v,
      filament_start_gcode: v ? `M900 L1000 M10\nM900 K${v}` : '',
    }));
  };

  const toggleExtruderVariant = (variant: string) => {
    setForm((f) => ({
      ...f,
      filament_extruder_variant: f.filament_extruder_variant.includes(variant)
        ? f.filament_extruder_variant.filter((v) => v !== variant)
        : [...f.filament_extruder_variant, variant],
    }));
  };

  const handleQuickAdd = () => {
    setForm((f) => {
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

  const handleDeleteClick = () => {
    requestClose();
    onDelete?.();
  };

  const handleSave = async () => {
    const content = activeTab === 'json' ? rawJson : buildJson(form, baseData, resolvedParent, computedName);
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
    } catch {
      // The page already toasted the failure — stay open so nothing is lost.
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
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={computedName || t(isCreate ? 'filamentProfiles.editorNewTitle' : 'filamentProfiles.editorEditTitle')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        className={`flex h-[88vh] w-full max-w-5xl flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl focus:outline-none ${
          closing ? 'opacity-0 transition-opacity duration-200' : 'animate-modal-in'
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-bambu-dark-tertiary px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className="mt-1 h-8 w-8 shrink-0 rounded-full border border-bambu-dark-tertiary bg-bambu-dark-tertiary"
              style={form.default_filament_colour ? { backgroundColor: form.default_filament_colour } : undefined}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-semibold text-white">
                  {computedName || t(isCreate ? 'filamentProfiles.editorNewTitle' : 'filamentProfiles.editorEditTitle')}
                </h2>
                {form.filament_type !== '' && (
                  <span className="rounded-full bg-bambu-dark-tertiary px-2 py-0.5 font-mono text-xs text-bambu-gray-light">
                    {form.filament_type}
                  </span>
                )}
              </div>
              {form.inherits !== '' && (
                <div className="mt-1 flex items-center gap-1.5 text-xs">
                  <span
                    className={
                      parentStatus === 'resolving'
                        ? 'animate-pulse text-bambu-gray'
                        : parentStatus === 'found'
                          ? 'text-bambu-green'
                          : 'text-bambu-gray'
                    }
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
                    className="rounded p-0.5 text-bambu-gray/60 hover:text-white"
                  >
                    <RotateCw className={`h-3 w-3 ${parentStatus === 'resolving' ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label={t('filamentProfiles.close')}
            className="shrink-0 rounded p-1 text-bambu-gray/60 hover:bg-bambu-dark-tertiary hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-bambu-dark-tertiary px-5 pt-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id}
              className={`rounded-t-lg px-3 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-b-2 border-bambu-green text-white'
                  : 'border-b-2 border-transparent text-bambu-gray hover:text-white'
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
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
                <Field label={t('filamentProfiles.brand')}>
                  <SearchableSelect
                    id={BRAND_ID}
                    value={form.filament_vendor}
                    onChange={(v) => setForm((f) => ({ ...f, filament_vendor: v }))}
                    options={vendorOptions}
                    allowCustom={false}
                    placeholderKey="filamentProfiles.brandSelect"
                  />
                </Field>
                <Field label={t('filamentProfiles.material')}>
                  <SearchableSelect
                    id="fp-editor-material"
                    value={form.filament_type}
                    onChange={(v) => setForm((f) => ({ ...f, filament_type: v }))}
                    options={materialOptions}
                    allowCustom
                  />
                </Field>
                <Field label={t('filamentProfiles.colorLabel')}>
                  <TextInput
                    value={form.color}
                    onChange={(v) => setForm((f) => ({ ...f, color: v }))}
                    placeholder={t('filamentProfiles.colorPlaceholder')}
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
                <Field label={t('filamentProfiles.cost')} unit="€/kg">
                  <NumberInput
                    value={form.filament_cost}
                    onChange={(v) => setForm((f) => ({ ...f, filament_cost: v }))}
                  />
                </Field>
                <Field label={t('filamentProfiles.density')} unit="g/cm³">
                  <NumberInput
                    value={form.filament_density}
                    onChange={(v) => setForm((f) => ({ ...f, filament_density: v }))}
                  />
                </Field>
                <Field label={t('filamentProfiles.filamentColour')}>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(form.default_filament_colour) ? form.default_filament_colour : '#000000'}
                      onChange={(e) => setForm((f) => ({ ...f, default_filament_colour: e.target.value }))}
                      aria-label={t('filamentProfiles.filamentColour')}
                      className="h-9 w-9 shrink-0 cursor-pointer rounded border border-bambu-dark-tertiary bg-transparent p-0.5"
                    />
                    <TextInput
                      value={form.default_filament_colour}
                      onChange={(v) => setForm((f) => ({ ...f, default_filament_colour: v }))}
                      placeholder="#RRGGBB"
                    />
                  </div>
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
                  onChange={(v) => setForm((f) => ({ ...f, compatible_printers: v }))}
                  placeholder={t('filamentProfiles.tagPlaceholder')}
                />
              </div>

              <Field label={t('filamentProfiles.notes')}>
                <textarea
                  rows={2}
                  value={form.filament_notes}
                  onChange={(e) => setForm((f) => ({ ...f, filament_notes: e.target.value }))}
                  className="w-full resize-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white placeholder-bambu-gray focus:border-bambu-green focus:outline-none"
                />
              </Field>
            </div>
          )}

          {/* Temps / Cooling / Extrusion / Retract land in Task 13. */}
          {(activeTab === 'temps' || activeTab === 'cooling' || activeTab === 'extrusion' || activeTab === 'retract') && (
            <div />
          )}

          {/* Raw JSON editing lands in Task 14. */}
          {activeTab === 'json' && <div />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-5 py-3">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-bambu-gray/70">{filename}</p>
            {!computedName && <p className="text-xs text-amber-400">{t('filamentProfiles.nameRequiredHint')}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onDelete && (
              <Button variant="danger" size="sm" onClick={handleDeleteClick}>
                {t('filamentProfiles.deletePreset')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={requestClose}>
              {t('filamentProfiles.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !computedName || jsonError}
            >
              {saving ? t('filamentProfiles.saving') : t(isCreate ? 'filamentProfiles.create' : 'filamentProfiles.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
