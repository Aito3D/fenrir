/** Age-based heat ramp for the board card's elapsed-time label.
 *
 *  Spec: docs/superpowers/specs/2026-08-01-aito-card-aging-heat-ramp-design.md.
 *  The older a LIVE project, the hotter the label — gray is calm, amber is
 *  aging, red is act-now, matching the app's existing warning language. Done
 *  and trashed cards are exempt: a finished or discarded job is not late.
 */

import { parseUTCDateStrict } from './date';

const DAY_MS = 86_400_000;

/** Inclusive lower bounds, in days, for levels 1..6. */
const THRESHOLD_DAYS = [3, 7, 10, 15, 21, 30] as const;

export type AgingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function agingLevel(ageMs: number): AgingLevel {
  let level: AgingLevel = 0;
  THRESHOLD_DAYS.forEach((days, index) => {
    if (ageMs >= days * DAY_MS) level = (index + 1) as AgingLevel;
  });
  return level;
}

/** One COMPLETE class string per level — Tailwind cannot see fragments.
 *  Colour only: surfaces that set their own type weight (the panel's age stat
 *  is 1.15rem semibold) must not have a weight forced on them from here. */
const LEVEL_COLOR: Record<AgingLevel, string> = {
  0: 'text-bambu-gray',
  1: 'text-[#d9c26b]',
  2: 'text-amber-400',
  3: 'text-orange-400',
  4: 'text-orange-500',
  5: 'text-[#fb7a6a]',
  6: 'text-red-400',
};

/** Exempt cards (not active, done column, unparseable date) stay calm gray
 *  whatever their age — a finished or discarded job is not late. */
function levelFor(
  project: { status: string; column: string },
  created: Date | null,
  now: number,
): AgingLevel {
  if (project.status !== 'active' || project.column === 'done' || created === null) return 0;
  return agingLevel(now - created.getTime());
}

/** The timestamp's colour class, with no font weight. */
export function agingColorCls(
  project: { status: string; column: string },
  created: Date | null,
  now: number = Date.now(),
): string {
  return LEVEL_COLOR[levelFor(project, created, now)];
}

/** The timestamp's text class for one card. Level 6 adds weight: the final
 *  alarm is typographic, not animated. */
export function agingTextCls(
  project: { status: string; column: string },
  created: Date | null,
  now: number = Date.now(),
): string {
  const level = levelFor(project, created, now);
  return level === 6 ? `${LEVEL_COLOR[6]} font-medium` : LEVEL_COLOR[level];
}

export type AgeAnchor = 'accepted' | 'created';

/** Which timestamp a project's age is measured from, and what to call it.
 *
 *  An accepted job's clock starts at the client's go-ahead, not the quote
 *  draft (2026-08-02 age-from-acceptance spec). A null or unparseable stamp —
 *  imported already-accepted, or pre-migration with no event — falls back to
 *  created_at, and the stamp is ignored entirely while the quote is not
 *  accepted. Shared by the board card and the detail panel it morphs into, so
 *  the two can never disagree mid-transition. */
export function ageAnchor(project: {
  quote_status: string | null;
  quote_accepted_at: string | null;
  created_at: string;
}): { anchor: AgeAnchor; raw: string | null; at: Date | null } {
  if (project.quote_status === 'accepted') {
    const at = parseUTCDateStrict(project.quote_accepted_at);
    if (at) return { anchor: 'accepted', raw: project.quote_accepted_at, at };
  }
  return { anchor: 'created', raw: project.created_at, at: parseUTCDateStrict(project.created_at) };
}
