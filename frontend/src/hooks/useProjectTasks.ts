import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AitoTask, type AitoTaskCreate, type AitoTaskUpdate } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { emptyTaskDraft, taskDraftFromAitoTask, taskDraftToTaskCreate } from '../utils/taskDraft';
import type { TaskDraft } from '../utils/taskDraft';

/** Long enough that a typed number lands as one PATCH, short enough that the
 *  save feels immediate. Blur and close both flush early, so this is only ever
 *  the ceiling on how long an unsaved edit can sit. */
const DEBOUNCE_MS = 500;

/** The narrow patch: only the wire fields that actually differ between the
 *  persisted row and the edited draft. Comparing the two *wire* shapes
 *  (rather than the drafts directly) means the blank -> null and 0-stays-0
 *  rules apply identically on both sides of the diff.
 *
 *  Driven by the wire shape's own keys rather than a hand-written list of
 *  comparisons. The previous version needed one line per field and had grown
 *  to sixteen; a field added to `taskDraftToTaskCreate` and forgotten here
 *  would silently never save, which is exactly what happened four times when
 *  the `*_done` flags landed.
 *
 *  Exported for its unit test — the "covers every field" case is the guard
 *  that keeps this honest. */
export function diffTaskDraft(baseline: TaskDraft, next: TaskDraft): AitoTaskUpdate {
  const before = taskDraftToTaskCreate(baseline);
  const after = taskDraftToTaskCreate(next);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof AitoTaskCreate)[]) {
    if (after[key] !== before[key]) patch[key] = after[key];
  }
  return patch as AitoTaskUpdate;
}

/** The whole task-editing lifecycle for one project: the editable array, the
 *  per-row debounce, the four mutations, and the board-refresh arbitration.
 *
 *  Extracted from ProjectDetailPanel, which had grown to 579 lines around four
 *  interdependent refs. All of that reasoning is preserved below — it was
 *  correct, it was just impossible to test without mounting a modal. */
