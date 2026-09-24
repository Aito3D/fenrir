import { inputCls, labelCls } from '../../formStyles';

/** Labelled amount input shared by the manual, terminal and link payment
 *  flows: a plain text field (not `type="number"`, so a stray space doesn't
 *  blank the input) with the document's currency pinned to the right edge.
 *  Parsing/validation lives in `./amount.ts` — this component only renders. */
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
        <input
          id={id}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} pr-14`}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-bambu-gray pointer-events-none">
          {currency}
        </span>
      </div>
    </div>
  );
}
