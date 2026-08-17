import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { TaskRow } from './TaskRow';
import { taskSteps } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { emptyTaskDraft, projectTotal, rowKey } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

export interface TaskEditorProps {
  value: TaskDraft[];
  onChange: (next: TaskDraft[]) => void;
  onRemove: (index: number) => void;
  /** Rows that cannot be removed. The create modal passes 1: a project must
   *  carry at least one task, and letting the user delete their way to zero
   *  and then be told "no" is worse than not offering it. Defaults to 0 so the
   *  detail panel is unaffected. */
  minRows?: number;
  /** Called when focus leaves a row, so a debounced save can flush early
   *  rather than waiting out its timer. Optional: the create modal holds its
   *  tasks locally and has nothing to flush. */
  onRowBlur?: (task: TaskDraft) => void;
  /** Passed straight to `TaskStepList` — see its own prop doc. Required, not
   *  defaulted: a default is exactly how a caller with no quote (the create
   *  modal) would silently inherit the wrong answer. */
  canTick: boolean;
  /** Whether to render this component's own "Tasks / Project total" heading.
   *  Defaults to true so `NewProjectModal` (which has no panel header of its
   *  own to carry the total) is unaffected. The detail panel passes `false`:
   *  it renders its own "Work" eyebrow plus an aggregate progress bar above
   *  this component instead, and the project total already lives in the
   *  panel header — repeating it here would be the same figure shown twice. */
  showHeader?: boolean;
  /** Uids of rows whose create POST is still in flight — `useProjectTasks`'
   *  `pendingTaskUids`. Such a row renders inert (see `TaskRow`'s `pending`
   *  prop): its inputs disabled, its delete control absent — otherwise
   *  anything typed into it is silently lost the moment the POST resolves
   *  and swaps the placeholder for the server's echo of the request that was
   *  in flight (see `useProjectTasks`' `addTaskMutation.onSuccess`).
   *
   *  Optional, and deliberately never defaulted to a bare `id === null`
   *  check: the create modal (`NewProjectModal`) reuses this component and
   *  EVERY one of its rows has `id === null` while none of them are actually
   *  pending a network call, so it must stay fully editable. It simply
   *  passes nothing. */
  pendingUids?: Set<string>;
  /** One task open at a time, the rest collapsed to their header line. Only
   *  the create drawer passes this: a draft list can grow long and none of
   *  it is tickable yet, so compactness wins there. The detail panel keeps
   *  its always-open rows — collapsing would put a click between the user
   *  and the step Done ticks (see TaskRow's component doc). Defaults to
   *  false so every existing caller is unaffected.
   *
   *  Note this is the COLLAPSE accordion, and it is opt-in. EDIT mode is
   *  accordion for everyone, prop or no prop (see `editingKey`): at most one
   *  row shows its form anywhere. The two are separate keys answering
   *  separate questions — a row can be expanded-and-read-only, and under this
   *  prop it can also be collapsed while holding the edit slot. */
  accordion?: boolean;
  /** Gates the "+ Add task" affordance. Optional, defaulting to true, so the
   *  create drawer (which has no permission concept of its own — creating a
   *  project already required aito:create to open) is unaffected; the detail
   *  panel is the only caller that passes it explicitly, mirroring
   *  POST /{project_id}/tasks' own Permission.AITO_CREATE. */
  canCreate?: boolean;
  /** Gates the per-row remove control, alongside the existing `minRows`/
   *  `pending` checks. Optional, defaulting to true for the same reason as
   *  `canCreate` — mirrors DELETE /tasks/{task_id}'s Permission.AITO_DELETE. */
  canDelete?: boolean;
}

/** The task list for one Aito project: a heading, each task's `TaskRow`, "+
 *  Add task", and the project total. Purely presentational — it holds no
 *  persistence logic and never mutates `value` in place, only maps it into a
 *  new array. That split is what lets the create modal hold this array in
 *  local state and POST it with the project, while the detail panel wires
 *  each change to a PATCH; neither caller is visible from here. */
