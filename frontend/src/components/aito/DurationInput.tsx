import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { splitMinutes, joinMinutes } from '../../utils/taskDraft';
import { SegmentedDuration } from '../SegmentedDuration';
import type { DurationSegment } from '../SegmentedDuration';

export interface DurationInputProps {
  minutes: number | null;
  onChange: (minutes: number | null) => void;
  id?: string;
  /** id of the caller's visible label, so the segment group gets an
   *  accessible name — each segment names only its own unit. */
  labelId?: string;
}

/** Days / hours / minutes in, one integer of minutes out. The split is a UI
 *  concern only — storing three columns would invite "90 minutes" and "1h30"
 *  disagreeing.
 *
 *  The box, dividers and focus ring come from the shared `SegmentedDuration`;
 *  this component owns only the minutes<->segments conversion and the rule
 *  that an empty field means "not set" rather than "zero". */
const UNIT_KEYS = {
  days: ['calculator.durationDaysShort', 'calculator.durationDays'],
  hours: ['calculator.durationHoursShort', 'calculator.durationHours'],
  minutes: ['calculator.durationMinutesShort', 'calculator.durationMinutes'],
} as const;

type PartKey = keyof typeof UNIT_KEYS;

type Draft = Record<PartKey, string>;

export function DurationInput({ minutes, onChange, id, labelId }: DurationInputProps) {
  const { t } = useTranslation();
  const parts = splitMinutes(minutes ?? 0);
  const fallback: Draft = {
    days: minutes === null ? '' : String(parts.days),
    hours: minutes === null ? '' : String(parts.hours),
    minutes: minutes === null ? '' : String(parts.minutes),
  };

  // The whole displayed triple, held only until focus leaves the group.
  // Without it, editing one segment would re-derive ALL three from
  // `splitMinutes` of the freshly emitted total — so typing "90" into
  // minutes would echo back "1 h 30" while the operator is still mid-edit,
  // making a sibling segment (hours) visibly tick over under their fingers
  // even though they never touched it.
  const [draft, setDraft] = useState<Draft | null>(null);

  // Reuses the calculator's existing per-locale duration strings rather than
  // duplicating them under aito.* — they are already translated in all 13
  // files and already used for this exact purpose by CalculatorInputsCard.
  const displayed = draft ?? fallback;
  const segments: DurationSegment[] = (Object.keys(UNIT_KEYS) as PartKey[]).map((key) => ({
    key,
    value: displayed[key],
    unitLabel: t(UNIT_KEYS[key][0]),
    ariaLabel: t(UNIT_KEYS[key][1]),
  }));

  const set = (key: string, raw: string) => {
    const partKey = key as PartKey;
    // Build the next triple from what is CURRENTLY on screen, not from
    // `splitMinutes` of the stored total — the other two segments must stay
    // exactly as displayed while this one is edited.
    const nextDraft: Draft = { ...displayed, [partKey]: raw };
    setDraft(nextDraft);
    const next = {
      days: Math.max(0, Math.floor(Number(nextDraft.days) || 0)),
      hours: Math.max(0, Math.floor(Number(nextDraft.hours) || 0)),
      minutes: Math.max(0, Math.floor(Number(nextDraft.minutes) || 0)),
    };
    const total = joinMinutes(next);
    // Clearing a segment down to zero total means "not set", which keeps the
    // service disabled rather than pinning it to zero minutes. An explicit
    // "0" typed into every segment is a real (if odd) zero, not a clear.
    onChange(raw === '' && total === 0 ? null : total);
  };

  // Dropping the draft is what normalizes: the segments fall back to
  // `splitMinutes` of the stored total, so 90 min renders as 1 h 30. The
  // total itself never changed, so no onChange fires — a blur must not mark
  // the task dirty.
  const normalize = () => setDraft(null);

  return (
    <SegmentedDuration
      segments={segments}
      onSegmentChange={set}
      onGroupBlur={normalize}
      firstId={id}
      groupLabelId={labelId}
    />
  );
}
