import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Sparkles, Undo2 } from 'lucide-react';
import { api } from '../../api/client';
import { focusRingCls } from '../formStyles';

/** The purple sibling of `inputCls`: same box, violet border and tint instead
 *  of the neutral one, plus room on the right for the sparkle cluster.
 *
 *  Written out rather than composed with `inputCls` on purpose — appending
 *  utilities to that string is how a width or border silently loses to its own
 *  earlier declaration (see the calculator's `w-28` bug).
 *
 *  `block` is load-bearing, not tidiness: an inline-block control sits on a
 *  text baseline, so its wrapper is a few px TALLER than the field itself
 *  (the descender gap under the line box). The sparkle is positioned against
 *  that wrapper, so without this it hangs below the field and straddles the
 *  bottom border. */
const aiInputCls =
  'block w-full pl-3 py-2 bg-bambu-dark border border-violet-400/35 rounded-lg text-white placeholder-bambu-gray no-spinner transition-colors focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20 focus:outline-none';

export interface AiTextFieldProps {
  /** Accessible name, and the tooltip's subject. */
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Renders a textarea instead of an input — the service descriptions. */
  multiline?: boolean;
  rows?: number;
  /** Extra classes for the control itself (margins, mostly). */
  className?: string;
}

/** A text field that spell-checks its own French when the user leaves it.
 *
 *  Correction, never rewriting: the backend prompt forbids reformulating, and
 *  what comes back is swapped straight into the field, because the whole point
 *  is that the text landing on a quote is clean without the user proof-reading
 *  it themselves. That makes two guarantees load-bearing here:
 *
 *  1. **One call per edit.** The correction arrives as an `onChange`, which
 *     re-renders the field; every text this component has already sent (and
 *     every answer it received, and anything the user restored) goes into
 *     `settledRef`, so blurring an untouched field is free. Failures settle
 *     the text too — a field the AI cannot fix must not retry on every blur.
 *  2. **The user's keystrokes win.** The answer is only applied if the field
 *     still holds the exact text that was sent. Someone who comes back and
 *     keeps typing while the request is in flight keeps what they typed.
 *
 *  A correction leaves an undo control beside the sparkle: one click puts the
 *  original wording back (and settles it, so it is not immediately
 *  "corrected" again). Mounted inside a disabled fieldset — a task row whose
 *  create POST is still open — the control never fires, because a disabled
 *  field cannot be focused, let alone blurred. */
export function AiTextField({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  rows = 2,
  className = '',
}: AiTextFieldProps) {
  const { t } = useTranslation();

  // Texts this field must not spend another call on: everything sent, every
  // answer received, and anything the user restored by hand.
  const settledRef = useRef<Set<string>>(new Set());
  // The live value, for the in-flight guard below: the mutation's callback
  // closes over the render that started it, which is exactly the stale value
  // that would clobber a keystroke typed since.
  const valueRef = useRef(value);
  valueRef.current = value;

  const [undoTo, setUndoTo] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => api.proofreadAitoText(text),
    onSuccess: (data, sent) => {
      settledRef.current.add(data.text);
      // Someone kept typing while this was in flight: their text wins.
      if (valueRef.current.trim() !== sent) return;
      if (data.text === sent) return;
      setUndoTo(sent);
      onChange(data.text);
    },
    // No error branch: `sent` is already settled, so the user's own text
    // simply stands. An unconfigured install (409) is a silent no-op by
    // design — the fields still work, they just stop being corrected.
  });

  const handleBlur = () => {
    const text = value.trim();
    if (!text || mutation.isPending || settledRef.current.has(text)) return;
    settledRef.current.add(text);
    mutation.mutate(text);
  };

  // Room on the right for the cluster — wider once undo joins the sparkle, or
  // a long title would run under two icons. Kept OUT of `aiInputCls`: two
  // padding utilities in one class string race each other in the generated
  // stylesheet rather than overriding in source order.
  const padRight = undoTo !== null ? 'pr-14' : 'pr-9';
  // The field itself says it is busy: two light arcs travel its border for as
  // long as the answer is outstanding, and stop on both outcomes (a correction
  // and a failure both settle the mutation). The class goes on the WRAPPER —
  // the arcs are a masked pseudo-element ring, and an input/textarea is a
  // replaced element with no ::before. See .animate-ai-thinking in index.css.
  const thinking = mutation.isPending ? 'animate-ai-thinking' : '';

  const control = multiline ? (
    <textarea
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={handleBlur}
      placeholder={placeholder}
      rows={rows}
      className={`${aiInputCls} ${padRight} resize-none`}
    />
  ) : (
    <input
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={handleBlur}
      placeholder={placeholder}
      className={`${aiInputCls} ${padRight}`}
    />
  );

  return (
    <div className={`relative ${thinking} ${className}`}>
      {control}
      {/* Pinned to the field's trailing edge — bottom-aligned on a textarea so
          it rides the last line rather than floating in the middle of the
          block. `pointer-events-none` on the cluster keeps the sparkle out of
          the way of a click meant for the text; the undo button opts back in. */}
      <div
        data-testid="ai-field-marker"
        className={`pointer-events-none absolute right-2 flex items-center gap-1.5 ${
          multiline ? 'bottom-2' : 'top-1/2 -translate-y-1/2'
        }`}
      >
        {undoTo !== null && (
          <button
            type="button"
            aria-label={t('aito.aiUndo')}
            title={t('aito.aiUndo')}
            onClick={() => {
              settledRef.current.add(undoTo);
              onChange(undoTo);
              setUndoTo(null);
            }}
            className={`pointer-events-auto rounded-md p-0.5 text-bambu-gray transition-colors hover:text-violet-300 ${focusRingCls}`}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        )}
        <Sparkles
          aria-hidden="true"
          className={`h-3.5 w-3.5 text-violet-300 ${mutation.isPending ? 'animate-pulse' : ''}`}
        />
        {/* The sparkle is decorative; the state it carries is not, so it is
            announced here instead of through a title on an aria-hidden icon. */}
        <span className="sr-only" aria-live="polite">
          {mutation.isPending ? t('aito.aiChecking') : t('aito.aiFieldHint')}
        </span>
      </div>
    </div>
  );
}
