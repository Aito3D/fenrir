import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { AiTextField } from './AiTextField';
import { ImpressionFields } from './ImpressionFields';
import { rowLabelCls, DiscountSelect, QuantityInput, ServicePriceFooter } from './servicePriceFields';
import { Money } from '../calculator/shared';
import { inputCls, focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { taskTotal } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';
import { netCost } from '../../utils/aitoBoardRules';

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
 *  Reuses the old task-level description key: the label text is identical.
 *
 *  An `AiTextField`, like the title: this text is printed on the quote the
 *  client reads, so it spell-checks itself when the user leaves it. */
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
    <AiTextField
      multiline
      label={`${label} ${t('aito.taskDescriptionPlaceholder')}`}
      placeholder={t('aito.taskDescriptionPlaceholder')}
      value={value}
      onChange={onChange}
      className="mt-3"
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

interface ServiceDef {
  id: ServiceId;
  labelKey: string;
  costKey: 'scanCost' | 'modelisationCost' | 'usinageCost' | 'impressionCost';
  /** Every service also owns a free-text description field. Impression's is
   *  the one behind the note reveal; the rest are always visible. */
  descKey: 'scanDescription' | 'modelisationDescription' | 'usinageDescription' | 'impressionDescription';
  /** The plain services own a quantity and a discount beside their cost.
   *  Impression's live elsewhere — its quantity is a calculator input inside
   *  `impression`, and its discount is read directly — so it declares
   *  neither and never goes through `renderPlainService`. */
  qtyKey?: 'scanQuantity' | 'modelisationQuantity' | 'usinageQuantity';
  discountKey?: 'scanDiscountPct' | 'modelisationDiscountPct' | 'usinageDiscountPct';
}

/** Chip order, and the draft fields each service owns. */
const SERVICE_DEFS: ServiceDef[] = [
  {
    id: 'scan',
    labelKey: 'aito.serviceScan3D',
    costKey: 'scanCost',
    descKey: 'scanDescription',
    qtyKey: 'scanQuantity',
    discountKey: 'scanDiscountPct',
  },
  {
    id: 'modelisation',
    labelKey: 'aito.serviceModelisation3D',
    costKey: 'modelisationCost',
    descKey: 'modelisationDescription',
    qtyKey: 'modelisationQuantity',
    discountKey: 'modelisationDiscountPct',
  },
  { id: 'impression', labelKey: 'aito.serviceImpression3D', costKey: 'impressionCost', descKey: 'impressionDescription' },
  {
    id: 'usinage',
    labelKey: 'aito.serviceUsinage',
    costKey: 'usinageCost',
    descKey: 'usinageDescription',
    qtyKey: 'usinageQuantity',
    discountKey: 'usinageDiscountPct',
  },
];

const SERVICE_BY_ID = Object.fromEntries(SERVICE_DEFS.map((s) => [s.id, s])) as Record<ServiceId, ServiceDef>;

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

  // Impression only: this block is the dense one, and its note is empty on
  // most tasks. Scan, Modélisation and Usinage keep their always-visible
  // textarea. Seeded open — never hide a description the task already has.
  const [noteOpen, setNoteOpen] = useState(task.impressionDescription !== '');

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

  /** Scan, Modélisation and Usinage: a unit price, how many units, an optional
   *  discount, the resulting line total, and a description — over the draft
   *  fields named in SERVICE_DEFS. Impression is not one of these: it is
   *  spelled out below, because none of what it adds (print parameters, the
   *  calculator's computed price, the note reveal) generalises.
   *
   *  The input is the UNIT price; the draft stores unit x quantity, which is
   *  what every reader downstream (netCost, the quote line, the board total)
   *  already speaks. Editing the quantity rescales the stored cost so the unit
   *  price holds — 500 apiece x 3 is 1500, not 500 spread ever thinner —
   *  exactly as the impression block does it. */
  const renderPlainService = (svc: ServiceDef) => {
    const label = t(svc.labelKey);
    const qtyKey = svc.qtyKey as NonNullable<ServiceDef['qtyKey']>;
    const discountKey = svc.discountKey as NonNullable<ServiceDef['discountKey']>;
    const stored = task[svc.costKey];
    const quantity = Math.max(1, task[qtyKey]);
    const pct = task[discountKey];
    const unitCost = stored === null ? null : round2(stored / quantity);
    // Through `netCost`, never by re-spelling `cost * (1 - pct / 100)` here:
    // that rule has ONE definition (utils/aitoBoardRules.ts, mirrored in
    // backend/app/services/aito_board_rules.py and pinned by the shared
    // contract fixture), and a fifth copy of it is how the block and the card
    // start disagreeing about what a task costs.
    const net = netCost(task, svc.id);
    const lineTotal = net === null ? null : round2(net);
    const unitRate = lineTotal === null ? null : round2(lineTotal / quantity);
    return (
      <StepBlock title={label}>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
          <label htmlFor={`${reactId}-${svc.id}`} className={rowLabelCls}>
            {t('aito.serviceUnitCost')}
          </label>
          <CostInput
            id={`${reactId}-${svc.id}`}
            label={label}
            value={unitCost}
            onChange={(unit) =>
              onChange({ ...task, [svc.costKey]: unit === null ? null : round2(unit * quantity) })
            }
            autoFocus={autoFocusService === svc.id}
          />

          <label htmlFor={`${reactId}-${svc.id}-quantity`} className={rowLabelCls}>
            {t('aito.quantity')}
          </label>
          <QuantityInput
            id={`${reactId}-${svc.id}-quantity`}
            value={task[qtyKey]}
            // Qualifies the ACCESSIBLE name only ("Usinage Quantity") — the
            // visible label above stays the bare "Quantity" text. Two
            // services priced at once is the common case (chips seed open
            // from every non-null cost), and a bare "Quantity" name would be
            // ambiguous between them; see QuantityInput's doc.
            ariaLabel={`${label} ${t('aito.quantity')}`}
            onChange={(next) =>
              onChange({
                ...task,
                [qtyKey]: next,
                // Rescale so the UNIT price holds. `stored` is null when the
                // service is unpriced, and there is nothing to rescale then.
                [svc.costKey]: stored === null ? null : round2((stored / quantity) * next),
              })
            }
          />

          <label htmlFor={`${reactId}-${svc.id}-discount`} className={rowLabelCls}>
            {t('aito.discount')}
          </label>
          <DiscountSelect
            id={`${reactId}-${svc.id}-discount`}
            value={pct}
            ariaLabel={`${label} ${t('aito.discount')}`}
            onChange={(next) => onChange({ ...task, [discountKey]: next })}
          />
        </div>
        <ServicePriceFooter
          lineTotal={lineTotal}
          unitRate={unitRate}
          currency={currency}
          testId={`service-footer-${svc.id}`}
        />
        <StepDescriptionInput
          label={label}
          value={task[svc.descKey]}
          onChange={(next) => onChange({ ...task, [svc.descKey]: next })}
        />
      </StepBlock>
    );
  };

  // The printing cost is EDITED as a unit price — what one part costs, beside
  // how many are made — while the STORED `impressionCost` stays the multiplied
  // total the rest of the stack already speaks (the task total, the board
  // rules, and the quote export, which divides by quantity to recover this
  // same unit rate). These three are the only place that conversion is
  // written; the block below reads them.
  const quantity = Math.max(1, task.impression.quantity);
  const unitCost = task.impressionCost === null ? null : round2(task.impressionCost / quantity);
  // Through `netCost`, never by re-spelling `cost * (1 - pct / 100)` here —
  // same reasoning as `renderPlainService` above, which is exactly how this
  // block and the card started disagreeing about what impression costs.
  const impressionNet = netCost(task, 'impression');
  const lineTotal = impressionNet === null ? null : round2(impressionNet);
  // The per-piece rate the line actually charges, for the band to state
  // beside the total. Derived from `lineTotal` rather than re-applying the
  // percentage to `unitCost`, so the two figures can never round apart.
  const unitRate = lineTotal === null ? null : round2(lineTotal / quantity);

  return (
    <fieldset disabled={disabled} className="space-y-3">
      {/* The title becomes the quote line's name, so it is spell-checked on
          blur like every description below it — see AiTextField. */}
      <AiTextField
        label={t('aito.taskTitlePlaceholder')}
        placeholder={t('aito.taskTitlePlaceholder')}
        value={task.title}
        onChange={(next) => onChange({ ...task, title: next })}
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

      {enabled.has('scan') && renderPlainService(SERVICE_BY_ID.scan)}

      {enabled.has('modelisation') && renderPlainService(SERVICE_BY_ID.modelisation)}

      {/* The cost input is still OWNED here rather than by ImpressionFields —
          the null-vs-0 rule (see CostInput) must not leak into a component
          that also reports computed prices — but it is handed over as a slot
          so ImpressionFields can seat quantity beside it, in every branch,
          including the unconfigured-install early returns where an imported
          cost still has to be readable and editable. */}
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
                impressionCost = round2((impressionCost / quantity) * next.quantity);
              }
              onChange({ ...task, impression: next, impressionCost });
            }}
            costField={
              // A fragment, not a cell: ImpressionFields wraps this pair in
              // its own subgrid row (see its `costField` doc).
              <>
                <label htmlFor={`${reactId}-impression`} className={rowLabelCls}>
                  {t('aito.serviceUnitCost')}
                </label>
                <CostInput
                  id={`${reactId}-impression`}
                  label={t('aito.serviceImpression3D')}
                  value={unitCost}
                  onChange={(unit) =>
                    onChange({ ...task, impressionCost: unit === null ? null : round2(unit * quantity) })
                  }
                  autoFocus={autoFocusService === 'impression'}
                />
              </>
            }
            lineTotal={lineTotal}
            unitRate={unitRate}
            unitCost={unitCost}
            discountField={
              <>
                <label htmlFor={`${reactId}-impression-discount`} className={rowLabelCls}>
                  {t('aito.discount')}
                </label>
                <DiscountSelect
                  id={`${reactId}-impression-discount`}
                  value={task.impressionDiscountPct}
                  ariaLabel={`${t('aito.serviceImpression3D')} ${t('aito.discount')}`}
                  onChange={(impressionDiscountPct) => onChange({ ...task, impressionDiscountPct })}
                />
              </>
            }
            noteField={
              <>
                {/* Short row label (`aito.note`), distinct from the button's
                    full-phrase text (`aito.addNote`): the two used to share
                    one key, which not only rendered "Note for the quote
                    [+ Note for the quote]" but made that full phrase — not
                    Unit cost/Quantity/Discount/Computed — size the shared
                    price-column label track in every locale. */}
                <span className={rowLabelCls}>{t('aito.note')}</span>
                {noteOpen ? (
                  <span className="text-sm text-bambu-gray">—</span>
                ) : (
                  <button
                    type="button"
                    aria-label={t('aito.addNote')}
                    onClick={() => setNoteOpen(true)}
                    className={`justify-self-start rounded-lg border border-dashed border-bambu-dark-tertiary px-2 py-1 text-xs text-bambu-gray transition-colors hover:border-bambu-green/50 hover:text-bambu-green-light ${focusRingCls}`}
                  >
                    + {t('aito.addNote')}
                  </button>
                )}
              </>
            }
          />
          {noteOpen && (
            <StepDescriptionInput
              label={t('aito.serviceImpression3D')}
              value={task.impressionDescription}
              onChange={(next) => onChange({ ...task, impressionDescription: next })}
            />
          )}
          </div>
        </StepBlock>
      )}

      {enabled.has('usinage') && renderPlainService(SERVICE_BY_ID.usinage)}

      <div className="flex items-center justify-between border-t border-bambu-dark-tertiary pt-2">
        <span className="text-sm text-bambu-gray">{t('aito.taskTotal')}</span>
        <Money currency={currency} value={taskTotal(task)} className="text-white font-medium" />
      </div>
    </fieldset>
  );
}
