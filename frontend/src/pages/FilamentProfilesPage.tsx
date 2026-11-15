import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, Droplets, Loader2, RefreshCw, Settings2 } from 'lucide-react';

import { api } from '../api/client';
import type { FilamentTreePullResult } from '../api/client';
import { Button } from '../components/Button';
import { ZohoSyncResult } from '../components/filament-profiles/ZohoSyncResult';
import { errorMessage } from '../components/filament-trees/errorMessage';
import { useZohoSync } from '../components/filament-profiles/useZohoSync';
import { downloadTreeExport } from '../components/filament-trees/exportDownload';
import { MigrateModal } from '../components/filament-trees/MigrateModal';
import { NodePanel } from '../components/filament-trees/NodePanel';
import { SyncResultModal } from '../components/filament-trees/SyncResultModal';
import { TreeNav, type NodeRef } from '../components/filament-trees/TreeNav';
import { TreeSettingsPanel } from '../components/filament-trees/TreeSettingsPanel';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

/**
 * Filament Profiles: the profile trees (tree left, settings right; stacked on phones),
 * SYNC pull from Orca Cloud, migration of loose presets, Export for Orca and Zoho prices.
 */
export function FilamentProfilesPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  // Each control is gated on the permission(s) its backend route enforces; hasPermission is
  // always true on auth-disabled installs.
  const { hasPermission } = useAuth();
  const canCreate = hasPermission('filaments:create');
  const canUpdate = hasPermission('filaments:update');
  const canDelete = hasPermission('filaments:delete');
  const canSync = canUpdate && hasPermission('orca_cloud:auth');
  const canMigrate = canCreate && canUpdate;
  // T-027: the Zoho route also requires calculator:update.
  const canSyncZohoPrices = canUpdate && hasPermission('calculator:update');

  const treesQuery = useQuery({ queryKey: ['filament-trees'], queryFn: api.getFilamentTrees });
  const targetsQuery = useQuery({ queryKey: ['filament-trees', 'targets'], queryFn: api.getFilamentTreeTargets });
  const unmanagedQuery = useQuery({ queryKey: ['filament-trees', 'unmanaged'], queryFn: api.getUnmanagedFilamentGroups });

  const [selected, setSelected] = useState<NodeRef | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncOutcome, setSyncOutcome] = useState<{ result?: FilamentTreePullResult; error?: unknown } | null>(null);
  const { zohoSyncing, zohoResult, handleZohoSync } = useZohoSync();
  // Source colour names for the migration modal; only fetched while it is open.
  const presetsQuery = useQuery({ queryKey: ['filamentPresets'], queryFn: api.getFilamentPresets, enabled: migrateOpen });

  const trees = treesQuery.data ?? [];
  const groups = unmanagedQuery.data ?? [];
  const unmanagedCount = groups.reduce((n, g) => n + g.preset_ids.length, 0);
  const targets = targetsQuery.data;
  // Falls back to the first tree's root until the user picks a node (or when the picked tree is gone).
  const current: NodeRef | null =
    selected && trees.some((tr) => tr.id === selected.treeId) ? selected : trees[0] ? { treeId: trees[0].id } : null;
  const currentTree = trees.find((tr) => tr.id === current?.treeId);

  const handleSync = async () => {
    setSyncing(true);
    try {
      setSyncOutcome({ result: await api.syncFilamentTrees() });
    } catch (error) {
      setSyncOutcome({ error });
    } finally {
      setSyncing(false);
      // a pull can change own values anywhere: tree list, open node, unmanaged groups
      void queryClient.invalidateQueries({ queryKey: ['filament-trees'] });
    }
  };

  const loading = treesQuery.isLoading || targetsQuery.isLoading;
  const loadError = treesQuery.error ?? targetsQuery.error;

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between animate-rise-lg vt-page-title">
        <div className="max-md:hidden">
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Droplets className="w-7 h-7 text-bambu-green" />
            {t('filamentProfiles.title')}
          </h1>
          <p className="text-bambu-gray mt-1">{t('filamentTrees.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canSync && (
            <Button size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('filamentTrees.sync')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => downloadTreeExport().catch((err) => showToast(errorMessage(err), 'error'))}
            disabled={trees.length === 0}
          >
            <Download className="h-4 w-4" />
            {t('filamentTrees.exportOrca')}
          </Button>
          {canSyncZohoPrices && (
            <Button variant="secondary" size="sm" onClick={handleZohoSync} disabled={zohoSyncing}>
              {zohoSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {zohoSyncing ? t('filamentProfiles.syncingZoho') : t('filamentProfiles.syncZohoPrices')}
            </Button>
          )}
          {(canCreate || canUpdate || canDelete) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowSettings((v) => !v)}
              aria-pressed={showSettings}
              disabled={trees.length === 0 && !canUpdate}
            >
              <Settings2 className="h-4 w-4" />
              {t('filamentTrees.settings')}
            </Button>
          )}
        </div>
      </div>

      {zohoResult && <ZohoSyncResult zohoResult={zohoResult} />}

      {loadError ? (
        <div className="animate-rise py-8 text-center">
          <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-red-400" />
          <p className="font-medium text-white">{errorMessage(loadError)}</p>
          <Button
            variant="secondary"
            onClick={() => void Promise.all([treesQuery.refetch(), targetsQuery.refetch()])}
            className="mx-auto mt-4"
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : loading || !targets ? (
        <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
      ) : trees.length === 0 ? (
        <div className="py-12 text-center">
          <p className="font-medium text-white">{t('filamentTrees.emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-bambu-gray">
            {groups.length > 0 ? t('filamentTrees.emptyBody') : t('filamentTrees.emptyNone')}
          </p>
          {groups.length > 0 && canMigrate && (
            <Button onClick={() => setMigrateOpen(true)} className="mx-auto mt-4">
              {t('filamentTrees.organise')}
            </Button>
          )}
          {showSettings && (
            <div className="mx-auto mt-6 max-w-lg text-left">
              <TreeSettingsPanel tree={undefined} targets={targets} />
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-2 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto">
            <TreeNav trees={trees} targets={targets} selected={current} onSelect={setSelected} />
            {unmanagedCount > 0 && canMigrate && (
              <button
                type="button"
                onClick={() => setMigrateOpen(true)}
                className="text-xs text-sky-400 hover:text-sky-300 hover:underline"
              >
                {t('filamentTrees.notInTree', { n: unmanagedCount })}
              </button>
            )}
          </div>
          <div className="min-w-0 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
            {showSettings ? (
              <TreeSettingsPanel key={currentTree?.id ?? 0} tree={currentTree} targets={targets} />
            ) : (
              current && <NodePanel key={JSON.stringify(current)} node={current} />
            )}
          </div>
        </div>
      )}

      {migrateOpen && targets && (
        <MigrateModal
          groups={groups}
          presets={presetsQuery.data ?? []}
          targets={targets}
          onClose={() => setMigrateOpen(false)}
        />
      )}

      {syncOutcome && targets && (
        <SyncResultModal
          result={syncOutcome.result}
          error={syncOutcome.error}
          trees={trees}
          targets={targets}
          onClose={() => setSyncOutcome(null)}
        />
      )}
    </div>
  );
}
