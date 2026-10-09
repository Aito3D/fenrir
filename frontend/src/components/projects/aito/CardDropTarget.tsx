import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { api } from '../../../api/client';
import type { LinkedProjectRef } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useFileDropZone } from '../files/useFileDropZone';
import { ProjectCodeChip } from '../ProjectCodeChip';
import { useAcceptsPrintable, useUploadToTask } from './dropFiles';

interface Choice {
  taskId: number;
  title: string;
  project: LinkedProjectRef;
  files: File[];
}

/** Native file drop on a board card, as a hook so the handlers land on the
 *  card's own shell element (no extra wrapper in the DOM). One linked task takes
 *  the files; several ask which; none toasts and opens the card. Reacts only to
 *  OS file drags — dnd-kit reorders with pointer events and never reaches here.
 *  Spread `handlers` and `className` on the shell and render `overlay` inside it. */
export function useCardDrop({
  orderId,
  onExpand,
  disabled = false,
}: {
  orderId: number;
  onExpand?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const upload = useUploadToTask();
  const acceptsPrintable = useAcceptsPrintable();
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const chooserRef = useRef<HTMLDivElement>(null);
  const chooserOpen = choices !== null;
  // Outside press dismisses the chooser and forgets the pending files.
  useEffect(() => {
    if (!chooserOpen) return;
    const close = (e: PointerEvent) => {
      if (!chooserRef.current?.contains(e.target as Node)) setChoices(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [chooserOpen]);
  // projects:read too: choosing a task needs the order's links (aito:read + projects:read).
  const canDrop =
    !disabled && hasPermission('aito:update') && hasPermission('projects:update') && hasPermission('projects:read');

  const send = async (taskId: number, project: LinkedProjectRef, files: File[]) => {
    setBusy(true);
    try {
      await upload(orderId, taskId, project, files);
    } finally {
      setBusy(false);
    }
  };

  const handleDrop = async (files: File[]) => {
    if (!acceptsPrintable(files)) return; // before asking which task
    setBusy(true);
    let links;
    try {
      links = (await api.getOrderProjectLinks(orderId)).tasks.filter((l) => l.project);
    } catch {
      setBusy(false);
      showToast(t('projectsPdm.files.uploadFailed'), 'error');
      return;
    }
    setBusy(false);
    if (links.length === 0) {
      showToast(t('projectsPdm.aito.dropNeedsProject'), 'info');
      onExpand?.();
      return;
    }
    if (links.length === 1) {
      await send(links[0].task_id, links[0].project as LinkedProjectRef, files);
      return;
    }
    setChoices(
      links.map((l) => ({
        taskId: l.task_id,
        title: l.task_title?.trim() || `#${l.task_id}`,
        project: l.project as LinkedProjectRef,
        files,
      })),
    );
  };

  // Claims every file drag over the card, or the browser opens the file.
  const { dragOver, onDragOver, onDragLeave, onDrop } = useFileDropZone({
    canDrop,
    fileDragsOnly: true,
    stopPropagation: 'drop',
    onFiles: handleDrop,
  });

  const overlay = (
    <>
      {busy && (
        <span
          role="status"
          data-testid="card-drop-busy"
          className="absolute right-2 top-2 z-40 rounded-full bg-bambu-dark/80 p-1"
        >
          <Loader2 className="h-4 w-4 animate-spin text-bambu-green" />
        </span>
      )}
      {choices && (
        <div
          ref={chooserRef}
          role="dialog"
          aria-label={t('projectsPdm.aito.dropChooseTask')}
          className="absolute inset-x-2 top-8 z-40 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-2 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setChoices(null);
            }
          }}
        >
          <p className="mb-1 text-xs text-bambu-gray-light">{t('projectsPdm.aito.dropChooseTask')}</p>
          <ul className="space-y-1">
            {choices.map((c) => (
              <li key={c.taskId}>
                <button
                  type="button"
                  autoFocus={c === choices[0]}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm text-white hover:bg-bambu-dark-tertiary/60"
                  onClick={() => {
                    setChoices(null);
                    void send(c.taskId, c.project, c.files);
                  }}
                >
                  <span className="truncate">{c.title}</span>
                  <ProjectCodeChip code={c.project.code} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );

  if (disabled) return { handlers: {}, className: '', title: undefined, overlay: null };
  return {
    handlers: { onDragOver, onDragLeave, onDrop },
    className: dragOver ? 'outline-dashed outline-2 outline-offset-2 outline-bambu-green' : '',
    title: dragOver ? t('projectsPdm.aito.dropHere') : undefined,
    overlay,
  };
}
