import { useTranslation } from 'react-i18next';
import { Check, Plane } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { type AitoProject } from '../../api/client';

/** Finish → Done, for the panel footer.
 *
 *  The board card already carries this as an icon (see BoardColumn's
 *  `SortableCard`), but the panel is where a project is actually finished off:
 *  you open it to tick the last step, and until now the only way to archive it
 *  from there was to close the panel and find the card again.
 *
 *  Its own component rather than a branch inside `QuoteStatusActions`, which is
 *  the neighbouring footer block and looks identical: that one writes a QUOTE
 *  STATUS and the column follows from it (aito_board_rules.evaluate), this one
 *  writes the column directly. Finish → Done is the single transition the rules
 *  hand back to the user, and it is the only one that has no quote status to
 *  express it — folding it into a component whose every other action is a Zoho
 *  estimate transition would make that distinction invisible at both call
 *  sites.
 *
 *  Both halves of the gate matter, and both are the SERVER's derived values:
 *  the column is where the card has to be, and `move_lock === null` is the
 *  rules' own release — it is what keeps this off a declined quote, which sits
 *  in Done with `move_lock: 'declined'` and would 409 the move. Same gate the
 *  board card uses, deliberately: two surfaces offering one transition must
 *  never disagree about when it is available.
 *
 *  It cannot collide with the quote actions beside it either. A card only
 *  reaches Finish on an accepted quote, and `QuoteStatusActions` renders
 *  nothing once the quote is accepted, so exactly one of the two blocks is ever
 *  on the bar. */
export function ProjectDoneAction({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const markDone = useColumnMoveMutation(project, 'done');

  // After the hook, never before it: the panel re-renders with the moved row
  // the instant the optimistic write lands, and a gate above the hook would
  // change the hook order on that exact render. Same rule QuoteStatusActions
  // follows for its own `accepted` early return.
  if (project.column !== 'finish' || project.move_lock !== null) return null;

  return (
    <HoldButton
      onHold={() => markDone.mutate()}
      durationMs={500}
      disabled={markDone.isPending}
      label={t('aito.markProjectDone')}
      hint={t('aito.holdToConfirm')}
      // `bar`, not the board card's `perimeter`: this is a labelled pill, and
      // the perimeter trace reads as progress only on a button that is its own
      // icon. Green fill for the same reason Accept passes one — a red bar
      // sweeping under "Mark project as done" states the wrong outcome
      // mid-gesture.
      progress="bar"
      barClassName="bg-bambu-green/25"
      // Padding, border and colour in full, like every HoldButton caller: the
      // base deliberately sets none of them (see its doc). Matched to the
      // quote actions' pills so the footer's safe end is one row of buttons,
      // not two shapes.
      // Same glow as the board card's icon (BoardColumn) when the quote has
      // been invoiced in Books: the job is billed, and this pill is the
      // panel's own "archive me" signal.
      className={`justify-center border px-2.5 py-1 border-bambu-green/40 text-bambu-green hover:bg-bambu-green/10 ${
        project.quote_invoiced ? 'animate-invoiced-glow' : ''
      }`}
    >
      {/* Both surfaces offer the one Finish -> Done transition and must never
          disagree — see BoardColumn's SortableCard for the identical swap
          and its reasoning (enlarged so a plane at check size doesn't read
          as a smudge). */}
      {project.shipping_island ? (
        <Plane className="w-[1.15rem] h-[1.15rem]" />
      ) : (
        <Check className="w-3.5 h-3.5" />
      )}
      <span className="text-sm">{t('aito.markProjectDone')}</span>
    </HoldButton>
  );
}
