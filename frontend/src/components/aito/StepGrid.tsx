import { useTranslation } from 'react-i18next';
import { SERVICES } from '../../utils/aitoBoardRules';
import { AITO_SERVICE_LABEL_KEYS } from './services';
import type { AitoTaskSteps } from '../../api/client';

/** A project's tasks as one row of step pills each.
 *
 *  Four fixed columns, always in `SERVICES` order, so Scan is leftmost and
 *  Machining rightmost on every row of every card. A service the task does not
 *  carry leaves its cell empty rather than collapsing it: with the columns
 *  aligned, the SHAPE of a row says what the job involves before any label is
 *  read, and two rows can be compared at a glance. A `flex` row could not do
 *  that — the pills would slide left and each row would mean something
 *  different.
 *
 *  Replaces the card's old task count. A number nobody acts on became four
 *  pills that go green as the work lands, which is the thing an operator
 *  actually wants off a collapsed card.
 *
 *  No `aria-label` per pill, and deliberately: the progress bar underneath
 *  already reports "N of M steps done" to assistive technology, and labelling
 *  every pill would read out the same fact up to four times per task. The
 *  pills are the visual affordance for that same value.
 *
 *  Every element is a `<span>`, and it has to be: this renders inside the
 *  card's body `<button>` until that button becomes an overlay, and a
 *  `<button>` may not contain a `<div>`. `grid` and `flex` set `display`, so a
 *  span lays out exactly as a div would — the tag costs nothing here. */
export function StepGrid({ tasks }: { tasks: AitoTaskSteps[] }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return null;

  return (
    <span className="mt-2 block space-y-1">
      {tasks.map((task, index) => (
        // Index keys: `task_steps` carries no id, and the array is positional
        // — it is replaced wholesale on every refetch and optimistic write,
        // never spliced or reordered in place.
        <span key={index} data-testid="aito-step-row" className="grid grid-cols-4 gap-1">
          {SERVICES.map((service) => {
            if (!task.services.includes(service)) return <span key={service} />;
            const done = task.done.includes(service);
            const label = AITO_SERVICE_LABEL_KEYS[service]
              ? t(AITO_SERVICE_LABEL_KEYS[service])
              : service;
            return (
              <span
                key={service}
                data-service={service}
                data-done={done}
                // The full label in `title`: a quarter of a 300px column is
                // not enough for `Modélisation` at any locale, so the visible
                // text truncates and the tooltip carries the whole of it.
                title={label}
                className={`truncate rounded px-1.5 py-0.5 text-center text-[10px] leading-tight ${
                  done
                    ? 'bg-bambu-green/15 text-bambu-green ring-1 ring-inset ring-bambu-green/30'
                    : 'bg-bambu-dark-tertiary text-bambu-gray-light'
                }`}
              >
                {label}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}
