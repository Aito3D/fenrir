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
}

/** Labeled numeric input with optional validation error and an accessible
 *  info tooltip. Shared by the calculator page and its settings panels. */
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
}: NumberFieldProps) {
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
      <input
        id={id}
        type="number"
        inputMode="decimal"
        autoComplete="off"
        step={step}
        min={min}
        max={max}
        required={required}
        className={error ? inputErrorCls : inputCls}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
      />
      {error && <p className="text-xs text-status-error mt-1">{error}</p>}
    </div>
  );
}
