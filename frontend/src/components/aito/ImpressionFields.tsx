import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { SearchableSelect } from '../SearchableSelect';
import { DurationInput } from './DurationInput';
import { inputCls } from '../formStyles';
import { computeImpressionCost, roundUpTo50 } from '../../utils/taskDraft';
import type { ImpressionDraft } from '../../utils/taskDraft';

/** Inline label for a grid row. Not `labelCls`: that one is `block` with a
 *  bottom margin, for a label STACKED above its field. Here the label sits
 *  beside its field, in the grid's own label column — which is what buys the
 *  block ~24px per field. */
const rowLabelCls = 'text-sm text-bambu-gray text-right';

/** One `label | control` pair in the block's shared grid.
 *
 *  `side` decides which column pair it lands in, and `row` is the 1-based
 *  row a PRICE pair occupies while the block is wide (see the `--ip-row`
 *  comment in index.css). Part pairs are auto-placed in DOM order and ignore
 *  `row`. */
function GridRow({
  side,
  row,
  htmlFor,
  label,
  children,
}: {
  side: 'part' | 'price';
  row?: number;
  htmlFor?: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={side === 'part' ? 'impression-part-row' : 'impression-price-row'}
      style={row === undefined ? undefined : ({ '--ip-row': row } as React.CSSProperties)}
    >
      {/* A `<label>` only when it labels a control. A row whose content is a
          readout (the computed price) gets a `<span>`: a label pointing at
          nothing is a dangling label, which is worse than no label. */}
      {htmlFor === undefined ? (
        <span className={rowLabelCls}>{label}</span>
      ) : (
        <label htmlFor={htmlFor} className={rowLabelCls}>
          {label}
        </label>
      )}
      {children}
    </div>
  );
}

export interface ImpressionFieldsProps {
  value: ImpressionDraft;
  /** Reports the edited draft, plus the recomputed price when — and only
   *  when — the calculator could produce one.
   *
   *  Both travel in ONE call on purpose. Two sequential calls would each be
   *  built from the same stale `task` snapshot in the parent's closures, and
   *  the second would silently discard the first.
   *
   *  `computedCost` is left `undefined` when the reference data has not
   *  resolved or the parameter set is incomplete — an imported task looks
   *  exactly like that (a cost from the quote, no printer, no filament).
   *  Reporting a `null` there would not blank the cost, it would DISABLE the
   *  service. Clearing a cost is the Cost input's job. */
  onChange: (next: ImpressionDraft, computedCost?: number) => void;
  /** The Impression3D cost control, owned by TaskStepFields (it owns the
   *  null-vs-0 rule) but seated HERE, as a row of this block's grid.
   *
   *  A slot is a FRAGMENT of exactly two nodes — its `<label>` then its
   *  control — not a wrapped cell. This component wraps them in the subgrid
   *  row itself, which is what lets it own row placement (see `GridRow`)
   *  without the parent having to know the grid at all. Do not wrap the pair
   *  in a `<div>` on the parent's side: that would put one element where the
   *  subgrid expects two, and the label would swallow the field's column. */
  costField: React.ReactNode;
  /** Same fragment contract as `costField`. Owned by TaskStepFields because
   *  the discount lives on the TASK beside `impressionCost` — it modifies the
   *  price, not the print parameters this component edits. */
  discountField: React.ReactNode;
}

/** filament/printer + weight/time/color/quantity for one task's Impression3D
 *  service, plus the live cost breakdown. All arithmetic lives in
 *  `computeImpressionCost` (taskDraft.ts) — this component only collects
 *  inputs and renders the result, the same split the calculator page keeps
 *  between `pricing.ts` and its cards. */
