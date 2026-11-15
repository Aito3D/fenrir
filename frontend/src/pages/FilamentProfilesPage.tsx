import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Database, Download, Droplets, HardDrive, Loader2, Plus, RefreshCw, Settings2, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import type { FilamentTreePullResult } from '../api/client';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/ConfirmModal';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { Skeleton } from '../components/Skeleton';
import { SyncBaseResultModal } from '../components/filament-profiles/SyncBaseResultModal';
import { SyncModal } from '../components/filament-profiles/SyncModal';
import { useBaseSync, usePcSync } from '../components/filament-profiles/usePresetSyncs';
import { ZohoSyncResult } from '../components/filament-profiles/ZohoSyncResult';
import { errorMessage } from '../components/filament-trees/errorMessage';
import { useZohoSync } from '../components/filament-profiles/useZohoSync';
import { downloadTreeExport } from '../components/filament-trees/exportDownload';
import { MigrateModal } from '../components/filament-trees/MigrateModal';
import { MaterialCards } from '../components/filament-trees/MaterialCards';
import { NodePanel, type NodeRef } from '../components/filament-trees/NodePanel';
import { SyncResultModal } from '../components/filament-trees/SyncResultModal';
import { NewTreeModal } from '../components/filament-trees/NewTreeModal';
import { TargetsModal } from '../components/filament-trees/TargetsModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';

