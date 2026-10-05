import { ProjectCodeChip } from '../ProjectCodeChip';
import { useProjectCodes } from './useProjectCodes';

// One chip: a 1440px board's card footer has no room for two beside the date.
const MAX_CHIPS = 1;

/** The PDM project codes of an order's tasks, for the card footer: one chip,
 *  then "+N". The cluster may shrink (clipping the chip) so the footer's
 *  elapsed date always keeps its width. Renders nothing without a linked project. */
export function CardProjectChips({ orderId }: { orderId: number }) {
  const codes = useProjectCodes()[String(orderId)] ?? [];
  if (codes.length === 0) return null;
  return (
    <span data-testid="aito-card-project-chips" className="flex min-w-0 items-center gap-1 overflow-hidden">
      {codes.slice(0, MAX_CHIPS).map((code) => (
        <ProjectCodeChip key={code} code={code} />
      ))}
      {codes.length > MAX_CHIPS && (
        <span title={codes.slice(MAX_CHIPS).join(', ')} className="shrink-0 text-xs font-medium text-bambu-gray-light">
          +{codes.length - MAX_CHIPS}
        </span>
      )}
    </span>
  );
}