export function TaskEditor({
  value,
  onChange,
  onRemove,
  canTick,
  minRows = 0,
  onRowBlur,
  showHeader = true,
  pendingUids,
  accordion = false,
  canCreate = true,
  canDelete = true,
}: TaskEditorProps) {
  const { t } = useTranslation();
  const currency = useCurrency();

  // The ONE row open for editing (showing the form instead of the read-only
  // step list), keyed by `rowKey` — same key `isEditing` below checks, or
  // toggling one row's form would open another's.
  //
  // A single key rather than a set of them: an open form is several times the
  // height of the step list it replaces, so two at once push every other task
  // out of the column's scroll view. Opening one row therefore closes
  // whichever was open — the accordion rule, applied to edit mode. null means
  // no row is explicitly open, which is a meaningful state: see `isEditing`.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const toggleEdit = (key: string) => setEditingKey((current) => (current === key ? null : key));

  // A key matching no current row is stale, not a choice: the edited row was
  // removed, or the drawer's hold-to-reset swapped in fresh drafts whose uids
  // can never equal the stored key. Resolving it to null here — rather than
  // pruning the state on every path that can drop a row — covers both, and
  // matters because `isEditing` treats null as "nothing explicitly open" and
  // falls back to auto-opening a stepless row. Left un-resolved, a wiped
  // drawer would show one bare "No steps yet" line with its form behind a
  // click nothing invites. Same shape as `effectiveOpenKey` below, derived
  // independently: the two answer different questions about the same row.
  const effectiveEditingKey =
    editingKey !== null && value.some((task) => rowKey(task) === editingKey) ? editingKey : null;

  // Accordion mode's single open row, by the same key as everything else.
  // Seeded to the first row so the drawer's initial task starts open. null
  // is a legal state meaning "the user closed the open row on purpose" —
  // distinct from a DANGLING key, resolved just below.
  const [openKey, setOpenKey] = useState<string | null>(() =>
    accordion && value.length > 0 ? rowKey(value[0]) : null,
  );
  // A non-null key matching no row is not a choice anyone made: the open row
  // was removed, or the drawer's hold-to-reset swapped in fresh drafts whose
  // uids can never equal the stored key. Falling back to the first row keeps
  // a form reachable — without this, a wiped drawer shows one bare header
  // line and every field is behind a click nothing invites. Derived rather
  // than synced in an effect: there is no second render where the list and
  // the key disagree.
  const effectiveOpenKey =
    accordion && openKey !== null && value.length > 0 && !value.some((task) => rowKey(task) === openKey)
      ? rowKey(value[0])
      : openKey;

  // A row with no steps IS the form — read mode would show nothing but "No
  // steps yet", so there is nothing to disclose. Deriving this replaces the
  // effect that used to diff row keys to open a newly added row in edit mode,
  // and fixes the create modal for free: its first task previously started
  // both collapsed and not editing, costing two clicks before the user could
  // type a price.
  //
  // That fallback is gated on nothing else being explicitly open, or the one-
  // form rule would leak: two unpriced rows are two auto-opened forms, which
  // is the wall of forms this whole mechanism exists to prevent. The newest
  // wins, because "+ Add task" below names it as the explicit key. A stepless
  // row that loses this way still has its pencil (see TaskRow's own gate), so
  // it stays reachable rather than becoming a dead header line.
  const isEditing = (task: TaskDraft) =>
    effectiveEditingKey === rowKey(task) || (effectiveEditingKey === null && taskSteps(task).length === 0);

  // A stepless row is auto-edited by `isEditing` above, not by holding
  // `editingKey` itself — so the instant its FIRST keystroke prices a
  // service, `taskSteps` stops being empty and the OR's other half stops
  // being true. Without latching the key in here, that one keystroke would
  // flip the row to read mode mid-edit and drop focus out of the input the
  // user is still typing into. This is the only place that can catch the
  // 0-steps-to-1-step transition without reintroducing the diff-the-previous-
  // render effect Task 17 removed: it runs inside the same `onChange` the
  // edit itself flows through, so it sees the row's step count both before
  // and after in one place, no extra render needed.
  const graduateToEditing = (before: TaskDraft, after: TaskDraft) => {
    if (taskSteps(before).length === 0 && taskSteps(after).length > 0) {
      setEditingKey(rowKey(after));
    }
  };

  return (
    <div className="space-y-3">
      {showHeader && (
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-white">{t('aito.tasks')}</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-sm text-bambu-gray">{t('aito.projectTotal')}</span>
            <Money currency={currency} value={projectTotal(value)} className="text-bambu-green font-medium" />
          </div>
        </div>
      )}

      <div className="space-y-3">
        {value.map((task, index) => {
          const pending = pendingUids?.has(task.uid) ?? false;
          const key = rowKey(task);
          // EVERY row folds, the unpriced ones included — a collapsed
          // stepless row shows its bare header and expands back into its
          // form (`isEditing` keeps auto-editing it). Exempting stepless
          // rows was tried first and meant a drawer full of unpriced drafts
          // stayed a wall of forms — the exact problem accordion mode
          // exists to solve.
          const collapsed = accordion && key !== effectiveOpenKey;
          return (
            <TaskRow
              key={key}
              task={task}
              index={index}
              onChange={(next) => {
                graduateToEditing(task, next);
                onChange(value.map((existing, i) => (i === index ? next : existing)));
              }}
              // Absent (not merely disabled) while pending too, same rule as
              // `minRows` below it: the row's create hasn't landed, so there
              // is no id yet to send a DELETE for — see TaskRow's own prop doc.
              // `canDelete` is the same absent-not-disabled treatment: a user
              // without it would only get a 403 from DELETE /tasks/{task_id}.
              onRemove={value.length > minRows && !pending && canDelete ? () => onRemove(index) : undefined}
              editing={isEditing(task)}
              onToggleEdit={() => {
                if (collapsed) {
                  // Pencil on a collapsed row: open it AND force edit ON —
                  // a plain toggle could flip an already-editing key OFF
                  // while the form it would close isn't even on screen.
                  setOpenKey(key);
                  setEditingKey(key);
                } else {
                  toggleEdit(key);
                }
              }}
              onRowBlur={onRowBlur}
              canTick={canTick}
              pending={pending}
              collapsed={collapsed}
              // Compared against the EFFECTIVE key, not the stored one: when
              // a dangling key has fallen back to opening this row, clicking
              // its header must close it, not "open" it a second time.
              onToggleCollapse={accordion ? () => setOpenKey(effectiveOpenKey === key ? null : key) : undefined}
            />
          );
        })}
      </div>

      {canCreate && (
      <button
        type="button"
        onClick={() => {
          const draft = emptyTaskDraft();
          onChange([...value, draft]);
          // The new task is the one being worked on: open it (collapsing the
          // rest). Its key is computable before the parent commits the new
          // array because a draft's identity is its own uid, not its index.
          //
          // Naming it the editing key is what closes whatever form was open.
          // Without this the new row would auto-open as a SECOND form (it is
          // stepless), which is the one thing the single key forbids —
          // `isEditing`'s stepless fallback only fires when nothing is
          // explicitly open, so the add has to claim the slot outright.
          setEditingKey(rowKey(draft));
          if (accordion) setOpenKey(rowKey(draft));
        }}
        // A full-width row that echoes the task cards above it rather than a
        // small green text link off to one side: it is the slot the next card
        // will occupy, so it reads as an empty one. Muted at rest and
        // accent-lit on hover, so it invites without competing with the cards
        // that carry real work.
        className={`w-full inline-flex items-center justify-center gap-1.5 rounded-[.6rem] border border-bambu-dark-tertiary py-2 text-sm text-bambu-gray hover:text-bambu-green hover:border-bambu-green/40 hover:bg-bambu-green/[0.04] transition-colors motion-reduce:transition-none ${focusRingCls}`}
      >
        <Plus className="w-4 h-4" />
        {t('aito.addTask')}
      </button>
      )}
    </div>
  );
}
