import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Undo2 } from 'lucide-react';
import { CardView } from './CardView';
import { HoldButton } from './HoldButton';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { useIsReverting } from '../../hooks/useRevertFlash';
import { isPlaceholder } from '../../utils/aitoOptimistic';
import { sortByRecencyDesc } from '../../utils/aitoSearch';
import { restoreButtonCls, restoreHoldDurationMs } from './restoreButton';
import type { AitoProject } from '../../api/client';

/** One project in the grid.
 *
 *  Its own component because the restore mutation is per-project, and this is
 *  already the one-per-project layer — the same reason `SortableCard` owns
 *  mark-sent rather than `BoardColumn` owning one mutation per column. */
function DoneCard({ project, onExpand }: { project: AitoProject; onExpand: () => void }) {
  const { t } = useTranslation();
  const restore = useColumnMoveMutation(project, 'finish');
  // A card whose restore failed and snapped back. On this wrapper rather than
  // on CardView, matching how the board does it.
  const reverting = useIsReverting(project.id);

  return (
    <div className={reverting ? 'animate-revert-flash' : ''}>
      <CardView
        project={project}
        placeholder={isPlaceholder(project)}
        onExpand={onExpand}
        actions={
          // `move_lock === null` is the rules' own release. A declined quote
          // sits here with move_lock 'declined' and cannot leave — offering a
          // button the server would 409 is worse than offering none.
          project.move_lock === null ? (
            <HoldButton
              onHold={() => restore.mutate()}
              durationMs={restoreHoldDurationMs}
              disabled={restore.isPending}
              label={t('aito.restoreToFinish')}
              hint={t('aito.holdToConfirm')}
              className={restoreButtonCls}
            >
              <Undo2 className="relative w-3.5 h-3.5" />
            </HoldButton>
          ) : null
        }
      />
    </div>
  );
}

/** Finished projects, as a grid rather than a column.
 *
 *  Done is an archive: it only grows, and a 300px-wide vertical list is the
 *  wrong shape for hundreds of cards. The grid is the same `CardView` the
 *  board renders — no drag handle, no mark-sent, a restore button instead —
 *  so a card looks the same wherever you meet it, and `data-aito-card-id`
 *  keeps the morph into the detail panel working from here too.
 *
 *  Ordered by `updated_at` descending, NOT by the stored board position: once
 *  Done is the dumping ground, its positions are arbitrary drop-order history
 *  and mean nothing to anyone reading the archive. */
export function DoneGrid({
  projects,
  query,
  onExpandCard,
}: {
  projects: AitoProject[];
  query: string;
  onExpandCard: (id: number) => void;
}) {
  const { t } = useTranslation();

  const visible = useMemo(() => sortByRecencyDesc(projects, query), [projects, query]);

  if (visible.length === 0) {
    return (
      <div className="flex-1 text-center py-8 animate-rise">
        <Archive className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
        <p className="text-white font-medium">
          {t(query.trim() ? 'aito.searchNoResults' : 'aito.doneEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-4">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 stagger-parents">
        {/* `animate-rise-lg`, not `animate-rise`: only the -lg entrance reads
            `--enter-delay`, which is the ONLY thing `stagger-parents` above
            sets. Paired with the plain rise the cascade silently did nothing
            and the whole archive landed on one frame. Same pairing the board's
            columns, Archives and the file grid use. */}
        {visible.map((project) => (
          <div key={project.id} className="animate-rise-lg">
            <DoneCard project={project} onExpand={() => onExpandCard(project.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
