import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, SearchX, Undo2 } from 'lucide-react';
import { ArchiveGrid } from './archives/ArchiveGrid';
import { ArchiveToolbar } from './ArchiveToolbar';
import { CardView } from './CardView';
import { HoldButton } from './HoldButton';
import { useArchiveGroups } from '../../hooks/useArchiveGroups';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { useIsReverting } from '../../hooks/useRevertFlash';
import {
  doneFilterCounts,
  doneFilterMatches,
  finishedAt,
  sortDone,
  winLoss,
  type DoneFilter,
  type DoneSort,
} from '../../utils/aitoDoneArchive';
import { isPlaceholder } from '../../utils/aitoOptimistic';
import { matchesSearch } from '../../utils/aitoSearch';
import { restoreButtonCls, restoreHoldDurationMs } from './restoreButton';
import type { AitoProject } from '../../api/client';

/** One project in the grid.
 *
 *  Its own component because the restore mutation is per-project, and this is
 *  already the one-per-project layer — the same reason `SortableCard` owns
 *  mark-sent rather than `BoardColumn` owning one mutation per column. */
function DoneCard({
  project,
  onExpand,
  canUpdate,
}: {
  project: AitoProject;
  onExpand: () => void;
  /** POST /{project_id}/restore — well, `moveAitoProject` here, but the same
   *  Permission.AITO_UPDATE guards it — see AitoPage's own doc. */
  canUpdate: boolean;
}) {
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
          project.move_lock === null && canUpdate ? (
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
 *  Ordered by `done_at` descending by default, NOT by the stored board
 *  position: once Done is the dumping ground, its positions are arbitrary
 *  drop-order history and mean nothing to anyone reading the archive. The
 *  sort menu offers the other orders (`aitoDoneArchive.ts`) and a date sort
 *  groups the grid under month headers. Filter and sort are the page's
 *  (`useAitoViewParams`): mirrored into the URL, the sort remembered across
 *  visits, the filter not. The search (AitoPage's box) runs first; the pill
 *  counts are over what it keeps, so they read "of these". */
export function DoneGrid({
  projects,
  query,
  filter,
  onFilter,
  sort,
  onSort,
  onExpandCard,
  canUpdate,
}: {
  projects: AitoProject[];
  query: string;
  filter: DoneFilter;
  onFilter: (next: DoneFilter) => void;
  sort: DoneSort;
  onSort: (next: DoneSort) => void;
  onExpandCard: (id: number) => void;
  /** Gates the restore-to-Finish control on every card — see DoneCard's own
   *  doc. */
  canUpdate: boolean;
}) {
  const { t } = useTranslation();

  const searched = useMemo(() => projects.filter((project) => matchesSearch(project, query)), [projects, query]);
  const counts = useMemo(() => doneFilterCounts(searched), [searched]);
  const visible = useMemo(
    () => sortDone(searched.filter((project) => doneFilterMatches(project, filter)), sort),
    [searched, filter, sort],
  );
  const groupOf = useArchiveGroups(sort, finishedAt);

  // Three different nothings. An empty archive has no controls to offer; a
  // search that hid everything says so (the board says the same sentence
  // for the same query); a filter that hid everything keeps the pills, or
  // there would be no way to release it.
  let body;
  if (visible.length === 0) {
    const Icon = projects.length === 0 ? Archive : SearchX;
    const key =
      projects.length === 0 ? 'aito.doneEmpty' : searched.length === 0 ? 'aito.searchNoResults' : 'aito.doneArchive.noResults';
    body = (
      <div className="flex-1 text-center py-8 animate-rise">
        <Icon className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
        <p className="text-white font-medium">{t(key)}</p>
      </div>
    );
  } else {
    body = (
      <ArchiveGrid
        projects={visible}
        groupOf={groupOf ?? undefined}
        renderCard={(project) => (
          <DoneCard project={project} onExpand={() => onExpandCard(project.id)} canUpdate={canUpdate} />
        )}
      />
    );
  }

  return (
    <>
      {projects.length > 0 && (
        <ArchiveToolbar
          counts={counts}
          filter={filter}
          onFilter={onFilter}
          winLoss={winLoss(counts)}
          sort={sort}
          onSort={onSort}
          dateLabel="finished"
        />
      )}
      {body}
    </>
  );
}