/**
 * Filament Profiles: the profile trees as material cards (cards left, settings right; stacked below xl),
 * SYNC pull from Orca Cloud, migration of loose presets, and a "Sync & export" menu (Orca export, Zoho prices,
 * Bambu base, PC, printers and nozzles). The open node lives in the URL: ?tree=&color=&m=&n=.
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

  const [params, setParams] = useSearchParams();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuButtonRef = useRef<HTMLSpanElement>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [cleanup, setCleanup] = useState<{ count: number; busy: boolean } | null>(null);
  const [syncOutcome, setSyncOutcome] = useState<{ result?: FilamentTreePullResult; error?: unknown } | null>(null);
  const { zohoSyncing, zohoResult, handleZohoSync } = useZohoSync();
  // The generated rows: source colour names for the migration modal, and what "Sync to PC" writes.
  const presetsQuery = useQuery({
    queryKey: ['filamentPresets'],
    queryFn: api.getFilamentPresets,
    enabled: migrateOpen || canUpdate,
  });
  // Bambu Studio side: refresh the base-preset index (server scan, else browser upload) and mirror the rows to the PC.
  const { syncBaseBusy, syncBaseModal, setSyncBaseModal, baseFileInputRef, handleSyncBase, handleBaseFilesSelected } =
    useBaseSync();
  const { syncModal, setSyncModal, handleSyncToPc, handleSyncConfirm } = usePcSync(presetsQuery.data ?? []);

  const trees = treesQuery.data ?? [];
  const groups = unmanagedQuery.data ?? [];
  const unmanagedCount = groups.reduce((n, g) => n + g.preset_ids.length, 0);
  const targets = targetsQuery.data;
  const pendingExport = trees.reduce((n, tr) => n + (tr.export_pending ?? 0), 0);

  // One level (machine, nozzle) for every card and the panel; the URL keeps it with the open tree and colour.
  const machine = params.get('m') ?? '';
  const nozzle = (machine && params.get('n')) || '';
  const patchParams = (patch: Record<string, string | undefined>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { replace: true },
    );
  const select = (node: NodeRef) => patchParams({ tree: String(node.treeId), color: node.colorId?.toString() });
  // Falls back to the first tree's root until the user picks a node (or when the picked tree is gone).
  const currentTree = trees.find((tr) => tr.id === Number(params.get('tree'))) ?? trees[0];
  const colorId = currentTree?.colors.find((c) => c.id === Number(params.get('color')))?.id;
  // a colour opens colour-wide (no machine) or as a leaf (machine + nozzle), never at the machine level
  const current: NodeRef | null = currentTree
    ? {
        treeId: currentTree.id,
        machine: machine || undefined,
        nozzle: nozzle || undefined,
        colorId: !machine || nozzle ? colorId : undefined,
      }
    : null;
  const no02 = !!currentTree && nozzle === '0.2' && (currentTree.skip_02 ?? currentTree.abrasive);
  const exportOrca = (changedOnly: boolean) =>
    downloadTreeExport(undefined, changedOnly)
      .then(() => queryClient.invalidateQueries({ queryKey: ['filament-trees'] }))
      .catch((err) => showToast(errorMessage(err), 'error'));

  const previewCleanup = () =>
    api
      .getOrcaCleanupPreview()
      .then((p) => {
        if (!p.writable) showToast(t('filamentTrees.cleanOrcaReadOnly'), 'error');
        else if (p.count === 0) showToast(t('filamentTrees.cleanOrcaNone'), 'success');
        else setCleanup({ count: p.count, busy: false });
      })
      .catch((err) => showToast(errorMessage(err), 'error'));
  const confirmCleanup = (count: number) => {
    setCleanup({ count, busy: true });
    api
      .cleanOrcaCloud(count)
      .then((r) => showToast(t('filamentTrees.cleanOrcaDone', r), r.failed ? 'error' : 'success'))
      .catch((err) => showToast(errorMessage(err), 'error'))
      .finally(() => setCleanup(null));
  };

  const menuItems: ContextMenuItem[] = [
    ...(canUpdate
      ? [
          { label: t('filamentTrees.exportOrca'), icon: <Download className="h-4 w-4" />, onClick: () => void exportOrca(false), disabled: trees.length === 0 },
          {
            label: t('filamentTrees.exportChanged', { n: pendingExport }),
            icon: <Download className="h-4 w-4" />,
            onClick: () => void exportOrca(true),
            disabled: pendingExport === 0,
          },
        ]
      : []),
    ...(canSync && canDelete
      ? [{ label: t('filamentTrees.cleanOrca'), icon: <Trash2 className="h-4 w-4" />, onClick: () => void previewCleanup() }]
      : []),
    ...(canSyncZohoPrices
      ? [{ label: t('filamentProfiles.syncZohoPrices'), icon: <RefreshCw className="h-4 w-4" />, onClick: handleZohoSync, disabled: zohoSyncing }]
      : []),
    ...(canUpdate
      ? [
          { label: t('filamentProfiles.syncBase'), icon: <Database className="h-4 w-4" />, onClick: handleSyncBase, disabled: syncBaseBusy },
          {
            label: t('filamentProfiles.syncToPc'),
            icon: <HardDrive className="h-4 w-4" />,
            onClick: handleSyncToPc,
            disabled: !presetsQuery.data || presetsQuery.data.length === 0,
          },
          { label: '', onClick: () => {}, divider: true },
          { label: t('filamentTrees.targetsTitle'), icon: <Settings2 className="h-4 w-4" />, onClick: () => setTargetsOpen(true) },
        ]
      : []),
  ];
  const busy = zohoSyncing || syncBaseBusy;

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
          {canSync && pendingExport > 0 && (
            // shortcut: local count of leaves edited since the last push/export; the push itself diffs against Orca Cloud, so it can send more (e.g. profiles missing there). Upgrade to a dry-run endpoint if the gap matters.
            // unfolds on arrival so the buttons after it slide over instead of jumping
            <span className="aito-unfold-x -ml-1">
              <span>
                <span
                  data-testid="sync-pending-count"
                  title={t('filamentTrees.pendingExport', { n: pendingExport })}
                  className="rounded-full bg-sky-400/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-sky-300"
                >
                  {pendingExport}
                </span>
              </span>
            </span>
          )}
          {canCreate && targets && (
            <Button variant="secondary" size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" />
              {t('filamentTrees.newFilament')}
            </Button>
          )}
          <span ref={menuButtonRef} className="inline-flex">
          <Button
            variant="secondary"
            size="sm"
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={() => {
              const r = menuButtonRef.current?.getBoundingClientRect();
              setMenu(menu ? null : { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t('filamentTrees.moreActions')}
            {pendingExport > 0 && <span className="h-2 w-2 rounded-full bg-sky-400" aria-hidden />}
            <ChevronDown className="h-4 w-4" />
          </Button>
          </span>
          {/* Upload fallback for Sync base, opened when the server has no Bambu Studio bundle (Docker deploys). */}
          <input
            ref={baseFileInputRef}
            data-testid="fp-base-file-input"
            type="file"
            accept=".json,.zip"
            multiple
            className="hidden"
            onChange={handleBaseFilesSelected}
          />
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
      ) : loading || !targets || (trees.length === 0 && unmanagedQuery.isLoading) ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-busy="true" aria-label={t('common.loading')}>
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : trees.length === 0 ? (
        <div className="animate-rise py-12 text-center">
          <p className="font-medium text-white">{t('filamentTrees.emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-bambu-gray">
            {unmanagedQuery.isError
              ? errorMessage(unmanagedQuery.error)
              : groups.length > 0
                ? t('filamentTrees.emptyBody')
                : t('filamentTrees.emptyNone')}
          </p>
          {groups.length > 0 && canMigrate && (
            <Button onClick={() => setMigrateOpen(true)} className="mx-auto mt-4">
              {t('filamentTrees.organise')}
            </Button>
          )}
        </div>
      ) : (
        <>
          {unmanagedCount > 0 && canMigrate && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5">
              <span className="text-sm text-sky-200">{t('filamentTrees.notInTree', { n: unmanagedCount })}</span>
              <Button size="sm" variant="secondary" onClick={() => setMigrateOpen(true)} className="ml-auto">
                {t('filamentTrees.organise')}
              </Button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="min-w-0 animate-rise">
              <MaterialCards
                trees={trees}
                targets={targets}
                selected={current}
                onSelect={select}
                machine={machine}
                nozzle={nozzle}
                onLevel={(m, n) => patchParams({ m, n })}
              />
            </div>
            <div className="min-w-0 animate-rise self-start rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4 [animation-delay:80ms] xl:sticky xl:top-4">
              {no02 ? (
                <p className="text-sm text-amber-300/80">{t('filamentTrees.no02')}</p>
              ) : (
                current && <NodePanel key={JSON.stringify(current)} node={current} onCreated={(treeId) => select({ treeId })} />
              )}
            </div>
          </div>
        </>
      )}

      {/* outside the header: its entrance animation makes a stacking context the panel would paint over */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} anchorRef={menuButtonRef} />}
      {targetsOpen && targets && <TargetsModal targets={targets} onClose={() => setTargetsOpen(false)} />}
      {newOpen && targets && <NewTreeModal targets={targets} onClose={() => setNewOpen(false)} onCreated={(treeId) => select({ treeId })} />}

      {migrateOpen && targets && (
        <MigrateModal
          groups={groups}
          presets={presetsQuery.data ?? []}
          targets={targets}
          onClose={() => setMigrateOpen(false)}
        />
      )}

      {syncModal && (
        <SyncModal
          state={syncModal.state}
          stats={syncModal.stats}
          onCancel={() => setSyncModal(null)}
          onConfirm={handleSyncConfirm}
          onClose={() => setSyncModal(null)}
          canConfirm={canDelete}
        />
      )}

      {syncBaseModal && (
        <SyncBaseResultModal
          result={syncBaseModal.result}
          error={syncBaseModal.error}
          onClose={() => setSyncBaseModal(null)}
        />
      )}

      {cleanup && (
        <ConfirmModal
          title={t('filamentTrees.cleanOrcaTitle')}
          message={t('filamentTrees.cleanOrcaConfirm', { n: cleanup.count })}
          variant="danger"
          isLoading={cleanup.busy}
          onConfirm={() => confirmCleanup(cleanup.count)}
          onCancel={() => setCleanup(null)}
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
