import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { AITO_SERVICE_LABEL_KEYS, serviceDotCls, taskSteps } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import type { TaskDraft } from '../../utils/taskDraft';

const DESCRIPTION_FIELD = {
  scan: 'scanDescription',
  modelisation: 'modelisationDescription',
  impression: 'impressionDescription',
  usinage: 'usinageDescription',
} as const;

export interface TaskStepListProps {
  task: TaskDraft;
  onChange: (next: TaskDraft) => void;
  /** Whether the steps may be ticked at all — true only on a project whose
   *  quote is accepted. False renders name and cost with NO toggle rather than
   *  a disabled one: before acceptance there is no authorised work to tick, so
   *  there is nothing for an inert control to explain. A step already ticked
   *  still renders as ticked, because that is stored history. */
  canTick: boolean;
}

/** A task's steps, read-only apart from their Done toggles.
 *
 *  Only steps that EXIST are listed — a service with no cost is absent from
 *  the job and appears solely in edit mode, where typing a cost is what
 *  creates it. A step quoted at 0 is listed like any other: free is not
 *  absent.
 *
 *  Done is a one-click toggle both ways, deliberately without the
 *  hold-to-confirm the destructive controls use. Un-ticking is the undo, and
 *  an undo that is expensive is an undo nobody reaches for.
 *
 *  The toggle exists at all only when `canTick` — see that prop. The steps
 *  themselves always render, ticks included: what a project's quote is now
 *  does not unsay work that was done. */
export function TaskStepList({ task, onChange, canTick }: TaskStepListProps) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const steps = taskSteps(task);

  if (steps.length === 0) {
    return <p className="text-sm text-bambu-gray">{t('aito.noSteps')}</p>;
  }

  return (
    <ul className="space-y-0.5">
      {steps.map(({ service, cost, done }) => {
        const label = t(AITO_SERVICE_LABEL_KEYS[service]);
        const description = task[DESCRIPTION_FIELD[service]].trim();
        const row = (
          <>
            {/* The checkbox IS the affordance now. The old design put a "Done"
                pill at the end of the row, which named the action but gave it
                the smallest target in the panel. */}
            {canTick && (
              <span
                aria-hidden="true"
                className={`w-4 h-4 flex-shrink-0 rounded grid place-items-center border transition-colors duration-200 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                  done
                    ? 'bg-bambu-green border-bambu-green text-bambu-dark'
                    : 'border-bambu-dark-tertiary text-transparent group-hover/step:border-bambu-green'
                }`}
              >
                {done && <Check className="w-3 h-3 animate-tick-in" />}
              </span>
            )}
            <span
              data-testid={`step-swatch-${service}`}
              aria-hidden="true"
              className={`w-0.5 h-4 flex-shrink-0 rounded-full ${serviceDotCls(service)} transition-opacity duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'opacity-30' : ''
              }`}
            />
            <span
              className={`text-sm flex-1 min-w-0 truncate text-left transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'text-bambu-gray' : 'text-white'
              }`}
            >
              {label}
            </span>
            <Money
              currency={currency}
              value={cost}
              className={`text-sm flex-shrink-0 transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'text-bambu-gray' : 'text-white'
              }`}
            />
          </>
        );

        return (
          <li key={service}>
            {canTick ? (
              <button
                type="button"
                aria-pressed={done}
                onClick={() => onChange({ ...task, done: { ...task.done, [service]: !done } })}
                // hover uses bambu-dark-tertiary/40, NOT a white alpha: a white
                // overlay on a white card is invisible in light mode. Same
                // token the description's hover already uses in this panel.
                className={`group/step w-full flex items-center gap-3 rounded-md px-1.5 py-1 -mx-1.5 transition-colors motion-reduce:transition-none hover:bg-bambu-dark-tertiary/40 ${focusRingCls}`}
              >
                {row}
              </button>
            ) : (
              // No toggle at all before the quote is accepted — there is no
              // authorised work to tick, so an inert control would explain
              // nothing. The step and its price still render.
              <span className="w-full flex items-center gap-3 px-1.5 py-1 -mx-1.5">{row}</span>
            )}
            {description !== '' && (
              <p
                data-testid={`step-desc-${service}`}
                className="flex items-start gap-3 pr-1.5 pb-1 text-xs text-bambu-gray"
              >
                {/* Invisible spacers mirroring the row's own gutter — the
                    checkbox (only when canTick) then the swatch dot, each
                    separated by the same gap-3 the row itself uses — so the
                    text lines up under the step label in BOTH canTick
                    states. A single fixed pl-* can't do that: the checkbox
                    is conditionally rendered, so the gutter width differs by
                    state (42px vs 14px), not just a constant offset. */}
                {canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}
                <span aria-hidden="true" className="w-0.5 flex-shrink-0" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{description}</span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
