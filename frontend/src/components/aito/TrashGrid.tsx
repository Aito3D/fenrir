import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Trash2, Undo2 } from 'lucide-react';
import { CardView } from './CardView';
import { HoldButton } from './HoldButton';
import { Button } from '../Button';
import { api, ApiError, type AitoProject } from '../../api/client';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { useToast } from '../../contexts/ToastContext';
import { applyRestore } from '../../utils/aitoOptimistic';
import { matchesSearch } from '../../utils/aitoSearch';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';

/** One deleted project, with the only action it has left.
 *
 *  Its own component for the reason `DoneCard` is: the restore mutation is
 *  per-project, and this is the one-per-project layer. */
function TrashCard({ project, onExpand }: { project: AitoProject; onExpand: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const restore = useOptimisticBoardMutation<AitoProject, AitoProject>({
    mutationFn: (target) => api.restoreAitoProject(target.id),
    // The restored card lands on the board immediately. Its column comes from
    // the server on success — the trash row's stored column can be stale, and
    // the rules may relocate it — so this is the one transform that predicts a
    // column it does not compute.
    // applyRestore, not applyCreate: restore_project APPENDS to the end of
    // the card's own column, where create_project prepends to Devis.
    transform: (previous, target) => applyRestore(previous, { ...target, status: 'active' }),
    flashId: (target) => target.id,
    onSuccess: (restored) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === restored.id ? restored : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.restored'));
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.restoreBlockedByQuote' : 'aito.restoreFailed'), 'error');
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
    },
  });

  return (
    <CardView
      project={project}
      onExpand={onExpand}
      // `updated_at`, because a soft delete is the last write the row took.
      footerNote={t('aito.deletedOn', { date: formatElapsedTime(project.updated_at, t) })}
      actions={
        <HoldButton
          onHold={() => {
            // Drop it from the trash list too — the mutation wrapper's
            // transform only owns the board query.
            queryClient.setQueryData<AitoProject[]>(['aito-trash'], (prev) =>
              prev?.filter((p) => p.id !== project.id) ?? prev,
            );
            restore.mutate(project);
          }}
          durationMs={500}
          disabled={restore.isPending}
          label={t('aito.restore')}
          hint={t('aito.holdToConfirm')}
          className="p-1 -m-1 text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary focus-visible:ring-bambu-green/40 data-[holding=true]:text-white"
        >
          <Undo2 className="relative w-3.5 h-3.5" />
        </HoldButton>
      }
    />
  );
}

/** Deleted projects, as a grid — the same shape as the Done archive.
 *
 *  This replaced a modal holding a list of stripped-down rows. Two archives
 *  that behave differently is one archive too many: a card in the trash now
 *  looks like a card everywhere else, opens the same detail panel, is filtered
 *  by the same board search, and is restored by the same hold-to-confirm
 *  gesture Done uses.
 *
 *  Ordered by `updated_at` descending — most recently deleted first, which is
 *  the one you are almost always here for.
 *
 *  The rows are the caller's: `AitoPage` owns the ['aito-trash'] query because
 *  it also has to resolve a trashed project for the detail panel, and the
 *  board query it normally looks in does not carry deleted rows. */
export function TrashGrid({
  projects,
  query,
  isLoading,
  isError,
  onRetry,
  onExpandCard,
}: {
  projects: AitoProject[];
  query: string;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onExpandCard: (id: number) => void;
}) {
  const { t } = useTranslation();

  const visible = useMemo(() => {
    // `parseUTCDate`, not a string compare: the board's timestamps are
    // inconsistently suffixed ('…:00Z' on some rows, '…:00' on others) and a
    // lexical compare orders those two forms by their suffix, not their
    // instant. Ties break on id descending so the order is stable.
    const time = (project: AitoProject) => parseUTCDate(project.updated_at)?.getTime() ?? 0;
    return projects
      .filter((project) => matchesSearch(project, query))
      .slice()
      .sort((a, b) => time(b) - time(a) || b.id - a.id);
  }, [projects, query]);

  if (isError) {
    return (
      <div className="flex-1 text-center py-8 animate-rise">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-white font-medium">{t('aito.loadFailed')}</p>
        <Button variant="secondary" onClick={onRetry} className="mt-4 mx-auto">
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  // Unlike the Done grid, this view arrives with nothing: it is the only part
  // of the board with a fetch of its own, and it starts that fetch when the
  // user switches to it. Without this the empty state below flashes "nothing
  // in the trash" over every load, which is a lie about half a second long.
  if (isLoading) {
    return (
      <div className="flex-1 text-center py-8">
        <Loader2 className="w-8 h-8 text-bambu-gray mx-auto animate-spin" />
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div className="flex-1 text-center py-8 animate-rise">
        <Trash2 className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
        <p className="text-white font-medium">
          {t(query.trim() ? 'aito.searchNoResults' : 'aito.trashEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-4">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 stagger-parents">
        {/* `animate-rise-lg`, not `animate-rise`: only the -lg entrance reads
            `--enter-delay`, which is the ONLY thing `stagger-parents` above
            sets. Same pairing the done grid and the board's columns use. */}
        {visible.map((project) => (
          <div key={project.id} className="animate-rise-lg">
            <TrashCard project={project} onExpand={() => onExpandCard(project.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
