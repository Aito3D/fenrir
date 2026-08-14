import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { ImpressionFields } from './ImpressionFields';
import { Money } from '../calculator/shared';
import { inputCls, focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
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
  autoFocus,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  autoFocus?: boolean;
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
      autoFocus={autoFocus}
      className={inputCls}
    />
  );
}

/** Optional free text for one service — becomes the quote line's `Info:` row.
 *  Reuses the old task-level description key: the label text is identical. */
function StepDescriptionInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <textarea
      aria-label={`${label} ${t('aito.taskDescriptionPlaceholder')}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t('aito.taskDescriptionPlaceholder')}
      rows={2}
      className={`${inputCls} resize-none mt-3`}
    />
  );
}

/** One enabled service's block: its name, its cost, and whatever else that
 *  service needs. Only ever mounted for a service the chip row has switched
 *  on — a rendered block is always "present", so there is nothing left to
 *  dim here (compare the pre-chip version, which rendered all four blocks
 *  always and dimmed the absent ones). */
function StepBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-bambu-dark-tertiary p-3">
      <legend className="px-1 text-sm text-bambu-gray">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Two decimals, matching what money can express — without this, unit × qty
 *  arithmetic leaks float noise (0.1 × 3 = 0.30000000000000004) into a value
 *  that ends up on a quote. */
const round2 = (v: number) => Math.round(v * 100) / 100;

type ServiceId = 'scan' | 'modelisation' | 'impression' | 'usinage';

const SERVICE_DEFS: {
  id: ServiceId;
  labelKey: string;
  costKey: 'scanCost' | 'modelisationCost' | 'usinageCost' | 'impressionCost';
}[] = [
  { id: 'scan', labelKey: 'aito.serviceScan3D', costKey: 'scanCost' },
  { id: 'modelisation', labelKey: 'aito.serviceModelisation3D', costKey: 'modelisationCost' },
  { id: 'impression', labelKey: 'aito.serviceImpression3D', costKey: 'impressionCost' },
  { id: 'usinage', labelKey: 'aito.serviceUsinage', costKey: 'usinageCost' },
];

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

/** Edit mode for one task: identity, then a chip per service, then one block
 *  per ENABLED service.
 *
 *  A chip is pure UI over the null-vs-0 rule the rest of the stack already
 *  enforces (see TaskDraft's field docs): switching a chip on reveals an
 *  empty cost input — it must never invent a price — and switching it off
 *  reports that service's cost as `null` through `onChange`, the same value
 *  that disables it everywhere else (the board rules, the quote, the task
 *  total). A chip left on with an empty input is deliberately still
 *  "unpriced": `hasPricedService` and the board's rule engine both key off
 *  the cost being non-null, not off chip state.
 *
 *  Chips are seeded once, from the draft in hand, so a persisted or
 *  already-priced service opens enabled without the user having to
 *  rediscover it. They are NOT re-derived from `task` on every render —
 *  once open, a chip stays open even if its input is cleared back to empty,
 *  so the user isn't fighting the form to leave a service on but unpriced. */
export function TaskStepFields({ task, onChange, disabled = false }: TaskStepFieldsProps) {
  const { t } = useTranslation();
  const reactId = useId();
  const currency = useCurrency();

  const [enabled, setEnabled] = useState<Set<ServiceId>>(
    () => new Set(SERVICE_DEFS.filter((s) => task[s.costKey] !== null).map((s) => s.id)),
  );

  // Which service, if any, was just switched on by THIS render's click — so
  // its freshly-revealed cost input can claim focus without a separate
  // effect. Read and cleared once, synchronously, at the top of render
  // (below), which is what "cleared after use" means for a ref rather than
  // state: no extra render is spent clearing it.
  const justEnabledRef = useRef<ServiceId | null>(null);
  const autoFocusService = justEnabledRef.current;
  justEnabledRef.current = null;

  const toggleService = (svc: (typeof SERVICE_DEFS)[number]) => {
    // Computed from the `enabled` state variable (not an updater callback):
    // StrictMode double-invokes updaters during render, which would run
    // `onChange` and the ref write twice — and discard the first render's
    // effects, silently breaking chip auto-focus. Ordinary statements below
    // run exactly once, after React has committed to this render.
    const next = new Set(enabled);
    if (next.delete(svc.id)) {
      setEnabled(next);
      // Chip off = the service stops existing: null, never 0.
      onChange({ ...task, [svc.costKey]: null });
    } else {
      next.add(svc.id);
      setEnabled(next);
      justEnabledRef.current = svc.id;
    }
  };

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <input
        aria-label={t('aito.taskTitlePlaceholder')}
        value={task.title}
        onChange={(e) => onChange({ ...task, title: e.target.value })}
        placeholder={t('aito.taskTitlePlaceholder')}
        className={inputCls}
      />

      <div className="flex flex-wrap gap-2">
        {SERVICE_DEFS.map((svc) => {
          const on = enabled.has(svc.id);
          const label = t(svc.labelKey);
          return (
            <button
              key={svc.id}
              type="button"
              aria-pressed={on}
              aria-label={t(on ? 'aito.removeServiceChip' : 'aito.addService', { service: label })}
              onClick={() => toggleService(svc)}
              className={
                on
                  ? `inline-flex items-center gap-1.5 rounded-full border border-bambu-green/60 bg-bambu-green/10 px-3 py-1.5 text-xs font-semibold text-bambu-green-light transition-colors ${focusRingCls}`
                  : `inline-flex items-center gap-1.5 rounded-full border border-dashed border-bambu-dark-tertiary px-3 py-1.5 text-xs font-semibold text-bambu-gray transition-colors hover:border-bambu-green/50 hover:text-bambu-green-light ${focusRingCls}`
              }
            >
              {!on && <Plus className="w-3 h-3" />}
              {label}
            </button>
          );
        })}
      </div>

      {enabled.has('scan') && (
        <StepBlock title={t('aito.serviceScan3D')}>
          <CostInput
            id={`${reactId}-scan`}
            label={t('aito.serviceScan3D')}
            value={task.scanCost}
            onChange={(next) => onChange({ ...task, scanCost: next })}
            autoFocus={autoFocusService === 'scan'}
          />
          <StepDescriptionInput
            label={t('aito.serviceScan3D')}
            value={task.scanDescription}
            onChange={(next) => onChange({ ...task, scanDescription: next })}
          />
        </StepBlock>
      )}

      {enabled.has('modelisation') && (
        <StepBlock title={t('aito.serviceModelisation3D')}>
          <CostInput
            id={`${reactId}-modelisation`}
            label={t('aito.serviceModelisation3D')}
            value={task.modelisationCost}
            onChange={(next) => onChange({ ...task, modelisationCost: next })}
            autoFocus={autoFocusService === 'modelisation'}
          />
          <StepDescriptionInput
            label={t('aito.serviceModelisation3D')}
            value={task.modelisationDescription}
            onChange={(next) => onChange({ ...task, modelisationDescription: next })}
          />
        </StepBlock>
      )}

      {/* The cost input is still OWNED here rather than by ImpressionFields —
          the null-vs-0 rule (see CostInput) must not leak into a component
          that also reports computed prices — but it is handed over as a slot
          so ImpressionFields can seat quantity beside it, in every branch,
          including the unconfigured-install early returns where an imported
          cost still has to be readable and editable. */}
      {/* The printing cost is edited as a UNIT price — what one part costs,
          beside how many are made — while the STORED `impressionCost` stays
          the multiplied total the rest of the stack already speaks (the task
          total, the board rules, and the quote export, which divides by
          quantity to recover this same unit rate). Only this block converts,
          in both directions. */}
      {enabled.has('impression') && (
        <StepBlock title={t('aito.serviceImpression3D')}>
          <div className="space-y-3">
          <ImpressionFields
            value={task.impression}
            onChange={(next, computedCost) => {
              // Calculator repricing wins when it happened (`undefined` means
              // "it didn't", which is not the same as `null`) — otherwise a
              // quantity edit rescales the total so the unit price holds:
              // 500 apiece × 3 is 1500, not 500 spread ever thinner.
              let impressionCost = task.impressionCost;
              if (computedCost !== undefined) {
                impressionCost = computedCost;
              } else if (impressionCost !== null && next.quantity !== task.impression.quantity) {
                impressionCost = round2((impressionCost / Math.max(1, task.impression.quantity)) * next.quantity);
              }
              onChange({ ...task, impression: next, impressionCost });
            }}
            costField={
              // A fragment, not a cell: ImpressionFields wraps this pair in
              // its own subgrid row (see its `costField` doc). The unit price
              // is what is EDITED here; the stored `impressionCost` stays the
              // multiplied total the rest of the stack speaks.
              <>
                <label htmlFor={`${reactId}-impression`} className="text-sm text-bambu-gray text-right">
                  {t('aito.serviceUnitCost')}
                </label>
                <CostInput
                  id={`${reactId}-impression`}
                  label={t('aito.serviceImpression3D')}
                  value={
                    task.impressionCost === null
                      ? null
                      : round2(task.impressionCost / Math.max(1, task.impression.quantity))
                  }
                  onChange={(unit) =>
                    onChange({
                      ...task,
                      impressionCost: unit === null ? null : round2(unit * Math.max(1, task.impression.quantity)),
                    })
                  }
                  autoFocus={autoFocusService === 'impression'}
                />
              </>
            }
            discountField={
              <>
                <label htmlFor={`${reactId}-impression-discount`} className="text-sm text-bambu-gray text-right">
                  {t('aito.discount')}
                </label>
                <select
                  id={`${reactId}-impression-discount`}
                  value={task.impressionDiscountPct ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...task,
                      impressionDiscountPct: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                  className={inputCls}
                >
                  {/* An em dash, not "0%": no discount means no discount
                      column on the quote's PDF at all. */}
                  <option value="">—</option>
                  {[5, 10, 15, 20, 25, 30].map((pct) => (
                    <option key={pct} value={pct}>
                      {pct}%
                    </option>
                  ))}
                </select>
              </>
            }
          />
          {task.impressionCost !== null && (
            // What the quote's line will actually say: unit x quantity,
            // minus the discount. The unit input above shows the per-piece
            // figure, so without this line the multiplied reality lives
            // nowhere on screen.
            <div className="flex items-center justify-between border-t border-bambu-dark-tertiary pt-2">
              <span className="text-sm text-bambu-gray">{t('aito.printingTotal')}</span>
              <Money
                currency={currency}
                value={round2(task.impressionCost * (1 - (task.impressionDiscountPct ?? 0) / 100))}
                className="text-white font-medium"
              />
            </div>
          )}
          <StepDescriptionInput
            label={t('aito.serviceImpression3D')}
            value={task.impressionDescription}
            onChange={(next) => onChange({ ...task, impressionDescription: next })}
          />
          </div>
        </StepBlock>
      )}

      {enabled.has('usinage') && (
        <StepBlock title={t('aito.serviceUsinage')}>
          <CostInput
            id={`${reactId}-usinage`}
            label={t('aito.serviceUsinage')}
            value={task.usinageCost}
            onChange={(next) => onChange({ ...task, usinageCost: next })}
            autoFocus={autoFocusService === 'usinage'}
          />
          <StepDescriptionInput
            label={t('aito.serviceUsinage')}
            value={task.usinageDescription}
            onChange={(next) => onChange({ ...task, usinageDescription: next })}
          />
        </StepBlock>
      )}

      <div className="flex items-center justify-between border-t border-bambu-dark-tertiary pt-2">
        <span className="text-sm text-bambu-gray">{t('aito.taskTotal')}</span>
        <Money currency={currency} value={taskTotal(task)} className="text-white font-medium" />
      </div>
    </fieldset>
  );
}
