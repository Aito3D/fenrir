import { Info } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { inputCls, inputErrorCls, labelCls } from './formStyles';

interface NumberFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  tooltip?: string;
  placeholder?: string;
  step?: string;
  min?: string;
  max?: string;
  required?: boolean;
  /** Unit suffix rendered inside the field ("g", "min", "$"), so the unit
   *  stays in eyeline while typing instead of living in the label. */
  unit?: string;
}

/** Labeled numeric input with optional validation error, an accessible
 *  info tooltip and an in-field unit suffix. Shared by the calculator page
 *  and its settings panels. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  error,
  tooltip,
  placeholder,
  step = 'any',
  min = '0',
  max,
  required,
  unit,
}: NumberFieldProps) {
  const inputProps = {
    id,
    type: 'number' as const,
    inputMode: 'decimal' as const,
    autoComplete: 'off',
    step,
    min,
    max,
    required,
    value,
    placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    'aria-invalid': !!error,
  };
  return (
    <div>
      <label htmlFor={id} className={`${labelCls} flex items-center gap-1`}>
        {label}
        {tooltip && (
          <Tooltip content={tooltip}>
            <Info className="w-3.5 h-3.5 text-bambu-gray" aria-hidden="true" />
          </Tooltip>
        )}
      </label>
      {unit ? (
        <div
          className={`flex items-center rounded-lg border bg-bambu-dark transition-colors focus-within:ring-2 ${
            error
              ? 'border-status-error/70 focus-within:border-status-error focus-within:ring-status-error/20'
              : 'border-bambu-dark-tertiary focus-within:border-bambu-green focus-within:ring-bambu-green/20'
          }`}
        >
          <input
            {...inputProps}
            className="w-full min-w-0 px-3 py-2 bg-transparent text-white placeholder-bambu-gray no-spinner focus:outline-none"
          />
          <span className="select-none pr-3 text-xs text-bambu-gray whitespace-nowrap">{unit}</span>
        </div>
      ) : (
        <input {...inputProps} className={error ? inputErrorCls : inputCls} />
      )}
      {error && <p className="text-xs text-status-error mt-1">{error}</p>}
    </div>
  );
}
