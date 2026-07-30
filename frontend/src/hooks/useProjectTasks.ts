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

  // A refetch (`refetchOnWindowFocus`, an add/delete's `invalidateTasksAndBoard`
  // firing while another row is mid-edit, or a late `onSettled` landing after
  // reopen) must not overwrite a row that has a debounced edit not yet sent
  // (`pendingRef`) or a PATCH still in flight (`inFlightRef`) — doing so would
  // both show the pre-edit value AND move `baselineRef` to it, so a later edit
  // diffs against the wrong baseline and silently never re-sends the field.
  // Mirrors `useBoardDrag`'s `pendingMoves`/`syncGeneration` guard on the
  // identical race. `tasksSyncGeneration` is bumped from `updateTaskMutation`'s
  // `onSettled` so a sync skipped while blocked gets a chance to re-run once
  // things go quiet, even on a render where `tasksQuery.data`'s identity does
  // not itself change.
  const [tasksSyncGeneration, setTasksSyncGeneration] = useState(0);

  // The `tasksQuery.data` reference this hook has already applied to `tasks`.
  // Without this, the generation bump above would re-run the sync on EVERY
  // settle even when `tasksQuery.data` has not actually changed since it was
  // last applied — reapplying that same (by now stale) snapshot would revert
  // the very edit that just finished saving, since a task PATCH's response is
  // deliberately never written into the `['aito-tasks', id]` cache (see
  // `baselineRef` above). Comparing against the last-applied reference makes
  // the generation bump a genuine no-op unless a real fetch landed while this
  // effect was blocked.
  const appliedDataRef = useRef<AitoTask[] | undefined>(undefined);

  // Wall-clock time (`Date.now()`) of the last successful task PATCH,
  // stamped from `updateTaskMutation`'s `onSuccess`. The guard above (empty
  // `pendingRef`/`inFlightRef`) says it's now SAFE to resync, but doesn't
  // say the cached `tasksQuery.data` is actually fresh enough to resync
  // WITH: a refetch that landed mid-debounce and lost the guard's race gets
  // cached, and the generation bump from the save that beat it re-runs this
  // effect the instant that save settles — with that same stale, pre-edit
  // snapshot still sitting in `tasksQuery.data`. Applying it would silently
  // revert the value that had just saved, one debounce window later than
  // the guard the resync effect exists to satisfy. Comparing the snapshot's
  // own fetch time against the last save catches that: a snapshot fetched
  // before the save landed is asked for again instead of being trusted.
  const lastSaveAtRef = useRef(0);

  // The `lastSaveAtRef` stamp the staleness check below last issued an
  // invalidate for. Recovery is one-shot per stamp: if the system clock
  // steps backwards after a save stamps `lastSaveAtRef` (an NTP correction,
  // a user changing the clock), EVERY subsequent fetch lands with
  // `dataUpdatedAt` reading before that stamp, and `dataUpdatedAt` is a
  // dependency of the effect — so without this guard, each landing would
  // re-run the effect, invalidate, refetch, and land stale again, forever,
  // with no backoff. Comparing against the stamp this ref already tried
  // caps it at one invalidate per save: a second encounter with the same
  // stamp falls through and applies the (possibly stale) snapshot instead.
  // Accepted trade — a screen behind by one save is strictly better than an
  // unthrottled request loop, and the next genuine fetch or edit corrects it.
  const invalidatedForStampRef = useRef(0);

  useEffect(() => {
    if (!tasksQuery.data) return;
    if (pendingRef.current.size > 0 || inFlightRef.current > 0) return;
    if (appliedDataRef.current === tasksQuery.data) return;
    if (
      tasksQuery.dataUpdatedAt <= lastSaveAtRef.current &&
      invalidatedForStampRef.current !== lastSaveAtRef.current
    ) {
      // This snapshot predates (or ties, at millisecond resolution) the last
      // successful save, so it cannot be applied without clobbering that
      // save. Ask for a fresh one instead of silently trusting a stale one —
      // the fetch it triggers will land with a newer `dataUpdatedAt` and this
      // effect will re-run and apply it normally.
      invalidatedForStampRef.current = lastSaveAtRef.current;
      queryClient.invalidateQueries({ queryKey: ['aito-tasks', projectId] });
      return;
    }
    appliedDataRef.current = tasksQuery.data;
    setTasks(tasksQuery.data.map(taskDraftFromAitoTask));
    baselineRef.current = new Map(tasksQuery.data.map((row) => [row.id, row]));
  }, [tasksQuery.data, tasksQuery.dataUpdatedAt, tasksSyncGeneration, queryClient, projectId]);

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
      // See `lastSaveAtRef`'s doc above the resync effect: this stamp is
      // what stops that effect from applying a cached snapshot older than
      // this save over the value that just landed.
      lastSaveAtRef.current = Date.now();
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
      // Re-run the resync effect: this may be the thing that finally makes
      // `pendingRef.current.size === 0 && inFlightRef.current === 0` true for
      // a sync that was skipped while this PATCH (or another row's debounced
      // edit) was outstanding.
      setTasksSyncGeneration((generation) => generation + 1);
      if (closedRef.current && inFlightRef.current === 0 && tasksDirtyRef.current) {
        // Both keys, via the same ref the unmount effect uses below: with the
        // app-wide 60s staleTime, invalidating only the board would leave the
        // tasks cache holding the pre-edit row, so reopening the card within
        // that window would rehydrate stale data over this save.
        invalidateRef.current();
      }
    },
  });

  const flush = useCallback(
    (taskId: number) => {
      const entry = pendingRef.current.get(taskId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingRef.current.delete(taskId);
      if (Object.keys(entry.patch).length === 0) {
        // Nothing to send, but a resync may have been skipped while this
        // entry was pending (see the guard above the resync effect) — give
        // it a chance to run now that this row is no longer blocking it.
        // A real mutate() would do this from its own onSettled; a no-op
        // flush has no mutate() call, so nothing else will.
        setTasksSyncGeneration((generation) => generation + 1);
        return;
      }
      // Accepted trade: same-task flushes are not serialised against each
      // other, so two PATCHes for the same task landing out of order would
      // write the older value last. A promise chain was tried here to close
      // that gap by having `flush` await the previous entry's `onSettled`
      // before starting the next — but all tasks share ONE
      // `updateTaskMutation` MutationObserver, and React Query stores the
      // per-call `onSettled` passed to `mutate()` in a single slot on that
      // observer. Flushing a different task while this one's PATCH was still
      // open overwrote that slot and detached the observer from THIS
      // mutation, so this task's resolver was silently orphaned — the chain
      // link never settled, and every subsequent edit to this task was
      // dropped for the rest of the panel's lifetime. That is strictly worse
      // than the ordering issue it was meant to fix, so it was reverted.
      // With the 500ms debounce and at most one in-flight PATCH per task,
      // two flushes racing each other for the same row is vanishingly rare;
      // if it happens, the older value landing last is an acceptable, purely
      // theoretical cost.
      //
      // Reverting this also fixed two things the chain broke as a side
      // effect: deferring `mutate` to a microtask meant `onMutate`'s
      // `inFlightRef += 1` no longer ran before the unmount cleanup checked
      // it, so "exactly one of onSettled / unmount fires the board refresh"
      // was false and every close cost an extra full-board GET; and a chain
      // entry survived task deletion, so a queued flush could PATCH a
      // deleted row and toast `aito.saveFailed`.
      updateTaskMutation.mutate({ id: taskId, patch: entry.patch });
    },
    // `updateTaskMutation.mutate` specifically, not the mutation object: React
    // Query's `useMutation` returns a fresh object literal every render, so
    // depending on the whole object would give `flush` (and, transitively,
    // `flushAll`) a new identity on every render too. `mutate` itself comes
    // from a `useCallback` bound to the mutation observer and is genuinely
    // stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateTaskMutation.mutate],
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
    // `addTaskMutation.mutate` specifically, not the mutation object — see
    // `flush`'s comment above for why the object's identity isn't stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, addTaskMutation.mutate, flush],
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
    // `deleteTaskMutation.mutate` specifically, not the mutation object — see
    // `flush`'s comment above for why the object's identity isn't stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, deleteTaskMutation.mutate],
  );

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

  return { tasks, onTasksChange, onRemoveTask, onRowBlur: flush };
}
