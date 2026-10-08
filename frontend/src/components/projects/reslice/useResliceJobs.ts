import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ProjectFileOut, ProjectTreeResponse, ResliceResult } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';

export interface ResliceRun {
  itemId: number;
  jobId: number;
  percent: number | null;
  error: string | null;
  /** undefined = slice only; a task id or null = open the print flow for that order / none once done. */
  queueTaskId: number | null | undefined;
}

export interface ResliceJobs {
  runFor: (itemId: number) => ResliceRun | undefined;
  start: (itemId: number, revisionId: number, fileId: number, pipelineId: number, queueTaskId: number | null | undefined) => Promise<void>;
  dismiss: (itemId: number) => void;
  /** Set when a "Trancher + file" run finished: the panel opens the print flow for it. */
  printNext: { file: ProjectFileOut; taskId: number | null } | null;
  clearPrintNext: () => void;
}

const POLL_MS = 1500;

/** Re-trancher runs of one project, keyed by item (one run per item at a time).
 *  Lives with the files panel: leaving the page stops polling, but the backend still
 *  creates the revision; "Trancher + file" then does not open the print flow. */
export function useResliceJobs(projectId: number): ResliceJobs {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [runs, setRuns] = useState<ReadonlyMap<number, ResliceRun>>(() => new Map());
  const [printNext, setPrintNext] = useState<ResliceJobs['printNext']>(null);
  const runsRef = useRef(runs);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);
  // Unmount-only guard for a completion in flight. Not the poll effect's `cancelled`: that
  // effect restarts whenever the number of pending runs changes, which a completion itself
  // causes (its run is removed before the tree loads) as does another item starting a run.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const update = useCallback((itemId: number, next: ResliceRun | null) => {
    setRuns((prev) => {
      const map = new Map(prev);
      if (next) map.set(itemId, next);
      else map.delete(itemId);
      return map;
    });
  }, []);

  const start = useCallback<ResliceJobs['start']>(
    async (itemId, revisionId, fileId, pipelineId, queueTaskId) => {
      try {
        const res = await api.resliceProjectRevision(revisionId, { file_id: fileId, pipeline_id: pipelineId });
        update(itemId, { itemId, jobId: res.job_id, percent: null, error: null, queueTaskId });
      } catch (e) {
        showToast(`${t('projectsPdm.reslice.startFailed')}: ${e instanceof Error ? e.message : ''}`, 'error');
      }
    },
    [showToast, t, update],
  );

  const finish = useCallback(
    async (run: ResliceRun, result: ResliceResult) => {
      update(run.itemId, null);
      let tree: ProjectTreeResponse | undefined;
      try {
        tree = await queryClient.fetchQuery<ProjectTreeResponse>({
          queryKey: ['project-tree', projectId],
          queryFn: () => api.getProjectTree(projectId),
          staleTime: 0,
        });
      } catch {
        // The revision exists anyway; the panel refetches on its own.
      }
      if (!mountedRef.current) return;
      const items = tree?.sections.flatMap((s) => s.items) ?? [];
      const file =
        result.file_id === null
          ? undefined
          : items.flatMap((i) => i.revisions).flatMap((r) => r.files).find((f) => f.id === result.file_id);
      const name = items.find((i) => i.id === result.item_id)?.name ?? result.filename;
      const values = { name, number: result.revision_number };
      if (run.queueTaskId !== undefined && !file) {
        showToast(t('projectsPdm.reslice.queueSkipped', values), 'info');
        return;
      }
      showToast(t('projectsPdm.reslice.done', values), 'success');
      if (run.queueTaskId !== undefined && file) setPrintNext({ file, taskId: run.queueTaskId });
    },
    [projectId, queryClient, showToast, t, update],
  );

  const pending = [...runs.values()].filter((r) => r.error === null).length;
  useEffect(() => {
    if (pending === 0) return;
    let cancelled = false;
    let polling = false; // one poll round in flight at a time (see SliceJobTrackerContext)
    const timer = setInterval(async () => {
      if (cancelled || polling) return;
      polling = true;
      try {
        for (const run of [...runsRef.current.values()].filter((r) => r.error === null)) {
          try {
            const state = await api.getSliceJob(run.jobId);
            if (cancelled) return;
            // Dismissed or replaced while the request was in flight.
            if (runsRef.current.get(run.itemId)?.jobId !== run.jobId) continue;
            if (state.status === 'completed' && state.result && 'revision_id' in state.result) {
              await finish(run, state.result);
            } else if (state.status === 'failed') {
              update(run.itemId, { ...run, error: state.error_detail || t('common.unknownError') });
            } else {
              update(run.itemId, { ...run, percent: state.progress ? Math.round(state.progress.total_percent) : null });
            }
          } catch {
            // transient: retry next tick
          }
        }
      } finally {
        polling = false;
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pending, finish, t, update]);

  return {
    runFor: (itemId: number) => runs.get(itemId),
    start,
    dismiss: (itemId: number) => update(itemId, null),
    printNext,
    clearPrintNext: () => setPrintNext(null),
  };
}
