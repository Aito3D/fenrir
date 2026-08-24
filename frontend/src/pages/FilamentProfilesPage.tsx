import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Columns2,
  Columns3,
  Database,
  Download,
  Grid2x2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';

import { api } from '../api/client';
import type {
  BambuScanFile,
  BaseFilamentPreset,
  FilamentBaseSyncResult,
  FilamentPreset,
  FilamentPresetPayload,
  FilamentSyncStats,
} from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { SearchableSelect } from '../components/SearchableSelect';
import { PresetCard } from '../components/filament-profiles/PresetCard';
import { SyncBaseResultModal } from '../components/filament-profiles/SyncBaseResultModal';
import { SyncModal } from '../components/filament-profiles/SyncModal';
import { presetComparator } from '../components/filament-profiles/presetJson';
import type { GridSize, SortField } from '../components/filament-profiles/types';
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
  small: 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2',
  medium: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4',
  large: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-6',
};

const SORT_FIELDS: SortField[] = ['name', 'brand', 'material', 'color'];

/** Every editor open state the page can be in. Task 12 renders the actual
 *  modal off this; for now nothing is rendered for 'create'/'edit'. */
type EditorState = { mode: 'closed' } | { mode: 'create' } | { mode: 'edit'; preset: FilamentPreset };

type SyncBaseModalState = { result?: FilamentBaseSyncResult; error?: string } | null;
type SyncModalState = { state: 'syncing' | 'preview' | 'done'; stats?: FilamentSyncStats } | null;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function SkeletonCard() {
  return (
    <div className="min-h-24 animate-pulse rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary" />
  );
}

/**
 * Filament Profiles page shell (spec §5): header actions, filter bar, and
 * the responsive preset grid, plus the import/export/sync flows and their
 * two supporting modals. The editor modal itself lands in Task 12 — this
 * page only owns the `editorState` that will drive it.
 */
