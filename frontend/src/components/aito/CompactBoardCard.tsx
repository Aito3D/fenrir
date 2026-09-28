import { useRef } from 'react';
import type { AitoProject } from '../../api/client';
import { CardView } from './CardView';
import { BoardCardActions } from './BoardCardActions';
import { useIsReverting } from '../../hooks/useRevertFlash';
import { isPlaceholder } from '../../utils/aitoOptimistic';

/** One card on the touch boards (phone and tablet): the compact CardView with
 *  the board's own footer actions, no sortable wrapper — touch boards have no
 *  drag. */
export function CompactBoardCard({ project, onExpand }: { project: AitoProject; onExpand: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reverting = useIsReverting(project.id);
  const placeholder = isPlaceholder(project);
  return (
    <div ref={cardRef} className={reverting ? 'animate-revert-flash' : ''}>
      <CardView
        project={project}
        placeholder={placeholder}
        onExpand={onExpand}
        compact
        actions={<BoardCardActions project={project} cardRef={cardRef} />}
      />
    </div>
  );
}
