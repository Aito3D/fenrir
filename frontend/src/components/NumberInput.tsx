import { useRef, useState, type InputHTMLAttributes } from 'react';
import { CalcInput } from './CalcInput';

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'min' | 'max'>;

interface NumberInputProps extends NativeInputProps {
  value: number | null | undefined;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Parse with parseInt (default); pass false for fields with a fractional step. */
  integer?: boolean;
  /** Committed when the field is left empty. Without it an empty field reverts to `value`. */
  fallback?: number;
  /** Accept a calculation ("4/2"), resolved on blur and clamped like a typed number. */
  calc?: boolean;
}

/**
 * A number field that can be cleared and retyped (#3182).
 *
 * Clamping inside onChange rewrites the field on every keystroke: clearing a
 * "1" snaps straight back to 1, and typing the "6" of 60 into a field with a
 * minimum of 45 turns it into 45. This keeps what was typed as a draft while
 * the field is being edited, passes a value up only once the draft is a number
 * inside [min, max], and settles the field on blur — clamped into range, or
 * `fallback` when left empty.
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  integer = true,
  fallback,
  calc,
  onBlur,
  ...rest
}: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // calc mode: CalcInput owns the text; this only remembers what it last
  // reported so blur can settle it (a ref, because blur runs in the same
  // event as CalcInput's commit, before a state update would land).
  const lastRaw = useRef<string | null>(null);

  const parse = (raw: string) => (integer ? parseInt(raw, 10) : parseFloat(raw));
  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));

  const settle = (raw: string) => {
    const n = parse(raw);
    const settled = Number.isNaN(n) ? fallback : n;
    if (settled !== undefined && clamp(settled) !== value) onChange(clamp(settled));
  };

  if (calc) {
    const { inputMode, ...calcRest } = rest;
    return (
      <CalcInput
        {...calcRest}
        inputMode={integer ? 'numeric' : inputMode === 'numeric' ? 'numeric' : 'decimal'}
        value={value ?? ''}
        normalize={(n) => clamp(integer ? Math.round(n) : n)}
        onValueChange={(raw) => {
          lastRaw.current = raw;
          const n = parse(raw);
          if (!Number.isNaN(n) && inRange(n) && n !== value) onChange(n);
        }}
        onBlur={(e) => {
          if (lastRaw.current !== null) settle(lastRaw.current);
          lastRaw.current = null;
          onBlur?.(e);
        }}
      />
    );
  }

  return (
    <input
      {...rest}
      type="number"
      min={min}
      max={max}
      value={draft ?? value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = parse(raw);
        if (!Number.isNaN(n) && inRange(n) && n !== value) onChange(n);
      }}
      onBlur={(e) => {
        if (draft !== null) {
          settle(draft);
          setDraft(null);
        }
        onBlur?.(e);
      }}
    />
  );
}
