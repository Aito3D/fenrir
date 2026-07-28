import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ImpressionFields } from './ImpressionFields';
import { Money } from '../calculator/shared';
import { inputCls, labelCls } from '../formStyles';
import { taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

export interface TaskRowProps {
  task: TaskDraft;
  index: number;
  onChange: (next: TaskDraft) => void;
  onRemove: () => void;
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
 *  a PATCH (detail panel) without knowing which. */
export function TaskRow({ task, index, onChange, onRemove }: TaskRowProps) {
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
    <div className="group rounded-lg border border-bambu-dark-tertiary p-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium text-white truncate min-w-0">{name}</h4>
        <DeleteHoldButton onDelete={onRemove} label={t('aito.removeTask')} hint={t('aito.holdToDelete')} />
      </div>

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
  );
}