export function ImpressionFields({ value, onChange, costField, discountField }: ImpressionFieldsProps) {
  const { t } = useTranslation();
  const reactId = useId();

  const filamentsQuery = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    staleTime: 60_000,
  });
  const printersQuery = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    staleTime: 60_000,
  });
  const defaultsQuery = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    staleTime: 60_000,
  });
  const filaments = filamentsQuery.data ?? [];
  const printers = printersQuery.data ?? [];
  const defaults = defaultsQuery.data;
  const referenceDataLoading = filamentsQuery.isLoading || printersQuery.isLoading || defaultsQuery.isLoading;

  // Pricing is a side effect on the parent, so it happens here — at the moment
  // a print input actually changes — rather than in an effect. An effect
  // re-fires on every render (the parent hands us a fresh callback identity
  // each time), which is what used to require both a `hasEdited` provenance
  // flag here and an equality guard in the parent, and which still stomped a
  // hand-typed cost on the next render.
  //
  // `next` is priced, not `value`: state has not advanced yet at this point.
  const handleChange = (next: ImpressionDraft) => {
    if (!defaults || referenceDataLoading) {
      onChange(next);
      return;
    }
    const nextFilament = filaments.find((f) => f.id === next.filamentId) ?? null;
    const nextPrinter = printers.find((p) => p.id === next.printerId) ?? null;
    // The calculator prices ONE PIECE, rounded up to the shop's 50-multiple
    // tiers (123 -> 150), and the stored cost stays that unit price times
    // quantity. Rounding before multiplying is deliberate: the charged total
    // is an exact multiple of the advertised per-piece price, not a rounded
    // lump the customer can't decompose.
    const priced = computeImpressionCost(next, nextFilament, nextPrinter, defaults);
    onChange(
      next,
      priced ? roundUpTo50(priced.total_ttc) * Math.max(1, Math.floor(next.quantity || 1)) : undefined,
    );
  };

  const notConfigured = printers.length === 0 || filaments.length === 0;

  return (
    <div className="impression-block">
      <div className="impression-grid" data-testid="impression-grid">
        <GridRow side="part" htmlFor={`${reactId}-material`} label={t('aito.material')}>
          <SearchableSelect
            id={`${reactId}-material`}
            value={value.filamentId === null ? '' : String(value.filamentId)}
            onChange={(v) => handleChange({ ...value, filamentId: v === '' ? null : Number(v) })}
            options={filaments.map((f) => ({ value: String(f.id), label: f.name }))}
            allowCustom={false}
          />
        </GridRow>

        <GridRow side="part" htmlFor={`${reactId}-color`} label={t('aito.color')}>
          <input
            id={`${reactId}-color`}
            type="text"
            value={value.color}
            onChange={(e) => handleChange({ ...value, color: e.target.value })}
            className={inputCls}
          />
        </GridRow>

        <GridRow side="part" htmlFor={`${reactId}-printer`} label={t('aito.printer')}>
          <SearchableSelect
            id={`${reactId}-printer`}
            value={value.printerId === null ? '' : String(value.printerId)}
            onChange={(v) => handleChange({ ...value, printerId: v === '' ? null : Number(v) })}
            options={printers.map((p) => ({ value: String(p.id), label: p.name }))}
            allowCustom={false}
          />
        </GridRow>

        <GridRow side="part" htmlFor={`${reactId}-weight`} label={t('aito.weightG')}>
          <input
            id={`${reactId}-weight`}
            type="number"
            min={0}
            inputMode="decimal"
            value={value.weightG ?? ''}
            onChange={(e) =>
              handleChange({
                ...value,
                weightG: e.target.value === '' ? null : Math.max(0, Number(e.target.value)),
              })
            }
            className={inputCls}
          />
        </GridRow>

        {/* The label's `id` names the segment group and its `htmlFor` points
            at the days input, so a query by this label's text matches both —
            target a segment by its own aria-label instead. `max-w-60` stops
            the three segments stretching across a column they do not need. */}
        <div className="impression-part-row">
          <label id={`${reactId}-time-label`} htmlFor={`${reactId}-time`} className={rowLabelCls}>
            {t('aito.printTime')}
          </label>
          <div className="max-w-60">
            <DurationInput
              id={`${reactId}-time`}
              labelId={`${reactId}-time-label`}
              minutes={value.timeMin}
              onChange={(timeMin) => handleChange({ ...value, timeMin })}
            />
          </div>
        </div>

        {/* Price column. Row 1 and 3 are slots; quantity is ours because the
            draft owns it. */}
        <div className="impression-price-row" style={{ '--ip-row': 1 } as React.CSSProperties}>
          {costField}
        </div>

        <GridRow side="price" row={2} htmlFor={`${reactId}-quantity`} label={t('aito.quantity')}>
          <input
            id={`${reactId}-quantity`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={value.quantity}
            onChange={(e) =>
              handleChange({
                ...value,
                quantity: e.target.value === '' ? 1 : Math.max(1, Math.floor(Number(e.target.value) || 1)),
              })
            }
            className={inputCls}
          />
        </GridRow>

        <div className="impression-price-row" style={{ '--ip-row': 3 } as React.CSSProperties}>
          {discountField}
        </div>

        {/* The band's only content in this task is the unconfigured-install
            message, which used to hang off the calculator toggle. Task 3
            fills it. */}
        <div className="impression-band">
          {notConfigured && (
            <p className="text-sm text-bambu-gray">
              {t(printers.length === 0 ? 'aito.noPrintersConfigured' : 'aito.noFilamentsConfigured')}{' '}
              <Link to="/calculator" className="text-bambu-green hover:underline">
                {t('calculator.title')}
              </Link>
            </p>
          )}
        </div>

        <div className="impression-rule" aria-hidden="true" />
      </div>
    </div>
  );
}
