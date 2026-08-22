import { useTranslation } from 'react-i18next';
import { Check, Phone } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { headerPillRadiusCls } from './panelTypography';
import { useContactedMutation } from '../../hooks/useContactedMutation';
import { type AitoProject } from '../../api/client';

/** The panel's counterpart to the board card's contact button — and the only
 *  place a contact can be TAKEN BACK.
 *
 *  The card cannot offer that: once the client has been told, the card's one
 *  action slot belongs to Done. So the card advances the project and the panel
 *  is where a mistake is corrected, which is the same division the board draws
 *  everywhere else — the card carries the column's primary move, the panel
 *  carries the deliberate acts.
 *
 *  Holds are symmetric, 0.5s each way, exactly like `FlagControl`. Taking back
 *  a contact re-closes the Done gate on a project someone may be about to
 *  archive, and a gesture deliberate in one direction and casual in the other
 *  invites precisely the stray click that would do it.
 *
 *  It takes `FlagControl`'s place in the header row rather than sitting beside
 *  it: a finished project has no use for a production flag (see `isFinished`),
 *  and this is the fact that row should be showing instead. Same pill shape as
 *  the shipping and quote pills next to it, so the row stays one line of
 *  facts. */
export function ContactedControl({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const mutation = useContactedMutation(project);
  const contacted = project.client_contacted_at !== null;

  return (
    <HoldButton
      onHold={() => mutation.mutate(!contacted)}
      durationMs={500}
      disabled={mutation.isPending}
      ariaPressed={contacted}
      label={t(contacted ? 'aito.clearContacted' : 'aito.markContacted')}
      hint={t(contacted ? 'aito.holdToClearContacted' : 'aito.holdToMarkContacted')}
      // `bar`, not `ring`: HoldButton's ring uses viewBox="0 0 24 24" and lands
      // as a small circle floating over the middle of a wide label rather than
      // as progress — the same reason FlagControl's segments pass `bar`.
      progress="bar"
      barClassName={contacted ? 'bg-bambu-green/25' : 'bg-cyan-400/25'}
      radiusClassName={headerPillRadiusCls}
      // Downward: the panel root is `overflow-hidden` and this pill sits on the
      // header's first row, so the default upward hint would be clipped away
      // entirely rather than merely cramped.
      hintPlacement="bottom"
      // Padding, border width and colour in full, as every HoldButton caller
      // must: the base sets none of them, because same-specificity Tailwind
      // utilities resolve by compiled stylesheet order rather than by call
      // site.
      //
      // Cyan while outstanding, green once done — the same two tones the board
      // card uses for the same two states, so the panel and the card cannot
      // read as describing different things.
      className={`whitespace-nowrap border px-2 py-0.5 text-[11px] font-semibold ${
        contacted
          ? 'border-bambu-green/30 bg-bambu-green/[0.14] text-bambu-green focus-visible:ring-bambu-green/40'
          : 'border-cyan-400/30 bg-cyan-400/[0.14] text-cyan-400 focus-visible:ring-cyan-400/40'
      }`}
    >
      {contacted ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Phone className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {t(contacted ? 'aito.contacted' : 'aito.markContacted')}
    </HoldButton>
  );
}
