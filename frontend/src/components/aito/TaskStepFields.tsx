import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { ImpressionFields } from './ImpressionFields';
import { Money } from '../calculator/shared';
import { inputCls } from '../formStyles';
import { taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

/** One numeric cost input for a step. Empty means the step does not exist, not
 *  that it is free — clearing the field must emit `null`, never `0`; once that
 *  distinction is lost here nothing else in the stack recovers it. */
function CostInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <input
      id={id}
      aria-label={`${label} ${t('aito.serviceCost')}`}
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

/** One step's block: its name, its cost, and whatever else that step needs.
 *  Dimmed while the step does not exist — typing a cost is what creates it. */
function StepBlock({
  title,
  present,
  children,
}: {
  title: string;
  present: boolean;
  children: React.ReactNode;
}) {
  return (
    <fieldset
      className={`rounded-lg border border-bambu-dark-tertiary p-3 transition-opacity ${
        present ? '' : 'opacity-60'
      }`}
    >
      <legend className="px-1 text-sm text-bambu-gray">{title}</legend>
      {children}
    </fieldset>
  );
}

export interface TaskStepFieldsProps {
  task: TaskDraft;
  onChange: (next: TaskDraft) => void;
  /** True while this row's create POST is still in flight (see TaskRow's
   *  `pending` prop). Renders every input, textarea and select below inert
   *  via a wrapping `<fieldset disabled>` rather than threading a `disabled`
   *  prop through each one individually (CostInput, ImpressionFields,
   *  DurationInput, SearchableSelect): the native disabled-fieldset cascade
   *  reaches all of them, including the ones nested two components deep, and
   *  `@testing-library`'s own `isDisabled`/`toBeDisabled` walk the same
   *  ancestor chain, so this is exercised by `userEvent` and `toBeDisabled()`
   *  exactly as a real browser would. Optional, defaulting to false, so
   *  every existing caller is unaffected. */
  disabled?: boolean;
}

/** Edit mode for one task: identity, then one block per step.
 *
 *  All four blocks are always present here — this is the only surface where a
 *  step that does not exist is visible at all, and where one is created. Read
 *  mode (TaskStepList) shows only steps that exist. */
export function TaskStepFields({ task, onChange, disabled = false }: TaskStepFieldsProps) {
  const { t } = useTranslation();
  const reactId = useId();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  return (
    <fieldset disabled={disabled} className="space-y-3">
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <StepBlock title={t('aito.serviceScan3D')} present={task.scanCost !== null}>
          <CostInput
            id={`${reactId}-scan`}
            label={t('aito.serviceScan3D')}
            value={task.scanCost}
            onChange={(next) => onChange({ ...task, scanCost: next })}
          />
        </StepBlock>
        <StepBlock title={t('aito.serviceModelisation3D')} present={task.modelisationCost !== null}>
          <CostInput
            id={`${reactId}-modelisation`}
            label={t('aito.serviceModelisation3D')}
            value={task.modelisationCost}
            onChange={(next) => onChange({ ...task, modelisationCost: next })}
          />
        </StepBlock>
      </div>

      {/* Printing gets a full-width block: it is the one step whose cost has
          parameters under it. The cost input lives HERE rather than inside
          ImpressionFields because ImpressionFields returns early when the
          calculator has no printers or filaments configured — and an imported
          cost still has to be readable and editable on such an installation. */}
      <StepBlock title={t('aito.serviceImpression3D')} present={task.impressionCost !== null}>
        <div className="space-y-3">
          <CostInput
            id={`${reactId}-impression`}
            label={t('aito.serviceImpression3D')}
            value={task.impressionCost}
            onChange={(next) => onChange({ ...task, impressionCost: next })}
          />
          <ImpressionFields
            value={task.impression}
            onChange={(next, computedCost) =>
              onChange({
                ...task,
                impression: next,
                // Only when the calculator actually priced it — see
                // ImpressionFields' `onChange` doc. `undefined` means "leave
                // the stored cost alone", which is not the same as `null`.
                ...(computedCost !== undefined ? { impressionCost: computedCost } : {}),
              })
            }
          />
        </div>
      </StepBlock>

      <StepBlock title={t('aito.serviceUsinage')} present={task.usinageCost !== null}>
        <CostInput
          id={`${reactId}-usinage`}
          label={t('aito.serviceUsinage')}
          value={task.usinageCost}
          onChange={(next) => onChange({ ...task, usinageCost: next })}
        />
      </StepBlock>

      <div className="flex items-center justify-between border-t border-bambu-dark-tertiary pt-2">
        <span className="text-sm text-bambu-gray">{t('aito.taskTotal')}</span>
        <Money currency={currency} value={taskTotal(task)} className="text-white font-medium" />
      </div>
    </fieldset>
  );
}
