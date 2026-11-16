import { useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../../api/client';
import type { FilamentBaseSyncResult, FilamentPreset, FilamentSyncStats } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { collectPresetFiles } from './pickedFiles';
import { errorMessage } from '../filament-trees/errorMessage';

type SyncBaseModalState = { result?: FilamentBaseSyncResult; error?: string; fromUpload?: boolean } | null;
type SyncModalState = { state: 'syncing' | 'preview' | 'done'; stats?: FilamentSyncStats } | null;

/** "Sync base": index Bambu Studio's bundled presets, from the server's install or from uploaded files. */
export function useBaseSync() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const baseFileInputRef = useRef<HTMLInputElement>(null);
  const [syncBaseBusy, setSyncBaseBusy] = useState(false);
  const [syncBaseModal, setSyncBaseModal] = useState<SyncBaseModalState>(null);

  // ── Sync base (spec §5.2) ───────────────────────────────────────────────
  const handleSyncBase = async () => {
    setSyncBaseBusy(true);
    try {
      const result = await api.syncBaseFilamentPresets();
      // total 0 = remote deploy with no Bambu Studio bundle: the modal offers the upload picker, which a browser
      // only opens from the operator's own click (not after this await)
      setSyncBaseModal({ result });
    } catch (err) {
      setSyncBaseModal({ error: errorMessage(err) });
    } finally {
      setSyncBaseBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['filamentBasePresets'] });
    }
  };

  // ── Base presets from browser-picked files (upload fallback) ────────────
  const handleBaseFilesSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    // Snapshot the live FileList before resetting the input — clearing
    // `value` empties `files` (see handleFilesSelected).
    const pickedFiles = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (pickedFiles.length === 0 || syncBaseBusy) return;
    setSyncBaseBusy(true);
    try {
      const collected = await collectPresetFiles(pickedFiles);
      if (collected.length === 0) {
        showToast(t('filamentProfiles.noJsonInSelection'), 'error');
        return;
      }
      const result = await api.uploadBaseFilamentPresets(collected);
      setSyncBaseModal({ result, fromUpload: true });
    } catch (err) {
      setSyncBaseModal({ error: errorMessage(err) });
    } finally {
      setSyncBaseBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['filamentBasePresets'] });
    }
  };

  return { syncBaseBusy, syncBaseModal, setSyncBaseModal, baseFileInputRef, handleSyncBase, handleBaseFilesSelected };
}

/** "Sync to PC": mirror the presets into the server's Bambu Studio folders, preview first. */
export function usePcSync(presets: FilamentPreset[]) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [syncModal, setSyncModal] = useState<SyncModalState>(null);
  const syncPayloadRef = useRef<{ filename: string; content: string }[]>([]);

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

  return { syncModal, setSyncModal, handleSyncToPc, handleSyncConfirm };
}
