import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, X } from 'lucide-react';
import { COLUMNS } from './columns';
import { TaskEditor } from './TaskEditor';
import { AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';
import {
  api,
  type AitoProject,
  type AitoProjectUpdate,
  type AitoTask,
  type AitoTaskCreate,
  type AitoTaskUpdate,
} from '../../api/client';
import { parseUTCDate } from '../../utils/date';
import { inputCls } from '../formStyles';
import { useToast } from '../../contexts/ToastContext';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

/** Wire shape -> client shape, the read half of the conversion. `?? 1` on
 *  quantity is defensive only: a saved row always carries a real number (see
 *  `taskDraftToTaskCreate`), never `null`. */
function taskDraftFromAitoTask(task: AitoTask): TaskDraft {
  return {
    id: task.id,
    title: task.title ?? '',
    description: task.description ?? '',
    scanCost: task.scan_cost,
    modelisationCost: task.modelisation_cost,
    usinageCost: task.usinage_cost,
    impression: {
      printerId: task.impression_printer_id,
      filamentId: task.impression_filament_id,
      weightG: task.impression_weight_g,
      timeMin: task.impression_time_min,
      quantity: task.impression_quantity ?? 1,
      color: task.impression_color ?? '',
    },
    impressionCost: task.impression_cost,
  };
}

/** Client shape -> wire shape, matching the conventions the create modal
 *  established (AitoPage.tsx's create mutation): `title`, `description` and
 *  `impression_color` collapse blank to `null` rather than `''`; every
 *  numeric field passes straight through so a `0` cost stays `0` (free)
 *  rather than becoming `null` (disabled). */
function taskDraftToTaskCreate(t: TaskDraft): AitoTaskCreate {
  return {
    title: t.title.trim() || null,
    description: t.description.trim() || null,
    scan_cost: t.scanCost,
    modelisation_cost: t.modelisationCost,
    usinage_cost: t.usinageCost,
    impression_printer_id: t.impression.printerId,
    impression_filament_id: t.impression.filamentId,
    impression_weight_g: t.impression.weightG,
    impression_time_min: t.impression.timeMin,
    impression_quantity: t.impression.quantity,
    impression_color: t.impression.color.trim() || null,
    impression_cost: t.impressionCost,
  };
}

/** The narrow patch: only the wire fields that actually differ between the
 *  persisted row and the edited draft. Comparing the two *wire* shapes
 *  (rather than the drafts directly) means the blank -> null and 0-stays-0
 *  rules above apply identically on both sides of the diff. */
function diffTaskDraft(baseline: TaskDraft, next: TaskDraft): AitoTaskUpdate {
  const before = taskDraftToTaskCreate(baseline);
  const after = taskDraftToTaskCreate(next);
  const patch: AitoTaskUpdate = {};
  if (after.title !== before.title) patch.title = after.title;
  if (after.description !== before.description) patch.description = after.description;
  if (after.scan_cost !== before.scan_cost) patch.scan_cost = after.scan_cost;
  if (after.modelisation_cost !== before.modelisation_cost) patch.modelisation_cost = after.modelisation_cost;
  if (after.usinage_cost !== before.usinage_cost) patch.usinage_cost = after.usinage_cost;
  if (after.impression_printer_id !== before.impression_printer_id) {
    patch.impression_printer_id = after.impression_printer_id;
  }
  if (after.impression_filament_id !== before.impression_filament_id) {
    patch.impression_filament_id = after.impression_filament_id;
  }
  if (after.impression_weight_g !== before.impression_weight_g) {
    patch.impression_weight_g = after.impression_weight_g;
  }
  if (after.impression_time_min !== before.impression_time_min) {
    patch.impression_time_min = after.impression_time_min;
  }
  if (after.impression_quantity !== before.impression_quantity) {
    patch.impression_quantity = after.impression_quantity;
  }
  if (after.impression_color !== before.impression_color) patch.impression_color = after.impression_color;
  if (after.impression_cost !== before.impression_cost) patch.impression_cost = after.impression_cost;
  return patch;
}

interface ProjectDetailPanelProps {
  project: AitoProject;
  onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  if (state === 'saving') return <Loader2 className="w-3.5 h-3.5 text-bambu-gray animate-spin" />;
  if (state === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-bambu-green animate-fade-in">
        <Check className="w-3.5 h-3.5" />
        {t('aito.saved')}
      </span>
    );
  }
  return null;
}

