import { useTranslation } from 'react-i18next';
import { DONE_OUTCOME_CLS, doneOutcomesOf } from './doneOutcome';
import type { AitoProject } from '../../api/client';

/** What happened to a finished card, in its footer: Declined, Shipped,
 *  Unpaid. The archive grid lost that fact when the Done column became a
 *  grid — a declined quote and a delivered job are the same card shape —
 *  and the filter pills above the grid only answer it for the set, not for
 *  the card in front of you. Same words and colours as those pills. Renders
 *  nothing for a plain finished job, and nothing off the Done column: on the
 *  board the column already says what the card is. Nothing in the trash
 *  either, where "deleted" is the one fact the footer is for. */
export function DoneOutcomeTags({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  if (project.column !== 'done' || project.status !== 'active') return null;
  const outcomes = doneOutcomesOf(project);
  if (outcomes.length === 0) return null;
  return (
    <span data-testid="aito-card-outcomes" className="inline-flex items-center gap-1 shrink-0">
      {outcomes.map((outcome) => (
        <span
          key={outcome}
          className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider leading-4 ${DONE_OUTCOME_CLS[outcome]}`}
        >
          {t(`aito.doneArchive.${outcome}`)}
        </span>
      ))}
    </span>
  );
}
