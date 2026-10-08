import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { DuplicateWarning, ProjectSection, RevisionStatus } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { nonPrintableFiles } from './filesUi';
import { useResliceJobs } from '../reslice/useResliceJobs';

/** Every file-panel mutation: run, invalidate the project tree, toast on failure. */
export function useFileActions(projectId: number) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const reslice = useResliceJobs(projectId);
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

  const run = async <T,>(fn: () => Promise<T>, failKey: string): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      showToast(`${t(failKey)}: ${e instanceof Error ? e.message : ''}`, 'error');
      return undefined;
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['project-tree', projectId] });
    }
  };

  const upload = 'projectsPdm.files.uploadFailed';
  const save = 'projectsPdm.files.saveFailed';

  /** False (with a toast) when any file is not a printing file: projects hold printing files
   *  only for now, so nothing is sent. */
  const acceptsFiles = (files: readonly File[]): boolean => {
    if (nonPrintableFiles(files).length === 0) return true;
    showToast(t('projectsPdm.files.onlyPrintable'), 'error');
    return false;
  };

  /** True once the revision is uploaded. */
  const uploadRevision = async (itemId: number, files: File[]): Promise<boolean | undefined> => {
    if (!acceptsFiles(files)) return undefined;
    return whileBusy(itemId, () =>
      run(async () => {
        const res = await api.uploadProjectRevision(itemId, files);
        warn(res.warnings);
        return true;
      }, upload),
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
    download: async (revisionId: number, fileId?: number, filename?: string) => {
      try {
        await api.downloadProjectRevision(revisionId, fileId, filename);
      } catch (e) {
        showToast(`${t(save)}: ${e instanceof Error ? e.message : ''}`, 'error');
      }
    },
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