export function FilamentProfilesPage() {
  const { t } = useTranslation();
  const { showToast, showPersistentToast, dismissToast } = useToast();
  const queryClient = useQueryClient();

  const presetsQuery = useQuery({ queryKey: ['filamentPresets'], queryFn: () => api.getFilamentPresets() });
  const baseQuery = useQuery({ queryKey: ['filamentBasePresets'], queryFn: () => api.getBaseFilamentPresets() });
  // Extends the editor's material dropdown in Task 12; failure is
  // non-blocking here, just a toast (spec §5.1).
  const catalogQuery = useQuery({ queryKey: ['filamentCatalogMaterials'], queryFn: () => api.listFilaments() });

  // Each of these toasts fires at most once per mount (spec §5.1: "failure
  // -> error toast" on the initial load, not on every subsequent refetch
  // attempt) — a ref flag survives across the retry-driven re-renders that
  // would otherwise re-fire the effect on every new error object identity.
  const baseErrorToastedRef = useRef(false);
  useEffect(() => {
    if (baseQuery.isError && !baseErrorToastedRef.current) {
      baseErrorToastedRef.current = true;
      showToast(errorMessage(baseQuery.error), 'error');
    }
  }, [baseQuery.isError, baseQuery.error, showToast]);

  const catalogErrorToastedRef = useRef(false);
  useEffect(() => {
    if (catalogQuery.isError && !catalogErrorToastedRef.current) {
      catalogErrorToastedRef.current = true;
      showToast(errorMessage(catalogQuery.error), 'error');
    }
  }, [catalogQuery.isError, catalogQuery.error, showToast]);

  const presets = useMemo<FilamentPreset[]>(() => presetsQuery.data ?? [], [presetsQuery.data]);
  const baseFilamentPresets = useMemo<BaseFilamentPreset[]>(() => baseQuery.data ?? [], [baseQuery.data]);
  // Reserved for the editor modal (Task 12) — resolving `inherits` chains
  // needs the base-preset list even though nothing here renders it yet.
  void baseFilamentPresets;

  const [search, setSearch] = useState('');
  const [brandFilter, setBrandFilter] = useState(() => readBrandFilter());
  const [materialFilter, setMaterialFilter] = useState(() => readMaterialFilter());
  const [gridSize, setGridSize] = useState<GridSize>(() => readGridSize());
  const [sortField, setSortField] = useState<SortField>('name');

  const [editorState, setEditorState] = useState<EditorState>({ mode: 'closed' });
  // Consumed by PresetEditorModal in Task 12 — this page only owns the state.
  void editorState;
  const [confirmDelete, setConfirmDelete] = useState<FilamentPreset | null>(null);
  const [importing, setImporting] = useState(false);
  const [syncBaseBusy, setSyncBaseBusy] = useState(false);
  const [syncBaseModal, setSyncBaseModal] = useState<SyncBaseModalState>(null);
  const [syncModal, setSyncModal] = useState<SyncModalState>(null);
  const syncPayloadRef = useRef<{ filename: string; content: string }[]>([]);

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

  const searchLower = search.trim().toLowerCase();
  const filteredPresets = useMemo(() => {
    return presets
      .filter((p) => !materialFilter || p.material === materialFilter)
      .filter((p) => !brandFilter || p.brand === brandFilter)
      .filter((p) => {
        if (!searchLower) return true;
        return [p.name, p.brand, p.material, p.color].some((v) => v.toLowerCase().includes(searchLower));
      })
      .sort(presetComparator(sortField));
  }, [presets, materialFilter, brandFilter, searchLower, sortField]);

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

  // ── Save (used by the editor modal in Task 12) ──────────────────────────
  const handleSavePreset = useCallback(
    async (payload: FilamentPresetPayload, editing: FilamentPreset | null) => {
      if (editing) {
        await api.updateFilamentPreset(editing.id, payload);
        showToast(t('filamentProfiles.updatedToast', { name: payload.name }));
      } else {
        await api.createFilamentPreset(payload);
        showToast(t('filamentProfiles.createdToast', { name: payload.name }));
      }
      await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
    },
    [queryClient, showToast, t],
  );
  // Wired into PresetEditorModal in Task 12.
  void handleSavePreset;

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
      setEditorState({ mode: 'edit', preset: created });
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  // ── Import from disk (spec §5.7) ────────────────────────────────────────
  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      // Only the scan call's failure is a "scanFailed" toast — per-file
      // create failures below are counted and reported separately, and must
      // never be mislabeled as a folder-read error.
      let scanResult: { files: BambuScanFile[] };
      try {
        scanResult = await api.scanBambuStudioPresets();
      } catch (err) {
        showToast(t('filamentProfiles.scanFailed', { error: errorMessage(err) }), 'error');
        return;
      }

      const existingFilenames = new Set(presets.map((p) => p.filename));
      const newFiles = scanResult.files.filter((f) => !existingFilenames.has(f.filename));

      if (newFiles.length === 0) {
        showToast(t('filamentProfiles.allImported', { n: scanResult.files.length }));
        return;
      }

      showPersistentToast('fp-import', t('filamentProfiles.importing', { current: 0, total: newFiles.length }), 'loading');
      try {
        let ok = 0;
        let failed = 0;
        for (let i = 0; i < newFiles.length; i++) {
          const file = newFiles[i];
          let payload: FilamentPresetPayload;
          try {
            const parsed = JSON.parse(file.content) as Record<string, unknown>;
            const vendor = Array.isArray(parsed.filament_vendor) ? parsed.filament_vendor[0] : undefined;
            const type = Array.isArray(parsed.filament_type) ? parsed.filament_type[0] : undefined;
            const colour = Array.isArray(parsed.filament_colour) ? parsed.filament_colour[0] : undefined;
            const name = typeof parsed.name === 'string' && parsed.name ? parsed.name : file.filename.replace(/\.json$/, '');
            payload = {
              name,
              brand: vendor ? String(vendor) : '',
              material: type ? String(type) : '',
              color: '',
              color_hex: colour ? String(colour) : '',
              filename: file.filename,
              content: file.content,
            };
          } catch {
            payload = {
              name: file.filename.replace(/\.json$/, ''),
              brand: '',
              material: '',
              color: '',
              color_hex: '',
              filename: file.filename,
              content: file.content,
            };
          }

          try {
            // Sequential and awaited — each POST must land before the next
            // starts (dedupe + progress-toast semantics depend on it).
            await api.createFilamentPreset(payload);
            ok += 1;
          } catch {
            failed += 1;
          }

          showPersistentToast(
            'fp-import',
            t('filamentProfiles.importing', { current: i + 1, total: newFiles.length }),
            'loading',
          );
        }

        if (failed === 0) {
          showToast(t('filamentProfiles.imported', { n: ok }));
        } else {
          showToast(t('filamentProfiles.importPartial', { ok, failed }), 'error');
        }
        await queryClient.invalidateQueries({ queryKey: ['filamentPresets'] });
      } finally {
        dismissToast('fp-import');
      }
    } finally {
      setImporting(false);
    }
  };

  // ── Export ZIP (spec §5.9) ──────────────────────────────────────────────
  const handleExport = async () => {
    // Belt-and-braces: the Export button is disabled via `canExport` below,
    // but that guard could drift from this filter, so check again here too.
    const candidates = presets.filter((p) => p.filename && p.content);
    if (candidates.length === 0) {
      showToast(t('filamentProfiles.exportEmpty'), 'error');
      return;
    }
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      candidates.forEach((p) => zip.file(p.filename, p.content));
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'filament-presets.zip';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(errorMessage(err), 'error');
    }
  };

  const canExport = presets.some((p) => p.filename && p.content);

  // ── Sync to PC (spec §5.8, two-phase) ───────────────────────────────────
  const handleSyncToPc = async () => {
    syncPayloadRef.current = presets
      .filter((p) => p.filename && p.content)
      .map((p) => ({ filename: p.filename, content: p.content }));
    setSyncModal({ state: 'syncing' });
    try {
      const { stats } = await api.syncFilamentPresetsToBambu(syncPayloadRef.current, true);
      setSyncModal({ state: 'preview', stats });
    } catch (err) {
      setSyncModal(null);
      showToast(t('filamentProfiles.syncPreviewFailed', { error: errorMessage(err) }), 'error');
    }
  };

  const handleSyncConfirm = async () => {
    setSyncModal({ state: 'syncing' });
    try {
      const { stats } = await api.syncFilamentPresetsToBambu(syncPayloadRef.current, false);
      setSyncModal({ state: 'done', stats });
    } catch (err) {
      setSyncModal(null);
      showToast(t('filamentProfiles.syncFailed', { error: errorMessage(err) }), 'error');
    }
  };

  // ── Sync base (spec §5.2) ───────────────────────────────────────────────
  const handleSyncBase = async () => {
    setSyncBaseBusy(true);
    try {
      const result = await api.syncBaseFilamentPresets();
      setSyncBaseModal({ result });
    } catch (err) {
      setSyncBaseModal({ error: errorMessage(err) });
    } finally {
      setSyncBaseBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['filamentBasePresets'] });
    }
  };

  const total = presets.length;
  const filteredCount = filteredPresets.length;
  const countText =
    filteredCount !== total
      ? t('filamentProfiles.countFiltered', { filtered: filteredCount, total })
      : total === 1
        ? t('filamentProfiles.countOne', { n: total })
        : t('filamentProfiles.countOther', { n: total });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-xl font-semibold text-white">{t('filamentProfiles.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
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
          <Button variant="secondary" size="sm" onClick={handleImport} disabled={importing}>
            <Upload className="h-4 w-4" />
            {t('filamentProfiles.import')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSyncToPc}
            disabled={presetsQuery.isLoading || presetsQuery.isError}
          >
            <RefreshCw className="h-4 w-4" />
            {t('filamentProfiles.syncToPc')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleExport} disabled={!canExport}>
            <Download className="h-4 w-4" />
            {t('filamentProfiles.exportZip')}
          </Button>
          <Button size="sm" onClick={() => setEditorState({ mode: 'create' })}>
            <Plus className="h-4 w-4" />
            {t('filamentProfiles.newPreset')}
          </Button>
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

        {materials.length >= 1 && (
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

      {!presetsQuery.isError && !presetsQuery.isLoading && filteredCount > 0 && (
        <div className={GRID_CLASSES[gridSize]}>
          {filteredPresets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              onOpen={() => setEditorState({ mode: 'edit', preset })}
              onEdit={() => setEditorState({ mode: 'edit', preset })}
              onDuplicate={() => handleDuplicate(preset)}
              onDelete={() => setConfirmDelete(preset)}
            />
          ))}
        </div>
      )}

      {/* PresetEditorModal rendered here in Task 12 */}

      {confirmDelete && (
        <ConfirmModal
          title={t('filamentProfiles.deleteTitle')}
          message={t('filamentProfiles.deleteBody', { name: confirmDelete.name })}
          cancelText={t('filamentProfiles.cancel')}
          confirmText={t('filamentProfiles.deleteConfirm')}
          variant="danger"
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
