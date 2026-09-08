import { useTranslation } from 'react-i18next';
import { serviceDotCls } from './services';
import type { AitoTaskSteps } from '../../api/client';

/** The collapsed card's one-line progress: every task's steps laid end to end
 *  as a single segmented bar, and the done/total count beside it.
 *
 *  This is what a card shows by default; `TaskMiniRows` below — one row per
 *  task — is what it grows into on hover. A column of 14 cards each listing
 *  three tasks showed six cards per screen; one line per card shows the
 *  whole column, and "3/5" with a bar is the fact you scan a column for.
 *  The per-task NAMES are the thing a row adds, and a name is something you
 *  read on one card, deliberately, not down a column.
 *
 *  The bar keeps the stage colours rather than filling green: a card that is
 *  two-thirds violet says "the modelling is done, the print isn't" without
 *  being opened, and the rows it expands into use the same colours, so the
 *  reveal reads as the bar splitting apart rather than as a different chart.
 *
 *  `done`/`total` come from the caller, not from the tasks: a server older
 *  than this bundle sends `steps_total`/`steps_done` but no `task_steps`,
 *  and the count must still render (without a bar) in that case. */
export function TaskStepsSummary({ tasks, done, total }: { tasks: AitoTaskSteps[]; done: number; total: number }) {
  const { t } = useTranslation();
  if (total <= 0) return null;
  const label = t('aito.stepsCount', { done, total });

  return (
    <span data-testid="aito-steps-summary" role="img" aria-label={label} className="mt-2 flex items-center gap-2">
      {tasks.length > 0 && (
        <span aria-hidden="true" className="flex flex-1 gap-[2px]">
          {tasks.flatMap((task, taskIndex) =>
            task.services.map((service) => (
              <span
                key={`${taskIndex}-${service}`}
                data-testid="aito-summary-segment"
                className={`flex-1 h-[.28rem] rounded-full transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                  task.done.includes(service) ? serviceDotCls(service) : 'bg-bambu-dark-tertiary'
                }`}
              />
            )),
          )}
        </span>
      )}
      <span aria-hidden="true" className="flex-shrink-0 text-xs text-bambu-gray tabular-nums">
        {label}
      </span>
    </span>
  );
}

/** One row per task on the board card: title, stage-coloured micro-segments,
 *  done/total. Replaces StepGrid's anonymous pill grid — a pill row could say
 *  how much was left but never WHICH task it belonged to.
 *
 *  The row is `role="img"` with the title and count in its accessible name,
 *  the same name-from-author rule the old pill grid used; the segments are
 *  decoration and stay hidden. An untitled task renders through
 *  aito.taskFallbackName, the panel's own rule, so the two surfaces name
 *  tasks identically. */
export function TaskMiniRows({ tasks }: { tasks: AitoTaskSteps[] }) {
  const { t } = useTranslation();
  if (tasks.length === 0) return null;

  return (
    <span data-testid="aito-task-rows" className="mt-2 block space-y-1.5">
      {tasks.map((task, index) => {
        // Index keys: task_steps is positional and replaced wholesale on
        // every refetch, never spliced — same reasoning the old pill grid used.
        const name = task.title?.trim() || t('aito.taskFallbackName', { n: index + 1 });
        return (
          <span
            key={index}
            data-testid="aito-task-row"
            role="img"
            aria-label={`${name} — ${t('aito.stepsCount', { done: task.done.length, total: task.services.length })}`}
            className="flex items-center gap-2"
          >
            <span className="flex-1 min-w-0 truncate text-xs text-bambu-gray-light">{name}</span>
            <span aria-hidden="true" className="flex gap-[2px] w-[4.2rem] flex-shrink-0">
              {task.services.map((service) => (
                <span
                  key={service}
                  data-testid="aito-task-segment"
                  className={`flex-1 h-[.28rem] rounded-full transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                    task.done.includes(service) ? serviceDotCls(service) : 'bg-bambu-dark-tertiary'
                  }`}
                />
              ))}
            </span>
            <span className="w-7 flex-shrink-0 text-right text-xs text-bambu-gray tabular-nums">
              {task.done.length}/{task.services.length}
            </span>
          </span>
        );
      })}
    </span>
  );
}
