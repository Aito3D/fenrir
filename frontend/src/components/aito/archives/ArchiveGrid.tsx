import { useEffect, useRef, type ReactNode } from 'react';
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
export function ArchiveGrid({
  projects,
  renderCard,
}: {
  projects: AitoProject[];
  renderCard: (project: AitoProject) => ReactNode;
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
        {projects.map((project) => (
          <div
            key={project.id}
            data-flip-key={project.id}
            className={staggerIdsRef.current?.has(project.id) ? 'animate-rise-lg' : undefined}
          >
            {renderCard(project)}
          </div>
        ))}
      </div>
    </div>
  );
}
