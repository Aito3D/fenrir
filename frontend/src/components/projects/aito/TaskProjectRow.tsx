import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FolderPlus, Link2, Pencil, Unlink } from 'lucide-react';
import { api } from '../../../api/client';
import type { TaskProjectLink } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { ConfirmModal } from '../../ConfirmModal';
import { focusRingCls } from '../../formStyles';
import { taskSteps } from '../../aito/services';
import type { TaskDraft } from '../../../utils/taskDraft';
import { ProjectCodeChip } from '../ProjectCodeChip';
import { NewProjectModal } from '../NewProjectModal';
import { DeliveriesPicker } from './DeliveriesPicker';
import { ProjectLinkPicker } from './ProjectLinkPicker';
import { useTaskFileDrop } from './dropFiles';
import { useInvalidateProjectLinks } from './useOrderProjectLinks';

const DESCRIPTION_FIELD = {
  scan: 'scanDescription',
  modelisation: 'modelisationDescription',
  impression: 'impressionDescription',
  usinage: 'usinageDescription',
  maindoeuvre: 'maindoeuvreDescription',
} as const;

const smallBtn = `inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-bambu-gray-light transition-colors hover:bg-bambu-dark-tertiary/40 hover:text-white disabled:opacity-50 ${focusRingCls}`;

/** The task's service descriptions, as the new project's starting description. */
function taskDescription(task: TaskDraft): string {
  return taskSteps(task)
    .map(({ service }) => task[DESCRIPTION_FIELD[service]].trim())
    .filter(Boolean)
    .join('. ');
}

/** The "Projet" line of a saved Aito task (spec §4.1/§4.3): link or create a
 *  PDM project; once linked, its code and name (to the project page), unlink,
 *  and the delivered files with their picker. Never goes through the task
 *  PATCH — a link change must not push the quote to Zoho. */
