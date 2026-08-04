import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Calculator } from 'lucide-react';
import { api } from '../../api/client';
import { SearchableSelect } from '../SearchableSelect';
import { DurationInput } from './DurationInput';
import { Money } from '../calculator/shared';
import { focusRingCls, inputCls, labelCls } from '../formStyles';
import { computeImpressionCost, roundUpTo50 } from '../../utils/taskDraft';
import type { ImpressionDraft } from '../../utils/taskDraft';

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
  /** The Impression3D cost field, rendered by the parent — TaskStepFields
   *  owns it and its null-vs-0 rule — but SEATED here, as the left cell of
   *  the top row, so quantity (which multiplies straight into that cost)
   *  sits beside it. Passing it through is also what keeps it alive in the
   *  no-printers / no-filaments early returns below: an imported cost must
   *  stay editable on an installation with no calculator configured.
   *
   *  The node IS the flex cell: it lands directly in the top row, so it must
   *  carry its own `min-w-0 flex-1` (see TaskStepFields) rather than being
   *  wrapped here — an extra wrapper would break the "cost and quantity are
   *  sibling cells" layout the tests pin. */
  costField: React.ReactNode;
  /** The discount selector, same slot contract as `costField` (the node is
   *  the cell, `min-w-0 flex-1`). Owned by TaskStepFields because the
   *  discount lives on the TASK beside `impressionCost` — it modifies the
   *  price, not the print parameters this component edits. Seated here, in
   *  the top row right after quantity, so the commercial trio (price,
   *  count, discount) reads as one line. */
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
  // Closed by default, deliberately even for a task whose parameters are
  // already filled: the collapsed row still shows the two figures that
  // matter (unit price, quantity), and the button lights up when open.
  const [calculatorOpen, setCalculatorOpen] = useState(false);

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
  // Same cache key CalculatorPage uses for the app's configured currency, so
  // this and the calculator page share one fetch instead of two.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';

  const filament = filaments.find((f) => f.id === value.filamentId) ?? null;
  const printer = printers.find((p) => p.id === value.printerId) ?? null;

  // CalculatorFilament/CalculatorPrinter are supersets of PricingFilament/
  // PricingPrinter, so they pass straight through — no mapping layer.
  const result = useMemo(
    () => (defaults ? computeImpressionCost(value, filament, printer, defaults) : null),
    [value, filament, printer, defaults],
  );

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

  // Calculator toggle | cost | quantity | discount, one row: the whole
  // commercial fact (what a piece costs, how many, what gesture applies)
  // reads left to right, and the calculator hides behind its button — most
  // edits are a price and a count, and the six-field pricing form under them
  // was the bulk of the block's height. Rendered ahead of every branch below
  // — the row must survive the unconfigured-install early returns too.
  const costRow = (
    // The testid is the row's layout contract for the tests: "these fields
    // are co-located in the top row" — pinned via within() queries rather
    // than DOM-nesting-depth assertions that break on any wrapper change.
    <div className="flex gap-3" data-testid="impression-top-row">
      <button
        type="button"
        aria-expanded={calculatorOpen}
        aria-label={t('calculator.title')}
        title={t('calculator.title')}
        onClick={() => setCalculatorOpen((v) => !v)}
        // box-content + h-6 content box + py-2 adds up to the exact height of
        // the inputs beside it (24px line + 16px padding + borders).
        className={`box-content inline-flex h-6 w-6 flex-shrink-0 items-center justify-center self-end rounded-lg border px-3 py-2 transition-colors motion-reduce:transition-none ${focusRingCls} ${
          calculatorOpen
            ? 'border-bambu-green/60 bg-bambu-green/10 text-bambu-green'
            : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green/40 hover:text-bambu-green-light'
        }`}
      >
        <Calculator className="h-4 w-4" />
      </button>
      {costField}
      {/* Fixed-width, not flex-1: a count is 1-3 digits and the discount is
          two digits and a sign — the unit cost is the field that earns the
          rest of the line. */}
      <div className="w-20 flex-shrink-0">
        <label htmlFor={`${reactId}-quantity`} className={labelCls}>
          {t('aito.quantity')}
        </label>
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
      {discountField}
    </div>
  );

  // Material | color, the piece's physical identity on its own row under the
  // commercial one. The empty spacer mirrors the toggle button's metrics so
  // the rows' left edges line up. Both are ImpressionDraft fields priced
  // through handleChange like the rest; material is the same filament select
  // the calculator grid used to hold — moved out because the quote's
  // "Matériau" line needs it far more often than the pricing form does. On
  // an unconfigured install its option list is simply empty.
  const detailRow = (
    <div className="flex gap-3">
      <div aria-hidden="true" className="box-content w-6 flex-shrink-0 px-3" />
      <div className="min-w-0 flex-1">
        <label htmlFor={`${reactId}-material`} className={labelCls}>
          {t('aito.material')}
        </label>
        <SearchableSelect
          id={`${reactId}-material`}
          value={value.filamentId === null ? '' : String(value.filamentId)}
          onChange={(v) => handleChange({ ...value, filamentId: v === '' ? null : Number(v) })}
          options={filaments.map((f) => ({ value: String(f.id), label: f.name }))}
          allowCustom={false}
        />
      </div>
      <div className="min-w-0 flex-1">
        <label htmlFor={`${reactId}-color`} className={labelCls}>
          {t('aito.color')}
        </label>
        <input
          id={`${reactId}-color`}
          type="text"
          value={value.color}
          onChange={(e) => handleChange({ ...value, color: e.target.value })}
          className={inputCls}
        />
      </div>
    </div>
  );

  if (printers.length === 0 || filaments.length === 0) {
    return (
      <div className="space-y-3">
        {costRow}
        {detailRow}
        {calculatorOpen && (
          <p className="text-sm text-bambu-gray">
            {t(printers.length === 0 ? 'aito.noPrintersConfigured' : 'aito.noFilamentsConfigured')}{' '}
            <Link to="/calculator" className="text-bambu-green hover:underline">
              {t('calculator.title')}
            </Link>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {costRow}
      {detailRow}
      {calculatorOpen && (
        <>
      <div data-testid="impression-divider" aria-hidden="true" className="border-t border-bambu-dark-tertiary" />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${reactId}-printer`} className={labelCls}>
            {t('aito.printer')}
          </label>
          <SearchableSelect
            id={`${reactId}-printer`}
            value={value.printerId === null ? '' : String(value.printerId)}
            onChange={(v) => handleChange({ ...value, printerId: v === '' ? null : Number(v) })}
            options={printers.map((p) => ({ value: String(p.id), label: p.name }))}
            allowCustom={false}
          />
        </div>
        <div>
          <label htmlFor={`${reactId}-weight`} className={labelCls}>
            {t('aito.weightG')}
          </label>
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
        </div>
        <div>
          <label htmlFor={`${reactId}-time`} className={labelCls}>
            {t('aito.printTime')}
          </label>
          <DurationInput
            id={`${reactId}-time`}
            minutes={value.timeMin}
            onChange={(timeMin) => handleChange({ ...value, timeMin })}
          />
        </div>
      </div>
      {result && (
        <div className="space-y-1 pt-2 border-t border-bambu-dark-tertiary lg:border-t-0 lg:pt-0 lg:border-l lg:border-bambu-dark-tertiary lg:pl-4">
          {(
            [
              ['calculator.costFilament', result.filament_cost],
              ['calculator.costDepreciation', result.depreciation_cost],
              ['calculator.costEnergy', result.energy_cost],
              ['calculator.costRepairs', result.repairs_cost],
              ['calculator.groupProvisions', result.prototype_cost + result.failures_cost],
              ['calculator.costAds', result.ads_cost],
              ['calculator.marge', result.marge],
            ] as const
          ).map(([labelKey, lineValue]) => (
            <div key={labelKey} className="flex justify-between gap-2 text-sm">
              <span className="text-bambu-gray-light">{t(labelKey)}</span>
              <Money currency={currency} value={lineValue} className="text-white" />
            </div>
          ))}
          <div className="flex justify-between gap-2 text-sm font-medium pt-1">
            <span className="text-white">{t('calculator.totalTTC')}</span>
            <Money currency={currency} value={result.total_ttc} className="text-bambu-green" />
          </div>
          {value.quantity > 1 && (
            <div className="flex justify-between gap-2 text-sm font-medium">
              <span className="text-white">{t('calculator.forQuantity', { count: value.quantity })}</span>
              <Money currency={currency} value={result.total_ttc_qty} className="text-bambu-green" />
            </div>
          )}
        </div>
      )}
      </div>
        </>
      )}
    </div>
  );
}
