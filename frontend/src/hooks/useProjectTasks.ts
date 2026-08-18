import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type AitoProject,
  type AitoTask,
  type AitoTaskCreate,
  type AitoTaskUpdate,
} from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { useBoardSync } from './useBoardSync';
import { summariseTasks } from '../utils/aitoBoardRules';
import { applyTaskSummary } from '../utils/aitoOptimistic';
import { taskDraftFromAitoTask, taskDraftToTaskCreate } from '../utils/taskDraft';
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
  // `resyncIfIdle`, not a bare `invalidateQueries`: this hook's board
  // invalidations are the only ones in the codebase that used to bypass
  // `useBoardSync` entirely, which is what let a task-panel refresh race a
  // board write it knew nothing about — see the finding this fixes. The
  // function itself is stable (see useBoardSync's own doc on why the
  // returned OBJECT, not its methods, is the fresh-per-render part), so it is
  // safe to depend on directly below.
  const { resyncIfIdle } = useBoardSync();

  const tasksQuery = useQuery({
    queryKey: ['aito-tasks', projectId],
    queryFn: () => api.getAitoTasks(projectId),
  });
  const [tasks, setTasks] = useState<TaskDraft[]>([]);

  // The current draft array, readable from mutation callbacks that outlive the
  // render they were created in.
  const tasksRef = useRef<TaskDraft[]>([]);
  tasksRef.current = tasks;

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
    // Gated, unlike the two invalidations either side of it: a board write
    // (delete project, drag, quote status, create) may be mid-flight with
    // its own optimistic cache entry, and an ungated GET here would land
    // between that write's `cancelQueries` and its own settle, overwriting
    // the optimistic value with data that predates it. `resyncIfIdle` is a
    // no-op in that case — the board write's own `settle()` invalidates once
    // IT finishes, which is after this hook's optimistic `projectOntoBoard`
    // write has already applied, so nothing is lost, only reordered.
    resyncIfIdle(queryClient);
    queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
  }, [queryClient, projectId, resyncIfIdle]);

  /** Project the current draft array onto the board card: total, badges,
   *  progress bar and — through the mirrored rules — the column.
   *
   *  A setQueryData, never an invalidateQueries. The board is refetched once,
   *  on close, and only if something was really saved (see `closedRef` and
   *  `inFlightRef` below); a refetch here would be a full-board GET per
   *  keystroke, which is the exact cost that arbitration exists to avoid. A
   *  cache write costs nothing and is corrected by that same close-time
   *  refetch. */
  const projectOntoBoard = useCallback(
    (rows: TaskDraft[]) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        applyTaskSummary(prev, projectId, summariseTasks(rows)),
      );
    },
    [queryClient, projectId],
  );

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
      if (tickedAStep) resyncIfIdle(queryClient);
      // Every edit writes an event, not only ticks — this sits outside the
      // guard above deliberately. The two-element prefix (not the query's own
      // three-element key) matches every depth's cache entry, so switching
      // depth after an edit never shows a stale list.
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
    },
    onError: (error, { id }) => {
      showToast(t('aito.saveFailed'), 'error');
      // A 422 means the PATCH was REFUSED, so nothing in it was saved. The
      // case that matters is the backend's quote-acceptance guard declining to
      // tick a step, but it is not the only 422 this PATCH can draw: the same
      // route also rejects ticking a service that has no cost, and FastAPI's
      // own body validation answers 422 too. The rollback below is right for
      // all of them, precisely because it keys on "refused", not on which
      // guard refused. `tasks` is optimistic — the checkbox was flipped
      // locally the moment it was clicked — so without this the row goes on
      // rendering as DONE while the server holds it undone, and stays that way
      // until some unrelated refetch happens to correct it. A toast alone is
      // not enough: the user sees work marked finished that no one recorded.
      //
      // Rolled back from `baselineRef`, the last-known-persisted row, rather
      // than by invalidating: the baseline IS the server's answer here (the
      // PATCH changed nothing), so this needs no GET and cannot race one. The
      // whole row is restored, not just the flag, because the whole PATCH was
      // refused — every field in it is equally unsaved.
      if (!(error instanceof ApiError) || error.status !== 422) return;
      const baseline = baselineRef.current.get(id);
      if (!baseline) {
        // No baseline to roll back to (a row added and edited inside the same
        // panel session before its first load). Ask the server instead.
        queryClient.invalidateQueries({ queryKey: ['aito-tasks', projectId] });
        return;
      }
      // Read from `tasksRef`, not a `setTasks` functional update: the
      // restored array is also needed for `projectOntoBoard` below, and this
      // callback belongs to whichever mutation instance was in flight when
      // the PATCH was fired — by the time it settles, `tasks` may have moved
      // on (another row added, edited or deleted), so only the ref is current.
      const restored = tasksRef.current.map((row) => (row.id === id ? taskDraftFromAitoTask(baseline) : row));
      setTasks(restored);
      projectOntoBoard(restored);
    },
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

  // Uids of rows whose create POST is still in flight. A row in this set
  // must render inert (see TaskRow's `pending` prop / TaskStepFields'
  // `disabled`): the row appears the instant "+ Add task" is clicked and
  // TaskEditor auto-opens it for editing (it has no steps yet, so the
  // read-only view would show nothing), but `onSuccess` below overwrites
  // whatever is in this row with `taskDraftFromAitoTask(created)` — the
  // server's echo of the ORIGINAL, still-empty draft `mutate` captured. Any
  // edit made in that window has nowhere to go (there is no id to PATCH yet,
  // see `onTasksChange`'s `edited.id === null` branch) and would otherwise be
  // silently lost the moment the POST resolves. Disabling the row until then
  // is the fix; replaying the edits afterwards was considered and rejected —
  // an edit made against an id that never arrives (the POST fails) has
  // nowhere to go either.
  const [pendingTaskUids, setPendingTaskUids] = useState<Set<string>>(new Set());

  const addTaskMutation = useMutation({
    mutationFn: ({ draft }: { draft: TaskDraft }) =>
      api.createAitoTask(projectId, taskDraftToTaskCreate(draft)),
    onMutate: ({ draft }) => {
      setPendingTaskUids((prev) => new Set(prev).add(draft.uid));
    },
    onSuccess: (created, { draft }) => {
      // Swap the placeholder for the real row, matched on `uid` — the draft's
      // stable client-side identity. Matching on array position instead would
      // put the id on the wrong row if another add or delete landed meanwhile.
      baselineRef.current.set(created.id, created);
      setTasks((prev) => prev.map((row) => (row.uid === draft.uid ? taskDraftFromAitoTask(created) : row)));
      setPendingTaskUids((prev) => {
        const next = new Set(prev);
        next.delete(draft.uid);
        return next;
      });
      tasksDirtyRef.current = true;
      invalidateTasksAndBoard();
    },
    onError: (_error, { draft }) => {
      // The placeholder never became a row. Remove it rather than leaving an
      // un-PATCHable ghost the user can type into.
      setTasks((prev) => prev.filter((row) => row.uid !== draft.uid));
      setPendingTaskUids((prev) => {
        const next = new Set(prev);
        next.delete(draft.uid);
        return next;
      });
      showToast(t('aito.saveFailed'), 'error');
    },
  });

  const deleteTaskMutation = useMutation({
    mutationFn: ({ id }: { id: number; removed: TaskDraft; followingUid: string | null }) =>
      api.deleteAitoTask(id),
    onSuccess: (_data, { id }) => {
      // The row is gone for good; drop its diff baseline so a late flush
      // cannot PATCH a deleted task.
      baselineRef.current.delete(id);
      tasksDirtyRef.current = true;
      invalidateTasksAndBoard();
    },
    onError: (_error, { removed, followingUid }) => {
      // Put the row back where it was, not at the end: a task list has an
      // order the user chose, and a failed delete must not silently reorder
      // it. "Where it was" is anchored to the STABLE uid of whatever row
      // followed it at delete time, not the numeric index captured then: two
      // deletes overlapping (row B, then row A, while B's request is still
      // open) each shrink the array between one click and the other's
      // restore, so a numeric index restores at a position the array has
      // since moved past — see the design doc finding this fixes. `findIndex`
      // returning -1 (the neighbour was itself deleted or restored meanwhile,
      // or there was no neighbour — this was the last row) falls back to the
      // end of the array, same as `-1` would with `splice` if it were used
      // directly, made explicit here rather than relied upon.
      setTasks((prev) => {
        const restored = [...prev];
        const insertBefore = followingUid === null ? -1 : restored.findIndex((row) => row.uid === followingUid);
        const insertAt = insertBefore === -1 ? restored.length : insertBefore;
        restored.splice(insertAt, 0, removed);
        projectOntoBoard(restored);
        return restored;
      });
      showToast(t('aito.saveFailed'), 'error');
    },
  });

  // Order dropped while a reorder PATCH was still open. Each request carries
  // the COMPLETE order, so only the newest queued value matters — an older
  // queued order is superseded, never replayed. One slot, not a queue.
  const queuedReorderRef = useRef<number[] | null>(null);
  const reorderInFlightRef = useRef(false);
  // Reachable from reorderMutation's onSettled, which belongs to whichever
  // render fired the mutation — same ref idiom as flushAllRef below.
  const sendReorderRef = useRef<(ids: number[]) => void>(() => {});

  const reorderMutation = useMutation({
    mutationFn: (ids: number[]) => api.reorderAitoTasks(projectId, ids),
    onMutate: () => {
      // Blocks the resync effect (see the guard above it) so a refetch that
      // lands mid-flight cannot stomp the optimistic order.
      inFlightRef.current += 1;
    },
    onSuccess: () => {
      tasksDirtyRef.current = true;
      // Same stamp as a field save: stops the resync effect from applying a
      // cached snapshot fetched BEFORE this reorder landed (which would
      // silently revert the order one debounce window later).
      lastSaveAtRef.current = Date.now();
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
    },
    onError: () => {
      // 409 (stale id set after a concurrent add/delete) or a network error:
      // either way the server's order is the truth now — refetch it rather
      // than guessing. The resync effect applies it once nothing is in flight.
      showToast(t('aito.saveFailed'), 'error');
      queryClient.invalidateQueries({ queryKey: ['aito-tasks', projectId] });
    },
    onSettled: () => {
      inFlightRef.current -= 1;
      reorderInFlightRef.current = false;
      setTasksSyncGeneration((generation) => generation + 1);
      const queued = queuedReorderRef.current;
      queuedReorderRef.current = null;
      if (queued) sendReorderRef.current(queued);
      if (closedRef.current && inFlightRef.current === 0 && tasksDirtyRef.current) {
        invalidateRef.current();
      }
    },
  });

  const sendReorder = useCallback(
    (ids: number[]) => {
      if (reorderInFlightRef.current) {
        queuedReorderRef.current = ids;
        return;
      }
      reorderInFlightRef.current = true;
      reorderMutation.mutate(ids);
    },
    // `mutate` specifically, not the mutation object — see `flush`'s comment
    // above for why the object's identity isn't stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reorderMutation.mutate],
  );
  sendReorderRef.current = sendReorder;

  /** One completed drag: adopt the new order on screen immediately, persist
   *  it as the full id list. TaskEditor hides the handles while any create
   *  POST is pending, so a null id here is defense, not a code path — the
   *  visual order is still adopted so the UI never snaps back, and the next
   *  successful reorder (or refetch) reconciles. */
  const reorderTasks = useCallback(
    (next: TaskDraft[]) => {
      setTasks(next);
      const ids: number[] = [];
      for (const row of next) {
        if (row.id === null) return;
        ids.push(row.id);
      }
      sendReorder(ids);
    },
    [sendReorder],
  );

  // TaskEditor is fully controlled and reports the whole array on every edit.
  // Growing the array is always "+ Add task", so that case routes to the
  // create endpoint. Otherwise exactly one entry has a new object identity,
  // which pinpoints the task to diff without comparing every field of every row.
  const onTasksChange = useCallback(
    (next: TaskDraft[]) => {
      if (next.length > tasks.length) {
        // TaskEditor has already appended the draft to `next`; adopt its
        // array so the row is on screen this render, and POST the same draft.
        const added = next[next.length - 1];
        setTasks(next);
        addTaskMutation.mutate({ draft: added });
        return;
      }
      const changedIndex = next.findIndex((task, i) => task !== tasks[i]);
      if (changedIndex === -1) return;
      setTasks(next);
      projectOntoBoard(next);

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
    [tasks, addTaskMutation.mutate, flush, projectOntoBoard],
  );

  const onRemoveTask = useCallback(
    (index: number) => {
      const task = tasks[index];
      if (!task) return;
      if (task.id === null) {
        const next = tasks.filter((_, i) => i !== index);
        setTasks(next);
        projectOntoBoard(next);
        return;
      }
      // Drop any queued patch for a row about to be deleted.
      const pending = pendingRef.current.get(task.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRef.current.delete(task.id);
      }
      // Captured now, as a stable identity, not read back off `tasks` (or
      // recomputed from an index) inside `onError`: by the time this DELETE
      // settles, `tasks` may have moved on — see `deleteTaskMutation`'s own
      // comment for why a numeric index doesn't survive that.
      const followingUid = tasks[index + 1]?.uid ?? null;
      const next = tasks.filter((_, i) => i !== index);
      setTasks(next);
      projectOntoBoard(next);
      deleteTaskMutation.mutate({ id: task.id, removed: task, followingUid });
    },
    // `deleteTaskMutation.mutate` specifically, not the mutation object — see
    // `flush`'s comment above for why the object's identity isn't stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, deleteTaskMutation.mutate, projectOntoBoard],
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

  return { tasks, onTasksChange, onRemoveTask, onRowBlur: flush, pendingTaskUids, reorderTasks };
}
