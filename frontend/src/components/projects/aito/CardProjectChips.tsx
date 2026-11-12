import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { ProjectCodeChip } from '../ProjectCodeChip';
import { projectKeys } from '../projectQueries';
import { useProjectCodes } from './useProjectCodes';

// One chip: a 1440px board's card footer has no room for two beside the date.
const MAX_CHIPS = 1;

const WARNING_KEYS = {
  outdated: 'projectsPdm.aito.cardWarningOutdated',
  no_revision: 'projectsPdm.aito.cardWarningNoRevision',
} as const;

/** The PDM project codes of an order's tasks, for the card footer: one chip,
 *  then "+N", then one warning sign when a delivered print file is outdated or
 *  a printing step has no print file yet. The cluster may shrink (clipping the
 *  chip) so the footer's elapsed date always keeps its width. Renders nothing
 *  without a linked project. */
export function CardProjectChips({ orderId }: { orderId: number }) {
  const { t } = useTranslation();
  const codes = useProjectCodes()[String(orderId)] ?? [];
  // One request shared by every board card, like the codes.
  const { data: warnings } = useQuery({
    queryKey: projectKeys.projectWarnings(),
    queryFn: api.getAitoProjectWarnings,
    staleTime: 30_000,
    retry: false,
  });
  const warning = warnings?.[String(orderId)];
  if (codes.length === 0 && !warning) return null;
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
      {warning && (
        <span
          role="img"
          data-testid="aito-card-project-warning"
          title={t(WARNING_KEYS[warning])}
          aria-label={t(WARNING_KEYS[warning])}
          className="shrink-0 text-amber-400"
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
