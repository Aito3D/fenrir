import { useTranslation } from 'react-i18next';
import { serviceDotCls } from './services';
import type { AitoTaskSteps } from '../../api/client';

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
