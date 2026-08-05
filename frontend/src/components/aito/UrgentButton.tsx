import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { useUrgentMutation } from '../../hooks/useUrgentMutation';
import { type AitoProject } from '../../api/client';

/** Hold-to-toggle urgency, for the panel footer.
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
 *  Padding, border width and border colour are supplied here IN FULL, as
 *  every HoldButton caller must: the base deliberately sets none of them,
 *  because same-specificity Tailwind utilities resolve by compiled stylesheet
 *  order rather than by call site, so a base value could not be overridden
 *  from here reliably.
 *
 *  Panel only, never the card footer: the footer already carries mark-sent,
 *  mark-done and delete, and flagging is a deliberate act that belongs where
 *  you have the project open in front of you. */
export function UrgentButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const mutation = useUrgentMutation(project);
  const on = project.urgent;

  return (
    <HoldButton
      onHold={() => mutation.mutate(!on)}
      durationMs={500}
      progress="bar"
      barClassName="bg-red-400/25"
      disabled={mutation.isPending}
      label={on ? t('aito.clearUrgent') : t('aito.markUrgent')}
      hint={on ? t('aito.holdToClearUrgent') : t('aito.holdToMarkUrgent')}
      className={`px-2.5 py-1 text-xs font-semibold border ${
        on
          ? 'border-status-error bg-status-error/15 text-red-300 hover:text-white'
          : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-status-error/50'
      } focus-visible:ring-status-error/40`}
    >
      <AlertTriangle className="w-3.5 h-3.5" />
      {on ? t('aito.urgent') : t('aito.markUrgent')}
    </HoldButton>
  );
}
