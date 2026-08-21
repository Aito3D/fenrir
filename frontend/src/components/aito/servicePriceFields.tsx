import { inputCls } from '../formStyles';

/** Inline label for a price-grid row. Not `labelCls`: that one is `block`
 *  with a bottom margin, for a label STACKED above its field. Here the label
 *  sits beside its field, in the grid's own label column — which is what buys
 *  a service block ~24px per field.
 *
 *  Lives here rather than in ImpressionFields because all four service blocks
 *  now render rows into a label|field grid, and a layout constant owned by one
 *  block is a constant three other blocks import sideways.
 */
export const rowLabelCls = 'text-sm text-bambu-gray text-right';

/** The percentages the shop offers. Not free entry: a discount is a
 *  commercial decision from a fixed menu, and a typed 12.5% would print a
 *  rate nobody agreed. */
export const DISCOUNT_STEPS: readonly number[] = [5, 10, 15, 20, 25, 30];

/** How many units one service line covers.
 *
 *  Fixed-width (`max-w-20`), not flex-1: a count is 1-3 digits — the unit cost
 *  beside it is the field that earns the rest of the line. Without a cap, bare
 *  `inputCls` (`w-full`) stretches this across the whole field column for
 *  three digits' worth of content.
 *
 *  Floors at 1 and reports an integer: there is no zero-unit line and no
 *  half-part, and every consumer divides a stored total by this number. */
export function QuantityInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="max-w-20">
      <input
        id={id}
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(e) =>
          onChange(e.target.value === '' ? 1 : Math.max(1, Math.floor(Number(e.target.value) || 1)))
        }
        className={inputCls}
      />
    </div>
  );
}

/** A service line's percent discount, or none.
 *
 *  Reports `null` for the empty option, never `0`: no discount means no
 *  discount COLUMN on the quote's PDF at all, and a literal "0%" would put one
 *  there. `max-w-24` — wide enough for "30%" plus the select's own disclosure
 *  arrow — for the same reason QuantityInput is capped. */
export function DiscountSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <div className="max-w-24">
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        className={inputCls}
      >
        {/* An em dash, not "0%": see the component doc. */}
        <option value="">—</option>
        {DISCOUNT_STEPS.map((pct) => (
          <option key={pct} value={pct}>
            {pct}%
          </option>
        ))}
      </select>
    </div>
  );
}
