import { inputCls, labelCls } from '../../formStyles';
import { CalcInput } from '../../CalcInput';

/** Labelled amount input shared by the manual, terminal and link payment
 *  flows: a `CalcInput` (text, so a stray space doesn't blank the input, and
 *  "12000/2" splits a payment) with the document's currency pinned to the
 *  right edge. A calculation resolves to whole francs; parsing/validation
 *  lives in `./amount.ts` — this component only renders. */
export function AmountField({ id, value, onChange, currency, label }: {
  id: string;
  value: string;
  onChange: (raw: string) => void;
  currency: string;
  label: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>{label}</label>
      <div className="relative">
        <CalcInput
          id={id}
          inputMode="numeric"
          value={value}
          onValueChange={onChange}
          normalize={Math.round}
          className={`${inputCls} pr-14`}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-bambu-gray pointer-events-none">
          {currency}
        </span>
      </div>
    </div>
  );
}