/** Everything a card cannot fit: the untruncated description, the timestamps
 *  and the stage. Shares AITO_CARD_VT_NAME with the card it grew out of, so the
 *  browser morphs one into the other (see useCardMorph). */
export function ProjectDetailPanel({ project, onClose }: ProjectDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const column = COLUMNS.find((c) => c.id === project.column);
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);

  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const updateMutation = useMutation({
    mutationFn: (patch: AitoProjectUpdate) => api.updateAitoProject(project.id, patch),
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  // Tasks. `tasks` is the editable view TaskEditor is controlled with; it is
  // resynced from the server whenever the query's data identity changes
  // (initial load, and after add/remove invalidate it) but NOT after a
  // single-field PATCH, which would otherwise overwrite whatever the user is
  // mid-typing into a different field.
  const tasksQuery = useQuery({
    queryKey: ['aito-tasks', project.id],
    queryFn: () => api.getAitoTasks(project.id),
  });
  const [tasks, setTasks] = useState<TaskDraft[]>([]);

  useEffect(() => {
    if (tasksQuery.data) setTasks(tasksQuery.data.map(taskDraftFromAitoTask));
  }, [tasksQuery.data]);

  const updateTaskMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: AitoTaskUpdate }) => api.updateAitoTask(id, patch),
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const addTaskMutation = useMutation({
    mutationFn: () => api.createAitoTask(project.id, taskDraftToTaskCreate(emptyTaskDraft())),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aito-tasks', project.id] }),
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => api.deleteAitoTask(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['aito-tasks', project.id] }),
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  // TaskEditor is fully controlled and reports the whole array back on every
  // edit (see its own docstring). Growing the array is always "+ Add task" —
  // nothing else appends through this callback — so that case is routed to
  // the create endpoint rather than diffed. Otherwise, exactly one entry has
  // a new object identity (TaskRow -> TaskEditor only replaces the row that
  // changed), which pinpoints which task to diff and PATCH without needing
  // to compare every field of every row.
  const handleTasksChange = (next: TaskDraft[]) => {
    if (next.length > tasks.length) {
      addTaskMutation.mutate();
      return;
    }

    const changedIndex = next.findIndex((task, i) => task !== tasks[i]);
    if (changedIndex === -1) return;

    setTasks(next);

    const edited = next[changedIndex];
    if (edited.id === null) return; // not yet persisted server-side; nothing to PATCH
    const baselineRow = tasksQuery.data?.find((row) => row.id === edited.id);
    if (!baselineRow) return;
    const patch = diffTaskDraft(taskDraftFromAitoTask(baselineRow), edited);
    if (Object.keys(patch).length === 0) return;
    updateTaskMutation.mutate({ id: edited.id, patch });
  };

  const handleRemoveTask = (index: number) => {
    const task = tasks[index];
    if (!task) return;
    if (task.id === null) {
      setTasks(tasks.filter((_, i) => i !== index));
      return;
    }
    deleteTaskMutation.mutate(task.id);
  };

  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState(project.description);
  const [descState, setDescState] = useState<SaveState>('idle');

  // Follow the server value while idle; never clobber text being typed.
  useEffect(() => {
    if (!editingDesc) setDraft(project.description);
  }, [project.description, editingDesc]);

  // 'saved' is a transient acknowledgement, not a state to sit in.
  useEffect(() => {
    if (descState !== 'saved') return;
    const id = setTimeout(() => setDescState('idle'), 1500);
    return () => clearTimeout(id);
  }, [descState]);

  const saveDescription = () => {
    setEditingDesc(false);
    const next = draft.trim();
    // Blank is rejected by the backend (min_length=1) and is almost always an
    // accidental select-all-delete, so revert rather than round-trip an error.
    if (!next || next === project.description) {
      setDraft(project.description);
      return;
    }
    setDescState('saving');
    updateMutation.mutate(
      { description: next },
      {
        onSuccess: () => setDescState('saved'),
        onError: () => {
          setDescState('error');
          setDraft(project.description);
        },
      },
    );
  };

  const editingRef = useRef(false);
  editingRef.current = editingDesc;

  // onClose is a fresh inline closure on every AitoPage render, so it cannot be
  // an effect dependency: the effect would re-run on every re-render and steal
  // focus back from whatever the user is editing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 [view-transition-name:aito-backdrop]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={project.client_name ?? t('aito.noClient')}
        style={{ viewTransitionName: AITO_CARD_VT_NAME }}
        className="bg-bambu-dark-secondary rounded-xl w-full max-w-md border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-start justify-between gap-3 flex-shrink-0">
          <h2 className="text-lg font-semibold text-white truncate min-w-0">
            {t('aito.projectRef', { id: project.id })}
          </h2>
          <button
            type="button"
            ref={closeRef}
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <div className="flex items-start justify-between gap-2">
            {editingDesc ? (
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={saveDescription}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // Stop the panel's window-level Escape handler: the first
                    // Escape abandons the edit, it does not close the panel.
                    e.stopPropagation();
                    setDraft(project.description);
                    setEditingDesc(false);
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription();
                }}
                rows={5}
                className={`${inputCls} resize-none flex-1`}
              />
            ) : (
              <p
                role="button"
                tabIndex={0}
                aria-label={t('aito.editDescription')}
                onClick={() => setEditingDesc(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setEditingDesc(true);
                  }
                }}
                className="flex-1 text-sm text-white whitespace-pre-wrap break-words cursor-text rounded-md -m-1 p-1 hover:bg-bambu-dark-tertiary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
              >
                {project.description}
              </p>
            )}
            <SaveIndicator state={descState} />
          </div>

          {/* One description list for the whole record. <dt>/<dd> gives
              assistive technology the label-to-value association for free; the
              colon is markup, so no locale string carries punctuation. Client
              rows with no value are omitted entirely — an empty "Email:" is
              noise, not information. The mid-list border separates the client
              group from the project metadata. */}
          <dl className="border-t border-bambu-dark-tertiary pt-4 space-y-2 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-bambu-gray flex-shrink-0">
                {project.client_is_company ? t('aito.companyNameLabel') : t('aito.clientNameLabel')}:
              </dt>
              <dd className={`min-w-0 truncate ${project.client_name ? 'text-white' : 'text-bambu-gray'}`}>
                {project.client_name ?? t('aito.noClient')}
              </dd>
            </div>
            {project.client_phone && (
              <div className="flex items-baseline gap-2">
                <dt className="text-bambu-gray flex-shrink-0">{t('aito.phoneLabel')}:</dt>
                <dd className="min-w-0 truncate">
                  <a href={`tel:${project.client_phone}`} className="text-white hover:text-bambu-green">
                    {project.client_phone}
                  </a>
                </dd>
              </div>
            )}
            {project.client_email && (
              <div className="flex items-baseline gap-2">
                <dt className="text-bambu-gray flex-shrink-0">{t('aito.emailLabel')}:</dt>
                <dd className="min-w-0 truncate">
                  <a href={`mailto:${project.client_email}`} className="text-white hover:text-bambu-green">
                    {project.client_email}
                  </a>
                </dd>
              </div>
            )}

            <div className="flex items-baseline gap-2 border-t border-bambu-dark-tertiary pt-2 mt-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.createdLabel')}:</dt>
              <dd className="text-white min-w-0">{created ? created.toLocaleString(i18n.language) : '—'}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.lastActivity')}:</dt>
              <dd className="text-white min-w-0">{updated ? updated.toLocaleString(i18n.language) : '—'}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.stage')}:</dt>
              <dd className="text-white flex items-center gap-2">
                {column && <span className={`w-2 h-2 rounded-full ${column.dot}`} />}
                {column ? t(column.labelKey) : project.column}
              </dd>
            </div>
          </dl>

          <div className="border-t border-bambu-dark-tertiary pt-4">
            <TaskEditor value={tasks} onChange={handleTasksChange} onRemove={handleRemoveTask} />
          </div>
        </div>
      </div>
    </div>
  );
}
