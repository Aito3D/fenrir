import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { DuplicateWarning, ProjectFileOut, ProjectRevisionOut, ProjectSection, RevisionStatus } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useAuth } from '../../../contexts/AuthContext';
import { uiSettingsQuery } from '../../../hooks/useUiSettings';
import { openInSlicer, resolveDesktopSlicer } from '../../../utils/slicer';
import { useResliceJobs } from '../reslice/useResliceJobs';
import { failureMessage } from '../failureMessage';
import { projectKeys } from '../projectQueries';
import { useAcceptsSource } from '../aito/dropFiles';
import { refusalMessage } from './filesUi';

/** Every file-panel mutation: run, invalidate the project tree, toast on failure. */
export function useFileActions(projectId: number) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const reslice = useResliceJobs(projectId);
  const { hasPermission } = useAuth();
  /** False (with a toast) unless the files are one source `.3mf`: sliced files are made by the
   *  server and a revision holds a single project file, so nothing else is sent. Content checks
   *  (already sliced, no printer setup) stay server-side. */
  const acceptsSource = useAcceptsSource();
  const acceptsFiles = (files: readonly File[]): boolean => {
    if (!acceptsSource(files)) return false;
    if (files.length > 1) {
      showToast(t('projectsPdm.files.oneFile'), 'error');
      return false;
    }
    return true;
  };
  // Items with an upload in flight: their upload and drop actions are off meanwhile.
  const [busyItems, setBusyItems] = useState<ReadonlySet<number>>(() => new Set());

  const whileBusy = async <T,>(itemId: number, fn: () => Promise<T>): Promise<T> => {
    setBusyItems((prev) => new Set(prev).add(itemId));
    try {
      return await fn();
    } finally {
      setBusyItems((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
    }
  };

  const warn = (warnings: DuplicateWarning[]) =>
    warnings.forEach((w) =>
      showToast(t('projectsPdm.files.duplicateWarning', { filename: w.filename, revision: w.same_as }), 'info'),
    );

  const run = async <T,>(fn: () => Promise<T>, failKey: string, files?: readonly File[]): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      const mapped = files && e instanceof Error ? refusalMessage(t, e.message, files[0]?.name ?? '') : null;
      showToast(mapped ?? failureMessage(t, failKey, e), 'error');
      return undefined;
    } finally {
      await queryClient.invalidateQueries({ queryKey: projectKeys.tree(projectId) });
    }
  };

  const upload = 'projectsPdm.files.uploadFailed';
  const save = 'projectsPdm.files.saveFailed';

  /** The uploaded revision (with its slicing state), or undefined when refused or failed. */
  const uploadRevision = async (itemId: number, files: File[]): Promise<ProjectRevisionOut | undefined> => {
    if (!acceptsFiles(files)) return undefined;
    return whileBusy(itemId, () =>
      run(
        async () => {
          const res = await api.uploadProjectRevision(itemId, files);
          warn(res.warnings);
          return res.revision;
        },
        upload,
        files,
      ),
    );
  };

  return {
    projectId,
    reslice,
    acceptsFiles,
    isBusy: (itemId: number) => busyItems.has(itemId),
    uploadRevision,
    /** Creates an empty item; resolves to its id. Upload with `uploadRevision`, so a failed upload
     * is retried on the same item instead of creating it again. */
    createItem: (section: ProjectSection, name: string) =>
      run(async () => (await api.createProjectItem(projectId, section, name)).id, save),
    addFiles: async (itemId: number, revisionId: number, files: File[]) => {
      if (!acceptsFiles(files)) return;
      await whileBusy(itemId, () =>
        run(async () => warn((await api.addProjectRevisionFiles(revisionId, files)).warnings), upload),
      );
    },
    removeFile: (revisionId: number, fileId: number) => run(() => api.removeProjectRevisionFile(revisionId, fileId), save),
    setStatus: (revisionId: number, status: RevisionStatus) => run(() => api.updateProjectRevision(revisionId, { status }), save),
    setNote: (revisionId: number, note: string | null) => run(() => api.updateProjectRevision(revisionId, { note }), save),
    setDerived: (revisionId: number, id: number | null) =>
      run(() => api.updateProjectRevision(revisionId, { derived_from_id: id }), save),
    deleteRevision: (revisionId: number) => run(() => api.deleteProjectRevision(revisionId), save),
    renameItem: (itemId: number, name: string) => run(() => api.renameProjectItem(itemId, name), save),
    deleteItem: (itemId: number) => run(() => api.deleteProjectItem(itemId), save),
    fork: (itemId: number, revisionId: number, name: string) => run(() => api.forkProjectItem(itemId, revisionId, name), save),
    /** Starts (or retries) the server slice of a revision's source `.3mf`; the tree then polls it. */
    sliceRevision: (revisionId: number) => run(() => api.sliceProjectRevision(revisionId), 'projectsPdm.reslice.startFailed'),
    /** The File Manager's desktop handoff (FileManagerPage `handleOpenInSlicer`): a short-lived
     *  slicer token for the file, then the preferred desktop slicer's URL scheme. On failure, the
     *  same toast and the plain download URL (works when auth is off). */
    openInSlicer: async (file: ProjectFileOut) => {
      // Read at click time (cached by every page that shows settings), not observed: the panel
      // need not fetch the settings for a handoff nobody may use.
      const settings = await queryClient
        .fetchQuery({ ...uiSettingsQuery(hasPermission('settings:read')), staleTime: 60_000 })
        .catch(() => undefined);
      const slicer = resolveDesktopSlicer(settings?.open_in_slicer, settings?.preferred_slicer);
      try {
        const { token } = await api.createLibrarySlicerToken(file.id);
        const path = api.getLibrarySlicerDownloadUrl(file.id, token, file.filename);
        openInSlicer(`${window.location.origin}${path}`, slicer);
      } catch {
        showToast(t('fileManager.toast.openInSlicerFailed'), 'error');
        openInSlicer(`${window.location.origin}${api.getLibraryFileDownloadUrl(file.id)}`, slicer);
      }
    },
    download: async (revisionId: number, fileId?: number, filename?: string) => {
      try {
        await api.downloadProjectRevision(revisionId, fileId, filename);
      } catch (e) {
        showToast(failureMessage(t, save, e), 'error');
      }
    },
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
