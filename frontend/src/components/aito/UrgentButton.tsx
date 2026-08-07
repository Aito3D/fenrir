import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { headerPillRadiusCls, headerPillTypeCls } from './panelTypography';
import { useFlagMutation } from '../../hooks/useFlagMutation';
import { type AitoProject } from '../../api/client';

/** Hold-to-toggle urgency, for the panel header's pill row.
 *
 *  Symmetric on purpose: the same 0.5s hold both sets and clears. An urgent
 *  job is exactly the thing that must not be un-flagged by a stray click, and
 *  a gesture that is deliberate in one direction and casual in the other
 *  invites precisely that.
 *
 *  `progress="bar"` because this is a wide labelled pill — `HoldButton`'s
 *  ring variant uses `viewBox="0 0 24 24"` and would land as a small circle
 *  floating over the middle of the label rather than as progress.
 *
 *  Shaped as one of the header's status pills rather than as a footer button:
 *  once set, this IS the urgent pill — same .4rem outline, 11px
 *  semibold type and 3.5 glyph as the shipping pill beside it — so the flag
 *  reads as a fact about the project in the row where the project's other
 *  facts already live, and the control that sets it is the same object. The
 *  radius goes through `radiusClassName`, not `className`: see HoldButton.
 *
 *  Amber, board-wide: urgency is a fixed semantic yellow here, matching the
 *  card chip and halo (index.css `urgent-halo`), and deliberately not the
 *  destructive red the footer's delete owns.
 *
 *  Padding, border width and border colour are supplied here IN FULL, as
 *  every HoldButton caller must: the base deliberately sets none of them,
 *  because same-specificity Tailwind utilities resolve by compiled stylesheet
 *  order rather than by call site, so a base value could not be overridden
 *  from here reliably.
 *
 *  Panel only, never the board card: flagging is a deliberate act that
 *  belongs where you have the project open in front of you. */
export function UrgentButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const mutation = useFlagMutation(project);
  const on = project.flag === 'urgent';

  return (
    <HoldButton
      onHold={() => mutation.mutate(on ? null : 'urgent')}
      durationMs={500}
      progress="bar"
      barClassName="bg-amber-400/25"
      disabled={mutation.isPending}
      label={on ? t('aito.clearUrgent') : t('aito.markUrgent')}
      hint={on ? t('aito.holdToClearUrgent') : t('aito.holdToMarkUrgent')}
      radiusClassName={headerPillRadiusCls}
      // Downward: the panel root is `overflow-hidden` and this pill sits on
      // the header's first row, so the default upward hint would be clipped
      // away entirely rather than merely cramped.
      hintPlacement="bottom"
      // Set: the filled amber pill, identical in construction to the shipping
      // pill next to it. Clear: an outline-only ghost of the same pill, so the
      // control keeps its place in the row without claiming colour it has not
      // earned — the header band already carries three coloured facts.
      className={`whitespace-nowrap ${headerPillTypeCls} ${
        on
          ? 'border-amber-400/30 bg-amber-400/[0.14] text-amber-400 hover:bg-amber-400/25'
          : 'border-bambu-dark-tertiary text-bambu-gray hover:border-amber-400/50 hover:text-amber-400'
      } focus-visible:ring-amber-400/40`}
    >
      <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
      {on ? t('aito.urgent') : t('aito.markUrgent')}
    </HoldButton>
  );
}
