import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Columns2,
  Columns3,
  Database,
  Download,
  Droplets,
  Grid2x2,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';

import { api, ApiError } from '../api/client';
import type { BaseFilamentPreset, FilamentPreset, FilamentPresetEditorPayload } from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { SearchableSelect } from '../components/SearchableSelect';
import { exportPresetsZip } from '../components/filament-profiles/exportZip';
import { BulkEditModal } from '../components/filament-profiles/BulkEditModal';
import { PresetCard } from '../components/filament-profiles/PresetCard';
import { PresetMaterialGroups } from '../components/filament-profiles/PresetMaterialGroups';
import { PresetEditorModal } from '../components/filament-profiles/PresetEditorModal';
import { SyncBaseResultModal } from '../components/filament-profiles/SyncBaseResultModal';
import { SyncModal } from '../components/filament-profiles/SyncModal';
import { ZohoSyncResult } from '../components/filament-profiles/ZohoSyncResult';
import type { Entry } from '../components/filament-profiles/presetGroups';
import { applyRowSettings, errorMessage, presetComparator, type RowChanges } from '../components/filament-profiles/presetJson';
import type { GridSize, SortField } from '../components/filament-profiles/types';
import { usePresetImport } from '../components/filament-profiles/usePresetImport';
import { useBaseSync, usePcSync } from '../components/filament-profiles/usePresetSyncs';
import { useZohoSync } from '../components/filament-profiles/useZohoSync';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  readBrandFilter,
  readGridSize,
  readMaterialFilter,
  writeBrandFilter,
  writeGridSize,
  writeMaterialFilter,
} from '../utils/filamentProfilePrefs';

const GRID_CLASSES: Record<GridSize, string> = {
  grouped: 'grid grid-cols-1 gap-3',
  small: 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2',
  medium: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4',
  large: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-6',
};

const SORT_FIELDS: SortField[] = ['name', 'brand', 'material', 'color'];

/** Every editor open state the page can be in — drives the PresetEditorModal
 *  rendered below (nothing renders for 'closed'). 'edit' stores only the id:
 *  the preset itself is re-derived from the `presets` query on every render
 *  (see `editingPreset` below) so a cache invalidation — e.g. a Zoho price
 *  sync completing while the editor is open — feeds the modal fresh data
 *  instead of the pre-sync snapshot captured when it was opened. */
type EditorState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; presetId: number };

/**
 * Toasts `errorMessage(error)` at most once per mount when `isError` is
 * true (spec §5.1: "failure -> error toast" on the initial load, not on
 * every subsequent refetch attempt). A ref flag survives across the
 * retry-driven re-renders that would otherwise re-fire the effect on every
 * new error object identity.
 */
function useToastOnce(isError: boolean, error: unknown, showToast: (message: string, type?: 'error') => void) {
  const toastedRef = useRef(false);
  useEffect(() => {
    if (isError && !toastedRef.current) {
      toastedRef.current = true;
      showToast(errorMessage(error), 'error');
    }
  }, [isError, error, showToast]);
}

function SkeletonCard() {
  return (
    <div className="min-h-24 animate-pulse rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary" />
  );
}

/**
 * Filament Profiles page shell (spec §5): header actions, filter bar, and
 * the responsive preset grid, plus the import/export/sync flows, the preset
 * editor modal, and their supporting confirm/result modals.
 */
