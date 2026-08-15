import type { ReactNode } from 'react';
import type { AitoProject } from '../../../api/client';

/** The scroller + responsive card grid shared by the Done and Trash archives.
 *
 *  `DoneGrid` and `TrashGrid` are the same archive shape wearing a different
 *  card and a different restore action — this is that shared shape, factored
 *  out so the two do not drift. `animate-rise-lg`, not `animate-rise`: only
 *  the -lg entrance reads `--enter-delay`, which is the ONLY thing
 *  `stagger-parents` below sets. Same pairing the board's columns use. */
export function ArchiveGrid({
  projects,
  renderCard,
}: {
  projects: AitoProject[];
  renderCard: (project: AitoProject) => ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pb-4">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 stagger-parents">
        {projects.map((project) => (
          <div key={project.id} className="animate-rise-lg">
            {renderCard(project)}
          </div>
        ))}
      </div>
    </div>
  );
}
