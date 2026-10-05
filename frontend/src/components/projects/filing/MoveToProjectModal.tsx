import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { api } from '../../../api/client';
import type { MoveToProjectResult } from '../../../api/client';
import { Button } from '../../Button';
import { ProjectCodeChip } from '../ProjectCodeChip';
import { focusRingCls } from '../../formStyles';
import { useToast } from '../../../contexts/ToastContext';
import { useIsolatedEscape } from '../../../hooks/useIsolatedEscape';

interface PickedProject {
  id: number;
  code: string | null;
  name: string;
}

/** 'auto' = the item comes from each file name; 'new' = the typed name. */
type ItemChoice = 'auto' | 'new' | number;

interface Props {
  /** The File Manager files to move (the first one drives the suggestions). */
  fileIds: number[];
  onClose: () => void;
  /** After a successful move, before the dialog closes (clears the selection). */
  onMoved?: (result: MoveToProjectResult) => void;
}

/** One summary line for a move: files moved (copies included), the copy note,
 *  then the skipped count. */
function moveResultMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  result: MoveToProjectResult,
  code: string,
): string {
  const filed = result.moved.length + result.copied.length;
  const parts: string[] = [];
  if (filed > 0) parts.push(t('projectsPdm.filing.moved', { count: filed, code }));
  if (result.copied.length > 0) parts.push(t('projectsPdm.filing.copiedNote'));
  if (result.skipped.length > 0) parts.push(t('projectsPdm.filing.skipped', { count: result.skipped.length }));
  return parts.join(' · ');
}

/** File Manager → project: suggestions for the first file, a project search,
 *  then which Impression item the files go into. */
export function MoveToProjectModal({ fileIds, onClose, onMoved }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  useIsolatedEscape(onClose, dialogRef);

  const [project, setProject] = useState<PickedProject | null>(null);
  const [itemChoice, setItemChoice] = useState<ItemChoice>('auto');
  const [newItemName, setNewItemName] = useState('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const firstFileId = fileIds[0];
  const { data: suggestions = [] } = useQuery({
    queryKey: ['file-project-suggestions', firstFileId],
    queryFn: () => api.getFileProjectSuggestions(firstFileId),
    enabled: firstFileId !== undefined,
    retry: false,
  });
  const { data: search, isFetching: searching } = useQuery({
    queryKey: ['projects-search', 'move-to-project', debounced],
    queryFn: () => api.searchProjects({ q: debounced, limit: 10 }),
    enabled: debounced !== '',
    retry: false,
  });
  const { data: tree, isLoading: treeLoading } = useQuery({
    queryKey: ['project-tree', project?.id],
    queryFn: () => api.getProjectTree(project!.id),
    enabled: project !== null,
    retry: false,
  });
  const items = tree?.sections.find((s) => s.section === 'impression')?.items ?? [];

  const move = useMutation({
    mutationFn: (target: PickedProject) =>
      api.importLibraryFilesToProject(target.id, {
        file_ids: fileIds,
        ...(typeof itemChoice === 'number' ? { item_id: itemChoice } : {}),
        ...(itemChoice === 'new' ? { new_item_name: newItemName.trim() } : {}),
      }),
    onSuccess: (result, target) => {
      for (const key of [
        ['library-files'],
        ['library-folders'],
        ['library-stats'],
        ['project-tree', target.id],
        ['project-files', target.id],
        ['project-file-progress', target.id],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      const filed = result.moved.length + result.copied.length;
      showToast(
        moveResultMessage(t, result, target.code ?? target.name),
        result.skipped.length > 0 ? 'warning' : filed > 0 ? 'success' : 'info',
      );
      onMoved?.(result);
      onClose();
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const pick = (p: PickedProject, itemId: number | null = null) => {
    setProject(p);
    setItemChoice(itemId ?? 'auto');
  };

  const canMove =
    project !== null && !move.isPending && (itemChoice !== 'new' || newItemName.trim() !== '');
  const title = t('projectsPdm.filing.moveTitle');
  const suggestedIds = new Set(suggestions.map((s) => s.project_id));
  const results = debounced ? (search?.items ?? []).filter((p) => !suggestedIds.has(p.id)) : [];

  const optionCls = (selected: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white transition-colors ${
      selected ? 'bg-bambu-green/20 ring-1 ring-bambu-green/60' : 'hover:bg-bambu-dark-tertiary/40'
    } ${focusRingCls}`;
  const radioRowCls =
    'flex min-h-[40px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none animate-modal-in"
      >
        <h2 className="text-lg font-semibold text-white">{title}</h2>

        {suggestions.length > 0 && (
          <section className="space-y-1">
            <h3 className="text-xs font-medium uppercase tracking-wide text-bambu-gray">{t('projectsPdm.filing.suggested')}</h3>
            <ul className="space-y-0.5">
              {suggestions.map((s) => {
                const selected = project?.id === s.project_id;
                return (
                  <li key={s.project_id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => pick({ id: s.project_id, code: s.code, name: s.name }, s.item_id)}
                      className={optionCls(selected)}
                    >
                      <ProjectCodeChip code={s.code} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      {s.item_name && <span className="flex-shrink-0 truncate text-xs text-bambu-gray">{s.item_name}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="space-y-1">
          <label className="flex items-center gap-2 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5">
            <Search aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('projectsPdm.filing.searchProject')}
              aria-label={t('projectsPdm.filing.searchProject')}
              className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none"
            />
            {searching && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-bambu-gray" />}
          </label>
          {results.length > 0 && (
            <ul className="max-h-48 space-y-0.5 overflow-y-auto">
              {results.map((p) => {
                const selected = project?.id === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => pick({ id: p.id, code: p.code, name: p.name })}
                      className={optionCls(selected)}
                    >
                      <ProjectCodeChip code={p.code} />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {project && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-bambu-gray">
              {t('projectsPdm.filing.targetItem')}
            </legend>
            <label className={radioRowCls}>
              <input
                type="radio"
                name="move-to-project-item"
                checked={itemChoice === 'auto'}
                onChange={() => setItemChoice('auto')}
                className="accent-bambu-green"
              />
              <span>{t('projectsPdm.filing.autoItem')}</span>
            </label>
            {treeLoading ? (
              <p role="status" className="flex items-center gap-2 px-3 text-sm text-bambu-gray-light">
                <Loader2 className="h-4 w-4 animate-spin text-bambu-green" aria-hidden="true" />
                {t('common.loading')}
              </p>
            ) : (
              items.map((item) => (
                <label key={item.id} className={radioRowCls}>
                  <input
                    type="radio"
                    name="move-to-project-item"
                    checked={itemChoice === item.id}
                    onChange={() => setItemChoice(item.id)}
                    className="accent-bambu-green"
                  />
                  <span className="min-w-0 break-words">{item.name}</span>
                </label>
              ))
            )}
            <label className={radioRowCls}>
              <input
                type="radio"
                name="move-to-project-item"
                checked={itemChoice === 'new'}
                onChange={() => setItemChoice('new')}
                className="accent-bambu-green"
              />
              <span>{t('projectsPdm.filing.newItem')}</span>
            </label>
            {itemChoice === 'new' && (
              <input
                type="text"
                autoFocus
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                aria-label={t('projectsPdm.filing.newItem')}
                maxLength={200}
                className="w-full rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white focus:border-bambu-green focus:outline-none"
              />
            )}
          </fieldset>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!canMove}
            onClick={() => project && move.mutate(project)}
            aria-label={t('projectsPdm.filing.move')}
          >
            {move.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : t('projectsPdm.filing.move')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
