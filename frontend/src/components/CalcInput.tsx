import { useLayoutEffect, useRef, useState, type InputHTMLAttributes } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Calculator } from 'lucide-react';
import { evaluateExpression } from '../utils/mathExpression';

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'defaultValue' | 'onChange' | 'inputMode' | 'min' | 'max' | 'step'
>;

interface CalcInputProps extends NativeInputProps {
  /** The committed value, shown whenever the field is not holding a draft. */
  value: string | number | null | undefined;
  /** Receives '' when cleared, otherwise a canonical number string ("1.5",
   *  never "1,5"): live for plain numbers, on blur/Enter for calculations. */
  onValueChange: (raw: string) => void;
  /** Applied to a calculation's result before it is previewed and committed
   *  (rounding, clamping), so the live "= …" is exactly what gets saved. */
  normalize?: (n: number) => number;
  /** Keyboard shown before the user asks for the full one: 'numeric' for
   *  whole-number fields. */
  inputMode?: 'decimal' | 'numeric';
  /** Classes for the positioning wrapper — e.g. `flex-1 min-w-0` inside a flex row. */
  wrapperClassName?: string;
}

const ICON_GUTTER = '2rem';

/**
 * A number field that also takes a calculation: "4/2" resolves to 2 when the
 * user leaves the field or presses Enter, with the result previewed live.
 *
 * What was typed stays a local draft while the field is in use, so the owner
 * only ever sees '' or a number: plain numbers pass through as they are typed,
 * a calculation only once it resolves. An invalid calculation keeps its text,
 * turns the field red and commits nothing — a cost field can never be emptied
 * (= "service off") by a half-typed sum. Escape drops the draft.
 *
 * The calculator icon toggles the full keyboard: phone decimal keypads have no
 * operators, so the field opens on the keypad and the icon swaps it.
 */
export function CalcInput({
  value,
  onValueChange,
  normalize = (n) => n,
  inputMode = 'decimal',
  wrapperClassName = '',
  className = '',
  style,
  onBlur,
  onKeyDown,
  disabled,
  readOnly,
  ...rest
}: CalcInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLSpanElement>(null);
  const basePaddingRight = useRef<number | null>(null);
  const togglingKeyboard = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [fullKeyboard, setFullKeyboard] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(0);
  // The owner's blur handler as of its latest render: a resolved calculation
  // is flushed to the owner before blur reaches it, so an owner that validates
  // its own state on blur sees the result, not the text that was typed.
  const latestOnBlur = useRef(onBlur);
  useLayoutEffect(() => {
    latestOnBlur.current = onBlur;
  });

  const evaluated = draft === null ? null : evaluateExpression(draft);
  const preview = evaluated && !evaluated.literal ? `= ${normalize(evaluated.value)}` : null;

  // The live result sits at the input's own right padding — so it clears a
  // unit or currency the caller pins there — and the typed text is padded
  // past it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && basePaddingRight.current === null) {
      basePaddingRight.current = parseFloat(getComputedStyle(el).paddingRight) || 0;
    }
    setPreviewWidth(preview ? (previewRef.current?.offsetWidth ?? 0) : 0);
  }, [preview]);

  /** Resolve the draft. Returns false when it is not a valid number or calculation. */
  const commit = (): boolean => {
    if (draft === null) return true;
    if (draft.trim() === '') {
      setDraft(null);
      return true;
    }
    if (!evaluated) {
      setInvalid(true);
      return false;
    }
    if (!evaluated.literal) onValueChange(String(normalize(evaluated.value)));
    setDraft(null);
    return true;
  };

  const toggleKeyboard = () => {
    const el = inputRef.current;
    const wasFocused = el !== null && document.activeElement === el;
    flushSync(() => setFullKeyboard((v) => !v));
    if (!el) return;
    // Mobile keyboards only re-read inputmode on focus: bounce focus without
    // letting the blur commit a half-typed calculation.
    togglingKeyboard.current = true;
    if (wasFocused) el.blur();
    el.focus();
    togglingKeyboard.current = false;
  };

  const padRight =
    previewWidth > 0 && basePaddingRight.current !== null ? basePaddingRight.current + previewWidth + 4 : undefined;

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        {...rest}
        ref={inputRef}
        type="text"
        inputMode={fullKeyboard ? 'text' : inputMode}
        autoComplete="off"
        disabled={disabled}
        readOnly={readOnly}
        value={draft ?? value ?? ''}
        aria-invalid={invalid || rest['aria-invalid'] || undefined}
        title={invalid ? t('common.calcInvalid') : rest.title}
        className={`${className} ${invalid ? 'ring-2 ring-status-error/60' : ''}`}
        style={{ ...style, paddingLeft: ICON_GUTTER, ...(padRight !== undefined && { paddingRight: padRight }) }}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          setInvalid(false);
          if (raw.trim() === '') {
            onValueChange('');
            return;
          }
          const parsed = evaluateExpression(raw);
          if (parsed?.literal) onValueChange(String(parsed.value));
        }}
        onBlur={(e) => {
          if (!togglingKeyboard.current) flushSync(commit);
          latestOnBlur.current?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && draft !== null) {
            setDraft(null);
            setInvalid(false);
            e.stopPropagation();
            return;
          }
          // A calculation resolves in place; only a plain number lets Enter submit.
          if (e.key === 'Enter' && draft !== null && !evaluated?.literal && draft.trim() !== '') {
            e.preventDefault();
            commit();
            return;
          }
          onKeyDown?.(e);
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        disabled={disabled || readOnly}
        aria-label={t('common.calcKeyboard')}
        aria-pressed={fullKeyboard}
        title={t('common.calcKeyboard')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleKeyboard}
        className={`absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded transition-colors disabled:opacity-40 ${
          invalid ? 'text-status-error' : fullKeyboard ? 'text-bambu-green' : 'text-bambu-gray hover:text-white'
        }`}
      >
        <Calculator className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
      {preview && (
        <span
          ref={previewRef}
          data-testid="calc-preview"
          aria-live="polite"
          style={{ right: basePaddingRight.current ?? 0 }}
          className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-xs text-bambu-gray whitespace-nowrap"
        >
          {preview}
        </span>
      )}
      {invalid && (
        <span role="alert" className="sr-only">
          {t('common.calcInvalid')}
        </span>
      )}
    </div>
  );
}