export function FilamentProfilesPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // Each button/menu item below is gated on the permission its own backend
  // endpoint enforces (RequirePermissionIfAuthEnabled in
  // routes/filament_profiles.py) — a read-only user no longer sees a control
  // that would just 403. `hasPermission` returns true unconditionally on
  // auth-disabled installs, so those keep seeing everything.
  const { hasPermission } = useAuth();
  const canCreatePreset = hasPermission('filaments:create');
  const canUpdatePreset = hasPermission('filaments:update');
  const canDeletePreset = hasPermission('filaments:delete');
  // T-027: the backend route requires BOTH filaments:update and
  // calculator:update (it reaches the same Zoho catalogue the calculator's
  // own zoho routes gate on calculator:update) — mirror that here so a
  // filaments:update-only role doesn't see a button that just 403s.
  const canSyncZohoPrices = canUpdatePreset && hasPermission('calculator:update');

  const presetsQuery = useQuery({ queryKey: ['filamentPresets'], queryFn: () => api.getFilamentPresets() });
  const baseQuery = useQuery({ queryKey: ['filamentBasePresets'], queryFn: () => api.getBaseFilamentPresets() });
  // Extends the editor's material dropdown; failure is non-blocking here,
  // just a toast (spec §5.1).
  const catalogQuery = useQuery({ queryKey: ['filamentCatalogMaterials'], queryFn: () => api.listFilaments() });

  // Each of these toasts fires at most once per mount (spec §5.1: "failure
  // -> error toast" on the initial load, not on every subsequent refetch
  // attempt) — see useToastOnce above.
  useToastOnce(baseQuery.isError, baseQuery.error, showToast);
  useToastOnce(catalogQuery.isError, catalogQuery.error, showToast);

  const presets = useMemo<FilamentPreset[]>(() => presetsQuery.data ?? [], [presetsQuery.data]);
  const baseFilamentPresets = useMemo<BaseFilamentPreset[]>(() => baseQuery.data ?? [], [baseQuery.data]);
  // Extends the editor's material dropdown (spec §7.1) with any material
  // type already used in the filament catalog but not in the built-in list.
  const extraMaterials = useMemo(
    () => Array.from(new Set((catalogQuery.data ?? []).map((f) => f.type).filter((m) => m !== ''))),
    [catalogQuery.data],
  );

  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState(() => readBrandFilter());
  const [materialFilter, setMaterialFilter] = useState(() => readMaterialFilter());
  const [gridSize, setGridSize] = useState<GridSize>(() => readGridSize());
  const [sortField, setSortField] = useState<SortField>('name');

  const [editorState, setEditorState] = useState<EditorState>({ mode: 'closed' });
  // T-032: the editor's remount key below tracks `updated_at` so a stale
  // editor picks up a preset changed elsewhere while it's open (T-006) —
  // but doing that unconditionally also remounts (and silently discards)
  // one with in-progress, unsaved edits. `liveEditKeyRef` always mirrors
  // the up-to-date key computed at render time; `frozenEditKey` — set only
  // from the modal's `onDirtyChange` — freezes it from the moment the
  // editor turns dirty and clears again once it's clean (a reload adopting
  // the fresh copy, or the parent-driven close on save, see below).
  const liveEditKeyRef = useRef('create');
  const [frozenEditKey, setFrozenEditKey] = useState<string | null>(null);
  const handleEditorDirtyChange = useCallback((dirty: boolean) => {
    setFrozenEditKey(dirty ? liveEditKeyRef.current : null);
  }, []);
  // A fresh open (or close) must never inherit a freeze left over from a
  // previous editor instance on a different preset.
  useEffect(() => {
    setFrozenEditKey(null);
  }, [editorState]);
  const [confirmDelete, setConfirmDelete] = useState<FilamentPreset | null>(null);
  const { importing, fileInputRef, handleImport, handleFilesSelected, importFiles } = usePresetImport(presets);
  const { zohoSyncing, zohoResult, handleZohoSync } = useZohoSync();
  const { syncBaseBusy, syncBaseModal, setSyncBaseModal, baseFileInputRef, handleSyncBase, handleBaseFilesSelected } =
    useBaseSync();
  const { syncModal, setSyncModal, handleSyncToPc, handleSyncConfirm } = usePcSync(presets);

  const brands = useMemo(
    () =>
      Array.from(new Set(presets.map((p) => p.brand).filter((b) => b !== '')))
        .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })),
    [presets],
  );

  const brandScopedPresets = useMemo(
    () => (brandFilter ? presets.filter((p) => p.brand === brandFilter) : presets),
    [presets, brandFilter],
  );

  const materials = useMemo(
    () =>
      Array.from(new Set(brandScopedPresets.map((p) => p.material).filter((m) => m !== '')))
        .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })),
    [brandScopedPresets],
  );

  // Auto-clear a material filter that no longer applies (e.g. after
  // switching brands) — but never while loading, and never before the
  // preset list has actually arrived, so a persisted filter isn't wiped
  // out before data shows up (spec §5.3).
  useEffect(() => {
    if (presetsQuery.isLoading || presets.length === 0) return;
    if (materialFilter && !materials.includes(materialFilter)) {
      setMaterialFilter('');
      writeMaterialFilter('');
    }
  }, [presetsQuery.isLoading, presets.length, materials, materialFilter]);

  // If the preset the editor has open is deleted elsewhere (another tab,
  // or a background sync), it drops out of `presets` on the next
  // invalidation — close rather than leave a modal open on a preset that no
  // longer exists (there's nothing to save it back to).
  useEffect(() => {
    if (editorState.mode !== 'edit' || presetsQuery.isLoading) return;
    if (!presets.some((p) => p.id === editorState.presetId)) {
      setEditorState({ mode: 'closed' });
    }
  }, [editorState, presets, presetsQuery.isLoading]);

  const grouped = gridSize === 'grouped';
  const searchLower = search.trim().toLowerCase();
  const filteredPresets = useMemo(() => {
    return presets
      .filter((p) => grouped || !materialFilter || p.material === materialFilter)
      .filter((p) => !brandFilter || p.brand === brandFilter)
      .filter((p) => {
        if (!searchLower) return true;
        return [p.name, p.brand, p.material, p.color].some((v) => v.toLowerCase().includes(searchLower));
      })
      .sort(presetComparator(sortField));
  }, [presets, grouped, materialFilter, brandFilter, searchLower, sortField]);

  const handleBrandPillClick = (brand: string) => {
    const next = brandFilter === brand ? '' : brand;
    setBrandFilter(next);
    writeBrandFilter(next);
  };

  const handleMaterialPillClick = (material: string) => {
    const next = materialFilter === material ? '' : material;
    setMaterialFilter(next);
    writeMaterialFilter(next);
  };

  const handleGridSizeChange = (size: GridSize) => {
    setGridSize(size);
    writeGridSize(size);
  };

  // ── Save (used by the editor modal) ─────────────────────────────────────
  const handleSavePreset = useCallback(
    async (payload: FilamentPresetEditorPayload, editing: FilamentPreset | null) => {
      try {
        if (editing) {
          await api.updateFilamentPreset(editing.id, payload);
          showToast(t('filamentProfiles.updatedToast', { name: payload.name }));
        } else {
          await api.createFilamentPreset(payload);
          showToast(t('filamentProfiles.createdToast', { name: payload.name }));
        }
      } catch (err) {
        // T-045: a 409 means `payload.expected_updated_at` no longer
        // matches the row — a write landed in between. Refetch now so the
        // still-open editor's `preset` prop picks up the new `updated_at`
        // and the T-032 conflict banner (`serverConflict`, driven off that
        // prop) fires on its own; the editor itself stays open and toasts
        // (see `PresetEditorModal.handleSave`'s catch) because this rethrows
        // instead of reaching the close-on-success code below (T-031's
        // close-on-save is for successful saves only).
        if (err instanceof ApiError && err.status === 409) {
          await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
        }
        throw err;
      }
      // Close now, driven by the parent, BEFORE invalidating — not after
      // (T-031). The refetch below can bump the saved preset's `updated_at`,
      // which feeds the editor's remount key just below (kept for T-006: a
      // stale editor must pick up a preset changed elsewhere, e.g. a Zoho
      // price sync, while it's open). Awaiting that refetch first races the
      // modal's own 220ms exit animation (useDismissableDialog's deferred
      // onClose) — the key can change and remount the modal instance whose
      // close was already pending, silently dropping it and leaving the
      // editor stuck open after a successful save. Setting `editorState`
      // here instead closes it unconditionally, independent of that timer.
      setEditorState({ mode: 'closed' });
      await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
    },
    [queryClient, showToast, t],
  );

  // ── Delete ───────────────────────────────────────────────────────────────
  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    try {
      await api.deleteFilamentPreset(confirmDelete.id);
      await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
      setConfirmDelete(null);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  // ── Duplicate ────────────────────────────────────────────────────────────
  const handleDuplicate = async (preset: FilamentPreset) => {
    try {
      const created = await api.duplicateFilamentPreset(preset.id);
      await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
      await presetsQuery.refetch();
      setEditorState({ mode: 'edit', presetId: created.id });
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  // ── Bulk edit of a grouped line ──────────────────────────────────────────
  const [bulkLine, setBulkLine] = useState<Entry[] | null>(null);
  const handleBulkSave = async (changes: RowChanges) => {
    let failed = 0;
    // Sequential, like the import: each PATCH carries its own `expected_updated_at`.
    for (const { preset } of bulkLine ?? []) {
      try {
        await api.updateFilamentPreset(preset.id, {
          content: applyRowSettings(preset.content, changes),
          expected_updated_at: preset.updated_at,
        });
      } catch {
        failed += 1;
      }
    }
    const ok = (bulkLine?.length ?? 0) - failed;
    if (failed === 0) showToast(t('filamentProfiles.bulkSaved', { n: ok }));
    else showToast(t('filamentProfiles.importPartial', { ok, failed }), 'error');
    setBulkLine(null);
    await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
  };

  const exportable = presets.filter((p) => p.filename && p.content);
  const handleExport = () => exportPresetsZip(exportable).catch((err) => showToast(errorMessage(err), 'error'));

  const total = presets.length;
  const filteredCount = filteredPresets.length;
  const countText =
    filteredCount !== total
      ? t('filamentProfiles.countFiltered', { filtered: filteredCount, total })
      : total === 1
        ? t('filamentProfiles.countOne', { n: total })
        : t('filamentProfiles.countOther', { n: total });

  return (
    // Same page shell as Inventory/Archives/Statistics: the outer padding and
    // the icon + bold title + subtitle header, so this page reads as part of
    // the same family instead of hugging the viewport edges.
    <div
      className="p-4 md:p-8 space-y-6"
      // Preset .json / .zip files dropped anywhere on the page are imported like picked ones.
      onDragOver={canCreatePreset ? (e) => e.preventDefault() : undefined}
      onDrop={
        canCreatePreset
          ? (e) => {
              e.preventDefault();
              void importFiles(Array.from(e.dataTransfer.files));
            }
          : undefined
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between animate-rise-lg vt-page-title">
        <div className="max-md:hidden">
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Droplets className="w-7 h-7 text-bambu-green" />
            {t('filamentProfiles.title')}
          </h1>
          <p className="text-bambu-gray mt-1">{t('filamentProfiles.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canUpdatePreset && (
            <Button variant="secondary" size="sm" onClick={handleSyncBase} disabled={syncBaseBusy}>
              {syncBaseBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('filamentProfiles.syncingBase')}
                </>
              ) : (
                <>
                  <Database className="h-4 w-4" />
                  {t('filamentProfiles.syncBase')}
                </>
              )}
            </Button>
          )}
          {canCreatePreset && (
            <Button variant="secondary" size="sm" onClick={handleImport} disabled={importing}>
              <Upload className="h-4 w-4" />
              {t('filamentProfiles.import')}
            </Button>
          )}
          {/* Hidden picker for the upload-fallback import — opened by
              handleImport when the server-side scan finds no Bambu Studio
              folder (remote deploys). */}
          <input
            ref={fileInputRef}
            data-testid="fp-import-file-input"
            type="file"
            accept=".json,.zip"
            multiple
            className="hidden"
            onChange={handleFilesSelected}
          />
          {/* Hidden picker for the sync-base upload fallback — opened by
              handleSyncBase when the server-side bundle dir is empty. */}
          <input
            ref={baseFileInputRef}
            data-testid="fp-base-file-input"
            type="file"
            accept=".json,.zip"
            multiple
            className="hidden"
            onChange={handleBaseFilesSelected}
          />
          {canSyncZohoPrices && (
            <Button variant="secondary" size="sm" onClick={handleZohoSync} disabled={zohoSyncing}>
              {zohoSyncing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('filamentProfiles.syncingZoho')}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" />
                  {t('filamentProfiles.syncZohoPrices')}
                </>
              )}
            </Button>
          )}
          {canUpdatePreset && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSyncToPc}
              disabled={presetsQuery.isLoading || presetsQuery.isError}
            >
              <RefreshCw className="h-4 w-4" />
              {t('filamentProfiles.syncToPc')}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={handleExport} disabled={exportable.length === 0}>
            <Download className="h-4 w-4" />
            {t('filamentProfiles.exportZip')}
          </Button>
          {canCreatePreset && (
            <Button size="sm" onClick={() => setEditorState({ mode: 'create' })}>
              <Plus className="h-4 w-4" />
              {t('filamentProfiles.newPreset')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:w-[26rem]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray/50" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('filamentProfiles.searchPlaceholder')}
              className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2 pl-10 pr-3 text-sm text-white placeholder:text-bambu-gray/50 focus:border-bambu-green focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1">
              <button
                type="button"
                onClick={() => handleGridSizeChange('grouped')}
                aria-label={t('filamentProfiles.gridGrouped')}
                aria-pressed={grouped}
                className={`rounded p-1.5 ${grouped ? 'bg-bambu-green/20 text-bambu-green' : 'text-bambu-gray/60 hover:text-white'}`}
              >
                <Layers className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleGridSizeChange('small')}
                aria-label={t('filamentProfiles.gridSmall')}
                aria-pressed={gridSize === 'small'}
                className={`rounded p-1.5 ${gridSize === 'small' ? 'bg-bambu-green/20 text-bambu-green' : 'text-bambu-gray/60 hover:text-white'}`}
              >
                <Grid2x2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleGridSizeChange('medium')}
                aria-label={t('filamentProfiles.gridMedium')}
                aria-pressed={gridSize === 'medium'}
                className={`rounded p-1.5 ${gridSize === 'medium' ? 'bg-bambu-green/20 text-bambu-green' : 'text-bambu-gray/60 hover:text-white'}`}
              >
                <Columns3 className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handleGridSizeChange('large')}
                aria-label={t('filamentProfiles.gridLarge')}
                aria-pressed={gridSize === 'large'}
                className={`rounded p-1.5 ${gridSize === 'large' ? 'bg-bambu-green/20 text-bambu-green' : 'text-bambu-gray/60 hover:text-white'}`}
              >
                <Columns2 className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-bambu-gray whitespace-nowrap">{t('filamentProfiles.sortPrefix')}</span>
              <SearchableSelect
                id="fp-sort-select"
                value={sortField}
                onChange={(v) => setSortField(v as SortField)}
                options={SORT_FIELDS.map((field) => ({
                  value: field,
                  label: t(`filamentProfiles.sort${field.charAt(0).toUpperCase()}${field.slice(1)}`),
                }))}
                allowCustom={false}
              />
            </div>

            <span className="text-sm tabular-nums text-bambu-gray whitespace-nowrap">{countText}</span>
          </div>
        </div>

        {brands.length >= 1 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => handleBrandPillClick('')}
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${brandFilter === '' ? 'bg-bambu-green/20 text-bambu-green' : 'border border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}
            >
              {t('filamentProfiles.allBrands')}
            </button>
            {brands.map((brand) => (
              <button
                key={brand}
                type="button"
                onClick={() => handleBrandPillClick(brand)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${brandFilter === brand ? 'bg-bambu-green/20 text-bambu-green' : 'border border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}
              >
                {brand}
              </button>
            ))}
          </div>
        )}

        {!grouped && materials.length >= 1 && (
          <div className="flex flex-wrap gap-1.5">
            {materials.map((material) => (
              <button
                key={material}
                type="button"
                onClick={() => handleMaterialPillClick(material)}
                className={`rounded-full px-2.5 py-1 font-mono text-xs font-medium ${materialFilter === material ? 'bg-bambu-green/20 text-bambu-green' : 'border border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}
              >
                {material}
              </button>
            ))}
          </div>
        )}
      </div>

      {zohoResult && <ZohoSyncResult zohoResult={zohoResult} />}

      {presetsQuery.isError && (
        <div className="animate-rise py-8 text-center">
          <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-red-400" />
          <p className="font-medium text-white">{errorMessage(presetsQuery.error)}</p>
          <Button variant="secondary" onClick={() => presetsQuery.refetch()} className="mx-auto mt-4">
            {t('common.retry')}
          </Button>
        </div>
      )}

      {!presetsQuery.isError && presetsQuery.isLoading && (
        <div className={GRID_CLASSES[gridSize]}>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {!presetsQuery.isError && !presetsQuery.isLoading && total === 0 && (
        <div className="py-12 text-center">
          <p className="font-medium text-white">{t('filamentProfiles.emptyTitle')}</p>
          <p className="mt-1 text-sm text-bambu-gray">{t('filamentProfiles.emptySubtitle')}</p>
        </div>
      )}

      {!presetsQuery.isError && !presetsQuery.isLoading && total > 0 && filteredCount === 0 && (
        <div className="py-12 text-center">
          <p className="font-medium text-white">{t('filamentProfiles.noResults')}</p>
        </div>
      )}

      {!presetsQuery.isError && !presetsQuery.isLoading && filteredCount > 0 && grouped && (
        <PresetMaterialGroups
          presets={filteredPresets}
          onOpen={(preset) => setEditorState({ mode: 'edit', presetId: preset.id })}
          onAddColor={canCreatePreset ? handleDuplicate : undefined}
          onEditLine={canUpdatePreset ? setBulkLine : undefined}
        />
      )}

      {!presetsQuery.isError && !presetsQuery.isLoading && filteredCount > 0 && !grouped && (
        <div className={GRID_CLASSES[gridSize]}>
          {filteredPresets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              onOpen={() => setEditorState({ mode: 'edit', presetId: preset.id })}
              onEdit={() => setEditorState({ mode: 'edit', presetId: preset.id })}
              onDuplicate={() => handleDuplicate(preset)}
              onDelete={() => setConfirmDelete(preset)}
              canEdit={canUpdatePreset}
              canDuplicate={canCreatePreset}
              canDelete={canDeletePreset}
            />
          ))}
        </div>
      )}

      {editorState.mode !== 'closed' &&
        (() => {
          const editingPreset =
            editorState.mode === 'edit' ? (presets.find((p) => p.id === editorState.presetId) ?? null) : null;
          // 'edit' with no matching preset means it was just deleted out from
          // under the open editor (see the effect above, which will close it
          // on the next render) — don't flash a stale/empty editor meanwhile.
          if (editorState.mode === 'edit' && !editingPreset) return null;
          const liveKey =
            editorState.mode === 'edit' ? `${editorState.presetId}-${editingPreset?.updated_at ?? ''}` : 'create';
          liveEditKeyRef.current = liveKey;
          return (
            <PresetEditorModal
              key={frozenEditKey ?? liveKey}
              preset={editingPreset}
              presets={presets}
              basePresets={baseFilamentPresets}
              extraMaterials={extraMaterials}
              onSave={(payload) => handleSavePreset(payload, editingPreset)}
              onDelete={editingPreset && canDeletePreset ? () => setConfirmDelete(editingPreset) : null}
              onDuplicate={editingPreset && canCreatePreset ? () => void handleDuplicate(editingPreset) : null}
              onClose={() => setEditorState({ mode: 'closed' })}
              canSave={editorState.mode === 'create' ? canCreatePreset : canUpdatePreset}
              onDirtyChange={handleEditorDirtyChange}
            />
          );
        })()}

      {bulkLine && <BulkEditModal line={bulkLine} onSave={handleBulkSave} onClose={() => setBulkLine(null)} />}

      {confirmDelete && (
        <ConfirmModal
          title={t('filamentProfiles.deleteTitle')}
          message={t('filamentProfiles.deleteBody', { name: confirmDelete.name })}
          cancelText={t('filamentProfiles.cancel')}
          confirmText={t('filamentProfiles.deleteConfirm')}
          variant="danger"
          overlayZIndex="z-[110]"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {syncModal && (
        <SyncModal
          state={syncModal.state}
          stats={syncModal.stats}
          onCancel={() => setSyncModal(null)}
          onConfirm={handleSyncConfirm}
          onClose={() => setSyncModal(null)}
          canConfirm={canDeletePreset}
        />
      )}

      {syncBaseModal && (
        <SyncBaseResultModal
          result={syncBaseModal.result}
          error={syncBaseModal.error}
          onClose={() => setSyncBaseModal(null)}
        />
      )}
    </div>
  );
}
