import { ProjectCodeChip } from '../ProjectCodeChip';
import { useProjectCodes } from './useProjectCodes';

const MAX_CHIPS = 2;

/** The PDM project codes of an order's tasks, for the card footer: two chips,
 *  then "+N". Renders nothing for an order without a linked project. */
export function CardProjectChips({ orderId }: { orderId: number }) {
  const codes = useProjectCodes()[String(orderId)] ?? [];
  if (codes.length === 0) return null;
  return (
    <span data-testid="aito-card-project-chips" className="flex items-center gap-1 flex-shrink-0">
      {codes.slice(0, MAX_CHIPS).map((code) => (
        <ProjectCodeChip key={code} code={code} />
      ))}
      {codes.length > MAX_CHIPS && (
        <span className="text-xs font-medium text-bambu-gray-light">+{codes.length - MAX_CHIPS}</span>
      )}
    </span>
  );
}
