/** Age-based heat ramp for the board card's elapsed-time label.
 *
 *  Spec: docs/superpowers/specs/2026-08-01-aito-card-aging-heat-ramp-design.md.
 *  The older a LIVE project, the hotter the label — gray is calm, amber is
 *  aging, red is act-now, matching the app's existing warning language. Done
 *  and trashed cards are exempt: a finished or discarded job is not late.
 */

const DAY_MS = 86_400_000;

/** Inclusive lower bounds, in days, for levels 1..6. */
const THRESHOLD_DAYS = [3, 7, 10, 15, 21, 30] as const;

export type AgingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One COMPLETE class string per level — Tailwind cannot see fragments.
 *  Level 6 adds weight: the final alarm is typographic, not animated. */
const LEVEL_CLS: Record<AgingLevel, string> = {
  0: 'text-bambu-gray',
  1: 'text-[#d9c26b]',
  2: 'text-amber-400',
  3: 'text-orange-400',
  4: 'text-orange-500',
  5: 'text-[#f75c4c]',
  6: 'text-red-500 font-medium',
};

export function agingLevel(ageMs: number): AgingLevel {
  let level: AgingLevel = 0;
  THRESHOLD_DAYS.forEach((days, index) => {
    if (ageMs >= days * DAY_MS) level = (index + 1) as AgingLevel;
  });
  return level;
}

/** The timestamp's text class for one card. Exempt cards (not active, done
 *  column, unparseable date) stay calm gray whatever their age. */
export function agingTextCls(
  project: { status: string; column: string },
  created: Date | null,
  now: number = Date.now(),
): string {
  if (project.status !== 'active' || project.column === 'done' || created === null) {
    return LEVEL_CLS[0];
  }
  return LEVEL_CLS[agingLevel(now - created.getTime())];
}
