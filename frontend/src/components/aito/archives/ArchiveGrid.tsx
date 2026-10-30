import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import type { AitoProject } from '../../../api/client';
import { useFlipReorder } from '../../../hooks/useFlipReorder';

/** The scroller + responsive card grid shared by the Done and Trash archives.
 *
 *  `DoneGrid` and `TrashGrid` are the same archive shape wearing a different
 *  card and a different restore action — this is that shared shape, factored
 *  out so the two do not drift. `animate-rise-lg`, not `animate-rise`: only
 *  the -lg entrance reads `--enter-delay`, which is the ONLY thing
 *  `stagger-parents` below sets. Same pairing the board's columns use.
 *
 *  After first paint the grid reflows rather than redraws: a restore takes a
 *  card out on the optimistic write, and without `useFlipReorder` every card
 *  after it jumped a slot on one frame. `useCardFlight` only watches the
 *  board, and the grid is two-dimensional, so it is the camera wall's FLIP
 *  hook — 2-D, retargeting, reduced-motion aware — not the board's Y-only
 *  reflow. The hook also rises a card that ARRIVES on a populated grid, which
 *  is why the stagger entrance is confined to first paint below: a card
 *  returning from a search filter would otherwise get both, and the CSS
 *  animation's delayed `backwards` fill would blank it out again the moment
 *  the hook's tween finished. */
export interface ArchiveGroup {
  key: string;
  label: string;
}

/** One header row per run of a new group key, as `col-span-full` cells of
 *  the SAME grid, not one grid per group: the FLIP hook measures one
 *  container's children, and a card changing month on a sort flip still
 *  slides rather than teleporting between two grids. Headers carry no
 *  `data-flip-key`, so the hook ignores them. Sticky to the scroller's top
 *  — the scroller is the element above, which is the one that scrolls. */
function GroupHeader({ group, count }: { group: ArchiveGroup; count: number }) {
  return (
    <div
      data-testid="aito-archive-group"
      data-group-key={group.key}
      className="col-span-full sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-bambu-dark/95 backdrop-blur-sm flex items-baseline gap-2 border-b border-bambu-dark-tertiary"
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-bambu-gray-light">{group.label}</span>
      <span className="text-[11px] text-bambu-gray tabular-nums">{count}</span>
    </div>
  );
}

export function ArchiveGrid({
  projects,
  renderCard,
  groupOf,
}: {
  projects: AitoProject[];
  renderCard: (project: AitoProject) => ReactNode;
  /** Month headers: the group each card belongs under. `projects` must
   *  already be sorted so a group's cards are contiguous — the grid opens a
   *  header wherever the key changes and never re-sorts. Omitted → no
   *  headers (the sorts that are not dates). */
  groupOf?: (project: AitoProject) => ArchiveGroup;
}) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  useFlipReorder(gridRef, projects.map((project) => project.id).join(','));

  // The cards on screen at first paint, and only those, carry the stagger
  // entrance; every later arrival is the hook's. Initialised at render, once,
  // and pruned post-commit so a first-paint card that leaves (filtered,
  // restored) and comes back counts as an arrival like any other.
  const staggerIdsRef = useRef<Set<number> | null>(null);
  if (staggerIdsRef.current === null && projects.length > 0) {
    staggerIdsRef.current = new Set(projects.map((project) => project.id));
  }
  useEffect(() => {
    const ids = staggerIdsRef.current;
    if (!ids) return;
    const present = new Set(projects.map((project) => project.id));
    for (const id of ids) if (!present.has(id)) ids.delete(id);
  }, [projects]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-4">
      <div ref={gridRef} className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 stagger-parents">
        {projects.map((project, index) => {
          const group = groupOf?.(project);
          const opens = group !== undefined && (index === 0 || groupOf!(projects[index - 1]).key !== group.key);
          let count = 0;
          if (opens) {
            while (index + count < projects.length && groupOf!(projects[index + count]).key === group.key) count += 1;
          }
          return (
            <Fragment key={project.id}>
              {opens && <GroupHeader group={group} count={count} />}
              <div
                data-flip-key={project.id}
                className={staggerIdsRef.current?.has(project.id) ? 'animate-rise-lg' : undefined}
              >
                {renderCard(project)}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
