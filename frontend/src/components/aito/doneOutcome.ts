import { doneFilterMatches, type DoneFilter } from '../../utils/aitoDoneArchive';
import type { AitoProject } from '../../api/client';

/** Colour per outcome, complete class strings (Tailwind cannot see
 *  fragments). Shared by the archive's filter pills and the tag a Done card
 *  wears, so the pill you press and the tag it reveals are the same colour.
 *  `all` is the toolbar's neutral; `declined` is the status-error red the
 *  panel's status pill already paints a declined quote; `unpaid` is the
 *  follow-up strip's red too, but that strip never shows a finished card, so
 *  amber here keeps the two apart when both are on screen. */
export const DONE_OUTCOME_CLS: Record<DoneFilter, string> = {
  all: 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray-light',
  accepted: 'border-bambu-green/30 bg-bambu-green/[0.12] text-bambu-green',
  declined: 'border-status-error/30 bg-status-error/[0.12] text-status-error',
  unpaid: 'border-amber-400/30 bg-amber-400/[0.12] text-amber-400',
  shipped: 'border-sky-400/30 bg-sky-400/[0.12] text-sky-400',
};

export type DoneOutcome = Exclude<DoneFilter, 'all' | 'accepted'>;

/** The tags a finished card wears, in display order. "Accepted" is the
 *  archive's default and gets no tag: a Done card with nothing to say is a
 *  job that was done, and tagging every one of them would say nothing. A
 *  declined quote was never shipped or billed, so it is the one tag; a
 *  finished job can be both shipped and still unpaid. */
const TAGGED: DoneOutcome[] = ['declined', 'shipped', 'unpaid'];

export function doneOutcomesOf(project: AitoProject): DoneOutcome[] {
  return TAGGED.filter((outcome) => doneFilterMatches(project, outcome));
}