export function useProjectTasks(projectId: number) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const tasksQuery = useQuery({
    queryKey: ['aito-tasks', projectId],
    queryFn: () => api.getAitoTasks(projectId),
  });
  const [tasks, setTasks] = useState<TaskDraft[]>([]);

  // The diff baseline: the last-known-persisted row per task id. Deliberately
  // NOT the query cache — writing a PATCH response into ['aito-tasks', id]
  // would change that query's data identity, and the resync effect below would
  // then resync every row, stomping any other row's unsaved or in-flight edit.
  const baselineRef = useRef<Map<number, AitoTask>>(new Map());

  // Pending debounced patch per task id. Typing a cost, then a colour, then
  // closing inside one window must send both fields — see `onTasksChange`
  // for how the stored patch stays a full diff-from-baseline (so it always
  // covers every field touched since the last flush) without ever becoming
  // a stale, spread-merged accumulation that a reverted field can get stuck in.
  const pendingRef = useRef<Map<number, { patch: AitoTaskUpdate; timer: ReturnType<typeof setTimeout> }>>(new Map());

  // Set when a task field is actually saved. Task edits must never invalidate
  // the board directly — the board is refreshed once, on close, and only if
  // something was really saved: a panel opened and closed without edits must
  // cost nothing.
  const tasksDirtyRef = useRef(false);

  // "The panel closed" and "the last task PATCH landed" are two independent
  // events and either can happen first. The board must be refreshed on
  // whichever is LAST, because refreshing while a PATCH is open races it (a
  // GET served first writes a pre-PATCH total that nothing corrects, since
  // staleTime is 60s app-wide), and refreshing on the dirty flag alone misses
  // the mirror case where the one PATCH is still open at close. Hence the
  // counter: onSettled owns close-first, the unmount effect owns settle-first,
  // and both require the same two conditions so exactly one fires.
  const closedRef = useRef(false);
  const inFlightRef = useRef(0);

  useEffect(() => {
    if (!tasksQuery.data) return;
    setTasks(tasksQuery.data.map(taskDraftFromAitoTask));
    baselineRef.current = new Map(tasksQuery.data.map((row) => [row.id, row]));
  }, [tasksQuery.data]);

  const invalidateTasksAndBoard = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['aito-tasks', projectId] });
    queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
  }, [queryClient, projectId]);

  const updateTaskMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: AitoTaskUpdate }) => api.updateAitoTask(id, patch),
    onMutate: () => {
      inFlightRef.current += 1;
    },
    onSuccess: (updatedTask, { patch }) => {
      // Advance the baseline for this row only: without it, reverting a field
      // to its originally-loaded value diffs as "no change" against a stale
      // baseline and the PATCH is silently dropped.
      baselineRef.current.set(updatedTask.id, updatedTask);
      tasksDirtyRef.current = true;
      // A tick is one deliberate click and can change the project's COLUMN, so
      // it refreshes now — the panel's Stage row and the card move together.
      const tickedAStep = ['scan_done', 'modelisation_done', 'impression_done', 'usinage_done'].some(
        (key) => key in patch,
      );
      if (tickedAStep) queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
    // Mutation-level, so React Query still runs it after this hook unmounts —
    // which is the point: the write that lands after close triggers the refresh.
    onSettled: () => {
      inFlightRef.current -= 1;
      if (closedRef.current && inFlightRef.current === 0 && tasksDirtyRef.current) {
        queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      }
    },
  });

  const flush = useCallback(
    (taskId: number) => {
      const entry = pendingRef.current.get(taskId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingRef.current.delete(taskId);
      if (Object.keys(entry.patch).length === 0) return;
      updateTaskMutation.mutate({ id: taskId, patch: entry.patch });
    },
    [updateTaskMutation],
  );

  const flushAll = useCallback(() => {
    for (const taskId of [...pendingRef.current.keys()]) flush(taskId);
  }, [flush]);

  const addTaskMutation = useMutation({
    mutationFn: () => api.createAitoTask(projectId, taskDraftToTaskCreate(emptyTaskDraft())),
    onSuccess: invalidateTasksAndBoard,
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => api.deleteAitoTask(id),
    onSuccess: invalidateTasksAndBoard,
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  // TaskEditor is fully controlled and reports the whole array on every edit.
  // Growing the array is always "+ Add task", so that case routes to the
  // create endpoint. Otherwise exactly one entry has a new object identity,
  // which pinpoints the task to diff without comparing every field of every row.
  const onTasksChange = useCallback(
    (next: TaskDraft[]) => {
      if (next.length > tasks.length) {
        addTaskMutation.mutate();
        return;
      }
      const changedIndex = next.findIndex((task, i) => task !== tasks[i]);
      if (changedIndex === -1) return;
      setTasks(next);

      const edited = next[changedIndex];
      if (edited.id === null) return; // not yet persisted; nothing to PATCH
      const taskId = edited.id;
      const baselineRow = baselineRef.current.get(taskId);
      if (!baselineRow) return;
      // `edited` is the row's full, cumulative draft (TaskEditor is fully
      // controlled — see its own docstring), not just the field that changed
      // this call. Diffing it against the ORIGINAL baseline therefore already
      // yields the complete pending patch across every field touched since
      // the last flush: typing a cost, then a colour, produces one patch with
      // both keys without any explicit merging.
      //
      // This must be a straight replace of whatever was pending, not a
      // `{...existing.patch, ...patch}` spread-merge: a spread can only add
      // or overwrite keys, never remove one. If a field is edited away from
      // its baseline and then back to it, the fresh diff correctly omits that
      // key (no change from baseline) — but a spread-merge would still carry
      // the stale key forward from the previous call forever, so the revert
      // would silently re-send a value the user no longer has on screen.
      const patch = diffTaskDraft(taskDraftFromAitoTask(baselineRow), edited);

      const existing = pendingRef.current.get(taskId);
      if (existing) clearTimeout(existing.timer);
      pendingRef.current.set(taskId, {
        patch,
        timer: setTimeout(() => flush(taskId), DEBOUNCE_MS),
      });
    },
    [tasks, addTaskMutation, flush],
  );

  const onRemoveTask = useCallback(
    (index: number) => {
      const task = tasks[index];
      if (!task) return;
      if (task.id === null) {
        setTasks(tasks.filter((_, i) => i !== index));
        return;
      }
      // Drop any queued patch for a row about to be deleted.
      const pending = pendingRef.current.get(task.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRef.current.delete(task.id);
      }
      deleteTaskMutation.mutate(task.id);
    },
    [tasks, deleteTaskMutation],
  );

  const markClosed = useCallback(() => {
    flushAll();
    closedRef.current = true;
  }, [flushAll]);

  const flushAllRef = useRef(flushAll);
  flushAllRef.current = flushAll;
  const invalidateRef = useRef(invalidateTasksAndBoard);
  invalidateRef.current = invalidateTasksAndBoard;

  useEffect(
    () => {
      // StrictMode runs setup -> cleanup -> setup on mount in development, and
      // a ref survives that simulated remount. Without this reset the hook
      // would sit at closed=true from its first render, so every save's
      // onSettled would satisfy the guard and invalidate the board — the exact
      // per-keystroke refetch the counter exists to prevent, in dev only.
      closedRef.current = false;
      return () => {
        flushAllRef.current();
        closedRef.current = true;
        // Only when every PATCH has already landed. If any is still open, the
        // refresh is onSettled's job: invalidating now would race the write it
        // is supposed to reflect.
        if (tasksDirtyRef.current && inFlightRef.current === 0) {
          invalidateRef.current();
        }
      };
    },
    // Deliberately empty: this must fire exactly once, on unmount. The two
    // refs above keep the latest callbacks reachable without re-arming it.
    [],
  );

  return { tasks, onTasksChange, onRemoveTask, onRowBlur: flush, markClosed };
}
