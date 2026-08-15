import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { SearchableSelect } from '../SearchableSelect';
import { DurationInput } from './DurationInput';
import { ImpressionCostBand } from './ImpressionCostBand';
import { Money } from '../calculator/shared';
import { inputCls, focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { computeImpressionCost, roundUpTo50 } from '../../utils/taskDraft';
import type { ImpressionDraft } from '../../utils/taskDraft';

/** Inline label for a grid row. Not `labelCls`: that one is `block` with a
 *  bottom margin, for a label STACKED above its field. Here the label sits
 *  beside its field, in the grid's own label column — which is what buys the
 *  block ~24px per field. Exported: TaskStepFields' slot fragments (costField,
 *  discountField, noteField) render their own `<label>`/`<span>` for the same
 *  grid, and must match this class rather than re-typing the literal. */
export const rowLabelCls = 'text-sm text-bambu-gray text-right';

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
  /** The note affordance, same fragment contract as `costField`: a `<label>`
   *  and the button that reveals the textarea. It takes the price column's
   *  fourth row, which is what keeps both columns at five rows and leaves no
   *  half-empty one. The revealed textarea is NOT here — TaskStepFields
   *  renders it after this component, i.e. below the band, where a two-row
   *  field has the width it needs. */
  noteField: React.ReactNode;
  /** The figure the quote line will carry — unit × quantity, less the
   *  discount — computed by TaskStepFields, which owns `impressionCost` and
   *  the discount. `null` renders no amount: an absent cost is not a zero
   *  cost (see CostInput). The standalone "Printing total" row TaskStepFields
   *  used to render below this component is GONE — the band replaced it, and
   *  the total must not appear twice. */
  lineTotal: number | null;
  /** What one part costs once the discount is taken off, or `null` when no
   *  discount is set — computed by TaskStepFields for the same reason
   *  `lineTotal` is. Passed straight to the band, which renders it. */
  discountedUnit: number | null;
  /** The unit price currently stored on the task (`impressionCost` divided by
   *  quantity), so this block can tell whether the calculator's figure and
   *  the stored one have parted ways. Read only for that comparison. */
  unitCost: number | null;
}

/** filament/printer + weight/time/color/quantity for one task's Impression3D
 *  service, plus the live cost breakdown. All arithmetic lives in
 *  `computeImpressionCost` (taskDraft.ts) — this component only collects
 *  inputs and renders the result, the same split the calculator page keeps
 *  between `pricing.ts` and its cards. */
export function ImpressionFields({
  value,
  onChange,
  costField,
  discountField,
  noteField,
  lineTotal,
  discountedUnit,
  unitCost,
}: ImpressionFieldsProps) {
  const { t } = useTranslation();
  const reactId = useId();
  const currency = useCurrency();

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

  const filament = filaments.find((f) => f.id === value.filamentId) ?? null;
  const printer = printers.find((p) => p.id === value.printerId) ?? null;

  // CalculatorFilament/CalculatorPrinter are supersets of PricingFilament/
  // PricingPrinter, so they pass straight through — no mapping layer.
  const result = useMemo(
    () => (defaults ? computeImpressionCost(value, filament, printer, defaults) : null),
    [value, filament, printer, defaults],
  );

  // The commercial per-piece figure the calculator would charge: rounded UP
  // to the shop's 50-multiple tier, exactly as `handleChange` stores it.
  // Comparing against the raw total instead would offer to "apply" a price
  // equal to what is already stored.
  const computedUnit = result ? roundUpTo50(result.total_ttc) : null;
  // Divergence IS the provenance signal. After any calculator edit the two
  // agree (handleChange just wrote it), so the button appears only once a
  // cost has been typed by hand — which is the one case the old UI dropped
  // the computed alternative on the floor. This is why the `hasEdited` flag
  // that used to live here is not coming back.
  const canApplyComputed = computedUnit !== null && unitCost !== computedUnit;

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

  // Gated on `referenceDataLoading`: printers/filaments both start as `[]`
  // before their query resolves, which is indistinguishable from a genuinely
  // empty calculator unless the loading flag is checked too. Without this
  // gate every printing task asserts "No printers configured" — a false
  // statement plus a `/calculator` navigation trap — for the entire cold-cache
  // fetch window. While loading, the band falls through to its no-split
  // branch instead: it draws whatever it does have (the line total) and
  // nothing where the split would go, which is also the settled state for a
  // task that simply has no printer selected.
  const notConfigured =
    referenceDataLoading || (printers.length > 0 && filaments.length > 0)
      ? null
      : printers.length === 0
        ? 'printers'
        : 'filaments';

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
          {/* Fixed-width (`w-20`), not flex-1: a count is 1-3 digits — the
              unit cost (`costField`, above) is the field that earns the rest
              of the line. Without a cap, bare `inputCls` (`w-full`) stretches
              this across the whole ~230px field column for three digits'
              worth of content. Same reasoning covers the discount select in
              TaskStepFields (`w-24`, wide enough for "30%"). */}
          <div className="max-w-20">
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
          </div>
        </GridRow>

        <div className="impression-price-row" style={{ '--ip-row': 3 } as React.CSSProperties}>
          {discountField}
        </div>

        <div className="impression-price-row" style={{ '--ip-row': 4 } as React.CSSProperties}>
          {noteField}
        </div>

        <GridRow side="price" row={5} label={t('aito.computedPrice')}>
          {computedUnit === null ? (
            // An em dash, not a sentence: the row already says whose price
            // this is, and "Not computable" only ever prompted "computable by
            // what?". Same convention the note row uses for its empty state.
            //
            // The testid is on BOTH branches so a test can ask what this row
            // currently says without matching on an em dash, which the
            // discount select and the note row also render.
            <span data-testid="impression-computed" className="text-sm text-bambu-gray">
              —
            </span>
          ) : (
            <span data-testid="impression-computed" className="flex items-center gap-2">
              <Money currency={currency} value={computedUnit} className="text-sm text-white" />
              {canApplyComputed && (
                <button
                  type="button"
                  onClick={() =>
                    // The existing channel: the second argument has always
                    // meant "the calculator's cost, in stored (already
                    // multiplied) form". Adopting a price therefore takes the
                    // same path a calculator edit does.
                    onChange(value, computedUnit * Math.max(1, Math.floor(value.quantity || 1)))
                  }
                  className={`rounded-md bg-bambu-green px-2 py-0.5 text-xs font-semibold text-bambu-dark transition-colors hover:bg-bambu-green-light ${focusRingCls}`}
                >
                  {t('aito.applyPrice')}
                </button>
              )}
            </span>
          )}
        </GridRow>

        <ImpressionCostBand
          result={result}
          notConfigured={notConfigured}
          lineTotal={lineTotal}
          discountedUnit={discountedUnit}
          currency={currency}
        />

        <div className="impression-rule" aria-hidden="true" />
      </div>
    </div>
  );
}
