import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type SyntheticEvent } from 'react';
import { CODE_LENGTH, normalizeCode, type CodeState } from '../../utils/trackingCode';

export interface TrackingCodeInputProps {
  value: string;
  state: CodeState;
  label: string;
  describedBy?: string;
  onChange: (next: string) => void;
  /** Enter on a full code: a retry after a network failure. */
  onSubmit: () => void;
}

/** Six squares and one real input.
 *
 *  The squares are drawn from the value and are purely visual; the input
 *  laid invisibly over them is what the keyboard, the screen reader, paste
 *  and autofill talk to. One input, not six, because a single field is
 *  what a phone's one-time-code autofill and a paste both expect, and it
 *  never needs focus juggled between boxes. Its caret is hidden and its
 *  selection is pinned to the end, so a tap in the middle of the squares
 *  still types at the end.
 *
 *  The caret the client sees is the cyan frame that glides to the next
 *  square; it breathes while the field waits and is gone while a code is
 *  being checked. Every glyph pops in as it is typed. The row's states —
 *  checking, found, error — are one `data-state` the stylesheet reads
 *  (index.css, "tracking code entry"). */
export function TrackingCodeInput({ value, state, label, describedBy, onChange, onSubmit }: TrackingCodeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const busy = state === 'checking' || state === 'found';

  // The field takes focus on arrival: the page exists to be typed into.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pinToEnd = (event: SyntheticEvent<HTMLInputElement>) => {
    const el = event.currentTarget;
    const end = el.value.length;
    if (el.selectionStart !== end || el.selectionEnd !== end) el.setSelectionRange(end, end);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && value.length === CODE_LENGTH && !busy) {
      event.preventDefault();
      onSubmit();
    }
  };

  const caretIndex = Math.min(value.length, CODE_LENGTH - 1);
  const caretVisible = focused && !busy;
  return (
    <div className="code-row" data-state={state} data-testid="track-code">
      {/* The glide is on the wrapper, never on the frame: the frame's own
          entrance animation fills forward with `transform: none`, which
          would override an inline translate for good. */}
      <div
        className="code-caret-wrap"
        data-hidden={caretVisible ? undefined : ''}
        data-index={caretIndex}
        aria-hidden="true"
        style={{ transform: `translateX(calc(${caretIndex} * (var(--code-cell) + var(--code-gap))))` }}
      >
        <span className="code-caret" />
      </div>
      {Array.from({ length: CODE_LENGTH }, (_, i) => {
        const ch = value[i] ?? '';
        return (
          <div key={i} className="code-slot" style={{ '--i': i } as CSSProperties} aria-hidden="true">
            <div className="code-cell" data-filled={ch ? '' : undefined}>
              {/* Keyed by the glyph as well as the slot, so a replaced
                  character pops in again instead of swapping silently. */}
              {ch && (
                <span key={`${i}-${ch}`} className="code-glyph">
                  {ch}
                </span>
              )}
            </div>
          </div>
        );
      })}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(normalizeCode(e.target.value))}
        onFocus={(e) => {
          setFocused(true);
          pinToEnd(e);
        }}
        onBlur={() => setFocused(false)}
        onSelect={pinToEnd}
        onKeyDown={onKeyDown}
        readOnly={busy}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={state === 'error' || undefined}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        enterKeyHint="go"
        // 16 px or iOS zooms the page on focus; the text itself is invisible.
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-[16px] text-transparent caret-transparent opacity-0 outline-none"
      />
    </div>
  );
}
