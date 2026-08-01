import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../../api/client';
import { AITO_SERVICE_LABEL_KEYS, taskSteps } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import type { TaskDraft } from '../../utils/taskDraft';

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
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';
  const steps = taskSteps(task);

  if (steps.length === 0) {
    return <p className="text-sm text-bambu-gray">{t('aito.noSteps')}</p>;
  }

  return (
    <ul className="space-y-1.5">
      {steps.map(({ service, cost, done }) => (
        <li key={service} className="flex items-center gap-3">
          {/* Ticking a step recedes its whole row — the label and the price go
              grey together with the button turning green. All three carry the
              same 300ms so the row settles as one gesture; on the old snap the
              button animated and the text it belongs to did not. */}
          <span
            className={`text-sm flex-1 min-w-0 truncate transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
              done ? 'text-bambu-gray' : 'text-white'
            }`}
          >
            {t(AITO_SERVICE_LABEL_KEYS[service])}
          </span>
          <Money
            currency={currency}
            value={cost}
            className={`text-sm flex-shrink-0 transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
              done ? 'text-bambu-gray' : 'text-white'
            }`}
          />
          {canTick && (
            <button
              type="button"
              aria-pressed={done}
              aria-label={done ? t('aito.markNotDone') : t('aito.markDone')}
              onClick={() => onChange({ ...task, done: { ...task.done, [service]: !done } })}
              className={`flex-shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors ${focusRingCls} ${
                done
                  ? 'border-bambu-green/40 bg-bambu-green/15 text-bambu-green'
                  : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white hover:border-bambu-green/40'
              }`}
            >
              {/* Deliberately faster than the 300ms the row's colours take:
                  the button is what the operator just pressed, so its own
                  feedback lands immediately and the consequences settle after
                  it. */}
              {done && <Check className="w-3 h-3 animate-tick-in" aria-hidden="true" />}
              {t('aito.done')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
