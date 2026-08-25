import type { ChangeEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { inputCls } from '../formStyles';

/**
 * Shared editor-tab primitives for PresetEditorModal (spec §7): a labeled
 * field wrapper, mono text/number inputs, a tri-state (nil/Off/On) toggle
 * row (each option button carries an `aria-label` of "{row label}: {option}"
 * so two tri-state rows on the same tab, e.g. Retract's two options rows,
 * don't collide on a bare "On"/"Off"/"nil" accessible name), and a section
 * divider caption. Extracted so every parameter tab (General, Temps,
 * Cooling, Extrusion, Retract) looks identical.
 *
 * `inputCls` already carries `w-full` — callers must never append another
 * width utility to the same className (it would lose to `w-full`); wrap the
 * input in a sized container instead.
 */
export function Field({ label, unit, children }: { label: string; unit?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-bambu-gray/70">
        {label}
        {unit && <span className="font-normal normal-case text-bambu-gray/50">({unit})</span>}
      </span>
      {children}
    </label>
  );
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function TextInput({ value, onChange, placeholder, className = '' }: TextInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`${inputCls} font-mono ${className}`.trim()}
    />
  );
}

interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  step?: string;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
}

export function NumberInput({ value, onChange, step, min, max, placeholder, className = '' }: NumberInputProps) {
  // Nudge by ±step with click feedback. Precision comes from the step's own
  // decimals ("0.001" → 3), so 0.02 + 0.001 never renders as 0.021000000000000002.
  const nudge = (dir: 1 | -1) => {
    const stepNum = parseFloat(step || '1') || 1;
    const decimals = (step || '1').split('.')[1]?.length ?? 0;
    let next = (parseFloat(value) || 0) + dir * stepNum;
    if (min !== undefined && next < parseFloat(min)) next = parseFloat(min);
    if (max !== undefined && next > parseFloat(max)) next = parseFloat(max);
    onChange(next.toFixed(decimals));
  };
  return (
    <div
      className="flex items-stretch overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark transition-colors focus-within:border-bambu-green"
    >
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full min-w-0 border-0 bg-transparent px-3 py-2 font-mono text-sm tabular-nums text-white placeholder-bambu-gray [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${className}`.trim()}
      />
      {/* Pointer-only nudge affordance (Material Sheet design): keyboard users
          already have the number input's native arrow-key increment, so these
          stay out of the tab order and the accessibility tree rather than
          adding two unlabeled buttons per field. */}
      <span className="flex flex-col border-l border-bambu-dark-tertiary" aria-hidden="true">
        {([1, -1] as const).map((dir) => (
          <button
            key={dir}
            type="button"
            tabIndex={-1}
            onClick={() => nudge(dir)}
            className="flex-1 px-1.5 text-[8px] leading-none text-bambu-gray/60 transition-colors hover:bg-white/5 hover:text-white active:bg-bambu-green/20 active:text-bambu-green"
          >
            {dir === 1 ? '▲' : '▼'}
          </button>
        ))}
      </span>
    </div>
  );
}

const TRI_STATE_OPTIONS: { value: string; labelKey: string }[] = [
  { value: '', labelKey: 'filamentProfiles.nil' },
  { value: '0', labelKey: 'filamentProfiles.off' },
  { value: '1', labelKey: 'filamentProfiles.on' },
];

export function TriStateRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-bambu-gray">{label}</span>
      <div className="flex items-center gap-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-1">
        {TRI_STATE_OPTIONS.map((opt) => (
          <button
            key={opt.value || 'nil'}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
            aria-label={`${label}: ${t(opt.labelKey)}`}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              value === opt.value ? 'bg-bambu-green/20 text-bambu-green' : 'text-bambu-gray/70 hover:text-white'
            }`}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-bambu-gray/60">
        {label}
      </span>
      <div className="h-px flex-1 bg-bambu-dark-tertiary" />
    </div>
  );
}