export function TaskProjectRow({
  orderId,
  task,
  taskId,
  link,
}: {
  orderId: number;
  task: TaskDraft;
  taskId: number;
  link: TaskProjectLink | undefined;
}) {
  const { t, i18n } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const invalidate = useInvalidateProjectLinks();
  const canLink = hasPermission('aito:update');
  const canCreate = canLink && hasPermission('projects:create');
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [editingDeliveries, setEditingDeliveries] = useState(false);
  const project = link?.project ?? null;
  const deliveries = link?.deliveries ?? [];

  const linkMutation = useMutation({
    mutationFn: (projectId: number | null) => api.linkTaskProject(taskId, projectId),
    onSuccess: (result) => {
      invalidate(orderId, [project?.id, result.project?.id]);
      setPicking(false);
      setConfirmUnlink(false);
    },
    onError: () => showToast(t('projectsPdm.aito.linkFailed'), 'error'),
  });

  // Names for the delivered revision ids — the tree is cached per project and
  // shared with the picker and the project page.
  const { data: tree } = useQuery({
    queryKey: ['project-tree', project?.id],
    queryFn: () => api.getProjectTree(project!.id),
    enabled: !!project && deliveries.length > 0,
    retry: false,
  });
  const deliveredText =
    deliveries.length === 0
      ? t('projectsPdm.aito.deliveredNone')
      : tree
        ? tree.sections
            .flatMap((s) =>
              s.items.flatMap((i) =>
                i.revisions.filter((r) => deliveries.includes(r.id)).map((r) => `${i.name} R${r.number}`),
              ),
            )
            .join(', ')
        : '…';

  if (!link) return null;

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium uppercase tracking-wide text-bambu-gray">{t('projectsPdm.aito.projectLabel')}</span>
        {project ? (
          <>
            <ProjectCodeChip code={project.code} />
            <Link
              to={`/projects/${project.id}`}
              className={`min-w-0 truncate text-sm text-white hover:underline ${focusRingCls}`}
            >
              {project.name}
            </Link>
            {canLink && (
              <button type="button" className={`ml-auto ${smallBtn}`} onClick={() => setConfirmUnlink(true)}>
                <Unlink aria-hidden="true" className="h-3 w-3" />
                {t('projectsPdm.aito.unlink')}
              </button>
            )}
          </>
        ) : !canLink ? (
          <span className="text-bambu-gray">—</span>
        ) : (
          <>
            {canCreate && (
              <button type="button" className={smallBtn} onClick={() => setCreating(true)}>
                <FolderPlus aria-hidden="true" className="h-3 w-3" />
                {t('projectsPdm.aito.newProject')}
              </button>
            )}
            <button
              type="button"
              className={smallBtn}
              aria-expanded={picking}
              onClick={() => setPicking((v) => !v)}
            >
              <Link2 aria-hidden="true" className="h-3 w-3" />
              {t('projectsPdm.aito.linkExisting')}
            </button>
          </>
        )}
      </div>

      {project && (
        <div className="flex items-center gap-2 text-bambu-gray">
          <span className="flex-shrink-0">
            {/* French sets a space before the colon. */}
            {`${t('projectsPdm.aito.deliveredFiles')}${i18n.language?.startsWith('fr') ? ' :' : ':'}`}
          </span>
          <span className="min-w-0 flex-1 truncate text-bambu-gray-light" title={deliveredText}>
            {deliveredText}
          </span>
          {canLink && (
            <button
              type="button"
              aria-label={t('projectsPdm.aito.editDeliveries')}
              title={t('projectsPdm.aito.editDeliveries')}
              className={smallBtn}
              onClick={() => setEditingDeliveries(true)}
            >
              <Pencil aria-hidden="true" className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {picking && !project && (
        <ProjectLinkPicker
          taskId={taskId}
          disabled={linkMutation.isPending}
          onPick={(projectId) => linkMutation.mutate(projectId)}
          onClose={() => setPicking(false)}
        />
      )}
      {/* Modals are portalled out of the task row (a file drop target). */}
      {creating &&
        createPortal(
          <NewProjectModal
            initialTitle={task.title.trim()}
            initialDescription={taskDescription(task)}
            onClose={() => setCreating(false)}
            onCreated={(created) => linkMutation.mutate(created.id)}
          />,
          document.body,
        )}
      {confirmUnlink &&
        project &&
        createPortal(
          <ConfirmModal
            title={t('projectsPdm.aito.unlink')}
            message={t('projectsPdm.aito.confirmUnlink', { name: project.code ?? project.name })}
            confirmText={t('projectsPdm.aito.unlink')}
            variant="warning"
            isolateEscape
            overlayZIndex="z-[60]"
            isLoading={linkMutation.isPending}
            onConfirm={() => linkMutation.mutate(null)}
            onCancel={() => setConfirmUnlink(false)}
          />,
          document.body,
        )}
      {editingDeliveries && project && (
        <DeliveriesPicker
          orderId={orderId}
          taskId={taskId}
          task={task}
          projectId={project.id}
          current={deliveries}
          onClose={() => setEditingDeliveries(false)}
        />
      )}
    </div>
  );
}

/** Wraps a task card as a native file drop target: dashed accent outline
 *  while files hover it, then `useTaskFileDrop` does the rest. */
export function TaskDropZone({
  orderId,
  taskId,
  link,
  children,
}: {
  orderId: number;
  taskId: number | null;
  link: TaskProjectLink | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canDrop = hasPermission('aito:update') && hasPermission('projects:update');
  const { dragOver, ...handlers } = useTaskFileDrop({ orderId, taskId, link, canDrop });
  return (
    <div
      data-testid={taskId !== null ? `task-drop-${taskId}` : undefined}
      title={dragOver ? t('projectsPdm.aito.dropHere') : undefined}
      className={`rounded-[.6rem] ${dragOver ? 'outline-dashed outline-2 outline-offset-2 outline-bambu-green' : ''}`}
      {...handlers}
    >
      {children}
    </div>
  );
}
