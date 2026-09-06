/** The follow-ups strip's rules: who is the operator waiting on today.
 *
 *  Pure and client-side, over the same cached board list the columns render,
 *  so an optimistic write (contact marked, quote accepted) moves a count in
 *  the same render. Spec: docs/superpowers/specs/2026-09-04-aito-followups-strip-design.md.
 *  Written to be mirrored in Python if a morning push ever wants it. */

import { ageAnchor } from './aitoAging';
import { needsClientContact } from './aitoBoard';
import { parseUTCDateStrict, parseLocalDateKey } from './date';
import type { AitoProject } from '../api/client';

export type FollowupKey = 'quoteOut' | 'notTold' | 'notCollected' | 'unpaid';

/** Fixed chip order. */
export const FOLLOWUP_KEYS: FollowupKey[] = ['quoteOut', 'notTold', 'notCollected', 'unpaid'];

export interface FollowupBucket {
  key: FollowupKey;
  /** Project ids, longest wait first. */
  ids: number[];
  /** The first entry's wait in whole days, 0 when empty. */
  maxDays: number;
}

export interface FollowupThresholds {
  quoteDays: number;
  pickupDays: number;
}

const DAY_MS = 86_400_000;
const AWAY = new Set(['sent', 'viewed', 'expired']);
// Books occasionally echoes a non-ISO due date (e.g. "10/02/2026"); a string
// compare against `today` would misread it as always overdue. Same shape as
// aitoAging.ts's ISO_DATE.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between an ISO stamp and `now`, never negative; null when the
 *  stamp is missing or unparseable. */
export function daysSince(iso: string | null, now: number): number | null {
  const at = parseUTCDateStrict(iso);
  if (!at) return null;
  return Math.max(0, Math.floor((now - at.getTime()) / DAY_MS));
}

type Rule = (project: AitoProject, t: FollowupThresholds, now: number, today: string) => number | null;

const RULES: Record<FollowupKey, Rule> = {
  quoteOut: (p, t, now) => {
    if (!p.quote_status || !AWAY.has(p.quote_status)) return null;
    const days = daysSince(p.quote_sent_at, now);
    if (days === null) return null;
    // Expired: Books already waited its full term, so it is overdue on day zero.
    return p.quote_status === 'expired' || days >= t.quoteDays ? days : null;
  },
  notTold: (p, _t, now) => {
    if (!needsClientContact(p)) return null;
    return daysSince(ageAnchor(p).raw, now) ?? 0;
  },
  notCollected: (p, t, now) => {
    if (p.column !== 'finish' || p.client_contacted_at === null || p.shipping_island !== null) return null;
    const days = daysSince(p.client_contacted_at, now);
    return days !== null && days >= t.pickupDays ? days : null;
  },
  unpaid: (p, _t, _now, today) => {
    if (!(p.invoice_balance !== null && p.invoice_balance > 0) || !p.invoice_due_date) return null;
    if (!ISO_DATE.test(p.invoice_due_date)) return null;
    if (!(p.invoice_due_date < today)) return null;
    // Calendar-day difference, not a wall-clock one: the due date and
    // `today` are both local calendar days, so "overdue" flips at local
    // midnight (like the due-date badge), and the count must agree — a UTC
    // comparison here could read a day short (ahead of UTC) or long (behind
    // it). `Math.round`, not floor, so a DST day doesn't drop a day.
    return Math.max(0, Math.round((parseLocalDateKey(today).getTime() - parseLocalDateKey(p.invoice_due_date).getTime()) / DAY_MS));
  },
};

/** `now` is the wall-clock epoch (ms) used to age every stamp except the
 *  unpaid rule's due date; `today` is the operator's local calendar day
 *  (`YYYY-MM-DD`, e.g. `localDateKey(new Date())`) and is consulted only by
 *  the unpaid rule, since invoice due dates are calendar days. */
export function followups(
  projects: AitoProject[],
  thresholds: FollowupThresholds,
  now: number,
  today: string,
): Record<FollowupKey, FollowupBucket> {
  const live = projects.filter((p) => p.status === 'active' && p.column !== 'done');
  const out = {} as Record<FollowupKey, FollowupBucket>;
  for (const key of FOLLOWUP_KEYS) {
    const hits: Array<{ id: number; days: number }> = [];
    for (const p of live) {
      const days = RULES[key](p, thresholds, now, today);
      if (days !== null) hits.push({ id: p.id, days });
    }
    hits.sort((a, b) => b.days - a.days || a.id - b.id);
    out[key] = { key, ids: hits.map((h) => h.id), maxDays: hits[0]?.days ?? 0 };
  }
  return out;
}
