import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api } from '../../api/client';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ImpressionFields } from './ImpressionFields';
import { ServiceBadges } from './ServiceBadges';
import { enabledServices } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls, inputCls, labelCls } from '../formStyles';
import { taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

export interface TaskRowProps {
  task: TaskDraft;
  index: number;
  onChange: (next: TaskDraft) => void;
  onRemove: () => void;
  expanded: boolean;
  onToggle: () => void;
}

/** One numeric cost input for a flat-rate service. Empty means the service is
 *  disabled, not free — clearing the field must emit `null`, never `0`; once
 *  that distinction is lost here nothing else in the stack recovers it. */
function CostInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <input
      id={id}
      type="number"
      min={0}
      step="0.01"
      inputMode="decimal"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      placeholder={t('aito.serviceCost')}
      className={inputCls}
    />
  );
}

/** One task of a project: title/description, the four services (each
 *  optional — an empty service is a disabled one), the task total, and the
 *  hold-to-remove control. Purely presentational: every edit is reported
 *  upward through `onChange` with a new object, never applied in place, so
 *  the same row serves a local draft array (create modal) or a row wired to
 *  a PATCH (detail panel) without knowing which.
 *
 *  Collapsible, because a project with several tasks otherwise fills the
 *  surface. Collapsed, the row keeps its name, its service badges, its total
 *  and the remove control — enough to scan and prune a list without opening
 *  anything. `expanded` is owned by TaskEditor, which decides what a freshly
 *  added row starts as.
 *
 *  The body is unmounted rather than hidden when collapsed. That resets the
 *  `hasEdited` provenance gate inside ImpressionFields, which is the safe
 *  direction: the gate only ever *permits* a recomputed cost to be reported,
 *  so a fresh instance re-locks a frozen `impressionCost` until the user
 *  edits a print field again. */
export function TaskRow({ task, index, onChange, onRemove, expanded, onToggle }: TaskRowProps) {
  const { t } = useTranslation();
  const reactId = useId();
  // Same query key ImpressionFields and the calculator page use for the
  // configured currency, so this rides their cache instead of adding a fetch.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  const name = task.title.trim() || t('aito.taskFallbackName', { n: index + 1 });

  // ImpressionFields reports its recomputed total through a fresh callback
  // identity on every render (see its `onCostChange` prop), so the effect
  // that calls it re-fires whenever this row re-renders — not only when the
  // total itself changes. Left unguarded that loops: onChange -> new `task`
  // -> new callback identity -> effect fires again -> onChange -> ...
  // Bailing when the value hasn't actually moved breaks the cycle without
  // requiring the callback to be referentially stable.
  const handleImpressionCostChange = (total: number | null) => {
    if (total === task.impressionCost) return;
    onChange({ ...task, impressionCost: total });
  };

  return (
    <div className="group rounded-lg border border-bambu-dark-tertiary">
      <div className="flex items-center gap-2 p-3">
        {/* The heading IS the toggle, so the whole row is one target rather
            than a chevron-sized one. Delete stays a sibling — a <button> may
            not contain another button. */}
        <h4 className="flex-1 min-w-0">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`${reactId}-body`}
            className={`flex w-full items-center gap-2 text-left rounded-md ${focusRingCls}`}
          >
            <ChevronRight
              className={`w-4 h-4 flex-shrink-0 text-bambu-gray transition-transform duration-150 ${
                expanded ? 'rotate-90' : ''
              }`}
              aria-hidden="true"
            />
            <span className="text-sm font-medium text-white truncate min-w-0">{name}</span>
            {!expanded && (
              <>
                <ServiceBadges services={enabledServices(task)} className="flex-shrink-0" />
                <Money
                  currency={currency}
                  value={taskTotal(task)}
                  className="ml-auto flex-shrink-0 text-sm text-white"
                />
              </>
            )}
          </button>
        </h4>
        <DeleteHoldButton onDelete={onRemove} label={t('aito.removeTask')} hint={t('aito.holdToDelete')} />
      </div>

      {expanded && (
        <div id={`${reactId}-body`} className="px-3 pb-3 space-y-3">
          <input
            aria-label={t('aito.taskTitlePlaceholder')}
            value={task.title}
            onChange={(e) => onChange({ ...task, title: e.target.value })}
            placeholder={t('aito.taskTitlePlaceholder')}
            className={inputCls}
          />
          <textarea
            aria-label={t('aito.taskDescriptionPlaceholder')}
            value={task.description}
            onChange={(e) => onChange({ ...task, description: e.target.value })}
            placeholder={t('aito.taskDescriptionPlaceholder')}
            rows={2}
            className={`${inputCls} resize-none`}
          />

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor={`${reactId}-scan`} className={labelCls}>
                {t('aito.serviceScan3D')}
              </label>
              <CostInput
                id={`${reactId}-scan`}
                value={task.scanCost}
                onChange={(next) => onChange({ ...task, scanCost: next })}
              />
            </div>
            <div>
              <label htmlFor={`${reactId}-modelisation`} className={labelCls}>
                {t('aito.serviceModelisation3D')}
              </label>
              <CostInput
                id={`${reactId}-modelisation`}
                value={task.modelisationCost}
                onChange={(next) => onChange({ ...task, modelisationCost: next })}
              />
            </div>
            <div>
              <label htmlFor={`${reactId}-usinage`} className={labelCls}>
                {t('aito.serviceUsinage')}
              </label>
              <CostInput
                id={`${reactId}-usinage`}
                value={task.usinageCost}
                onChange={(next) => onChange({ ...task, usinageCost: next })}
              />
            </div>
          </div>

          <div>
            <p className={labelCls}>{t('aito.serviceImpression3D')}</p>
            <ImpressionFields
              value={task.impression}
              onChange={(next) => onChange({ ...task, impression: next })}
              onCostChange={handleImpressionCostChange}
            />
          </div>

          <div className="flex items-center justify-between border-t border-bambu-dark-tertiary pt-2">
            <span className="text-sm text-bambu-gray">{t('aito.taskTotal')}</span>
            <Money currency={currency} value={taskTotal(task)} className="text-white font-medium" />
          </div>
        </div>
      )}
    </div>
  );
}
