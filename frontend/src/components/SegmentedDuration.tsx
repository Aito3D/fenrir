/** One duration, entered as several segments inside a single bordered box.
 *
 *  Presentational only: it renders the strings it is handed and reports the
 *  raw strings back. Every interpretation — what a segment means, how the
 *  segments combine, when overflow normalizes — belongs to the adapter above
 *  it, because the two callers disagree. The calculator page keeps three
 *  free-typed strings so an operator can type past a boundary; Aito keeps one
 *  total in minutes where `null` means "service not set".
 *
 *  Deliberately does NOT compose `inputCls`. That class begins with `w-full`,
 *  and `w-full` inside an auto-width flex item resolves to min-content, which
 *  is what used to collapse these inputs to ~34px and clip their own digits.
 *  The segments size themselves with `flex-1` instead. */
export interface DurationSegment {
  /** Echoed back to `onSegmentChange` so the adapter knows which field moved. */
  key: string;
  /** Rendered verbatim. An empty string shows the placeholder. */
  value: string;
  /** Visible suffix, e.g. `h`. */
  unitLabel: string;
  /** Accessible name for this segment, e.g. `Hours`. */
  ariaLabel: string;
}

export interface SegmentedDurationProps {
  segments: DurationSegment[];
  onSegmentChange: (key: string, raw: string) => void;
  /** Fired only once focus leaves the group entirely — never when the
   *  operator tabs from one of its own segments to another. */
  onGroupBlur?: () => void;
  error?: boolean;
  /** Lands on the first segment's input, so an external `<label htmlFor>`
   *  still points at a real control. */
  firstId?: string;
  /** id of the visible field label; becomes the group's accessible name. */
  groupLabelId?: string;
  /** `lg` is the calculator page's display size; `md` (the default) matches
   *  `inputCls`, so the field lines up with ordinary inputs beside it. */
  size?: 'md' | 'lg';
}

export function SegmentedDuration({
  segments,
  onSegmentChange,
  onGroupBlur,
  error,
  firstId,
  groupLabelId,
  size = 'md',
}: SegmentedDurationProps) {
  return (
    <div
      role="group"
      aria-labelledby={groupLabelId}
      // React's onBlur is the delegated focusout, so it carries relatedTarget
      // and bubbles from the inputs — one handler covers the whole group.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onGroupBlur?.();
      }}
      className={`flex items-stretch divide-x rounded-lg border bg-bambu-dark transition-colors motion-reduce:transition-none focus-within:ring-2 ${
        error
          ? 'border-status-error/70 divide-status-error/30 focus-within:border-status-error focus-within:ring-status-error/20'
          : 'border-bambu-dark-tertiary divide-bambu-dark-tertiary focus-within:border-bambu-green focus-within:ring-bambu-green/20'
      }`}
    >
      {segments.map((seg, index) => (
        // The label IS the segment box, so the whole cell — including the
        // unit suffix and the padding around it — is a click target for its
        // own input.
        <label key={seg.key} className="flex min-w-0 flex-1 items-baseline gap-1.5 px-3 py-2 cursor-text">
          <input
            id={index === 0 ? firstId : undefined}
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min="0"
            step="1"
            aria-label={seg.ariaLabel}
            aria-invalid={!!error}
            placeholder="0"
            className={`w-full min-w-0 bg-transparent text-right text-white tabular-nums no-spinner focus:outline-none placeholder:text-bambu-gray/40 ${
              size === 'lg' ? 'text-lg' : ''
            }`}
            value={seg.value}
            onChange={(e) => onSegmentChange(seg.key, e.target.value)}
          />
          <span className="select-none text-xs text-bambu-gray">{seg.unitLabel}</span>
        </label>
      ))}
    </div>
  );
}
