import type { TFunction } from 'i18next';
import type { AitoColumnId, AitoTracking } from '../api/client';

/** The public tracking page speaks the app's i18n (`aito.track.*` in every
 *  locale) — but its audience is the client, not the operator, and most
 *  clients are in Tahiti: when the browser asks for no language the app
 *  ships, the page falls back to French, not to i18next's English. */
export const TRACKING_FALLBACK_LANGUAGE = 'fr';

/** The language the page should switch to on mount, or null to keep the
 *  detector's choice. A remembered choice (`stored`) always wins; then any
 *  browser language the app supports, matched on the full tag or its base
 *  (`fr-PF` → `fr`); only when nothing matches does French step in. */
export function trackingDefaultLanguage(
  stored: string | null,
  navigatorLanguages: readonly string[],
  supported: readonly string[],
): string | null {
  if (stored && supported.includes(stored)) return null;
  const matches = navigatorLanguages.some((tag) => supported.includes(tag) || supported.includes(tag.split('-')[0]));
  return matches ? null : TRACKING_FALLBACK_LANGUAGE;
}

const STAGE_KEYS: Exclude<AitoColumnId, 'done'>[] = ['devis', 'waiting', 'scan', 'model', 'print', 'finish'];

/** A column's index on the rail (0 = Devis … 6 = Done), -1 for an unknown one. */
export const trackStageIndex = (column: AitoColumnId): number => [...STAGE_KEYS, 'done'].indexOf(column);

/** The seven stages in board order. The LAST one is named by how this order
 *  ends — "Shipped" for a shipment, "Collected" otherwise — because "Done"
 *  tells the client nothing they can picture. */
export function trackStages(shipped: boolean, t: TFunction): { id: AitoColumnId; label: string }[] {
  return [
    ...STAGE_KEYS.map((id) => ({ id, label: t(`aito.track.stages.${id}`) })),
    { id: 'done', label: t(shipped ? 'aito.track.stages.shipped' : 'aito.track.stages.pickedUp') },
  ];
}

/** A day (`2026-09-20`) or a naive UTC timestamp, as "20 septembre 2026" /
 *  "20 September 2026" in the page's language. A bare day is pinned to
 *  noon so no timezone can roll it over. */
export function longDate(iso: string, lng: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return new Intl.DateTimeFormat(lng, { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(day ? `${iso}T12:00:00` : `${iso}Z`),
  );
}

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "aujourd'hui à 09:42" / "hier à 18:20" / "le 3 septembre à 11:05", in
 *  the browser's local time and the page's language, from a naive UTC
 *  timestamp. */
export function updatedAt(isoUtc: string, t: TFunction, lng: string, now: Date = new Date()): string {
  const at = new Date(`${isoUtc}Z`);
  const time = new Intl.DateTimeFormat(lng, { hour: '2-digit', minute: '2-digit' }).format(at);
  if (sameLocalDay(at, now)) return t('aito.track.updatedToday', { time });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(at, yesterday)) return t('aito.track.updatedYesterday', { time });
  const date = new Intl.DateTimeFormat(lng, { day: 'numeric', month: 'long' }).format(at);
  return t('aito.track.updatedOn', { date, time });
}

/** Titles are SHORT: the client scans "En fabrication" faster than a
 *  sentence; the sub-line carries the human voice. The waybill number is
 *  quoted verbatim once it exists — it is what the client hands over at
 *  the Air Tahiti freight counter. */
export function statusCopy(data: AitoTracking, t: TFunction, lng: string): { title: string; sub: string } {
  const pair = (key: string) => ({ title: t(`aito.track.status.${key}Title`), sub: t(`aito.track.status.${key}Sub`) });
  switch (data.column) {
    case 'devis':
      return pair('devis');
    case 'waiting':
      return pair('waiting');
    case 'finish':
      return pair('finish');
    case 'done':
      if (data.shipping) {
        const { island, service, lta } = data.shipping;
        const sub = t('aito.track.status.shippedSub', { island, service });
        return { title: t('aito.track.status.shippedTitle'), sub: lta ? `${sub} ${t('aito.track.status.shippedLta', { lta })}` : sub };
      }
      if (data.done_at) {
        return { title: t('aito.track.status.pickedUpTitle'), sub: t('aito.track.status.pickedUpSub', { date: longDate(data.done_at, lng) }) };
      }
      return pair('done');
    default:
      return pair('working');
  }
}

const PRODUCTION: readonly AitoColumnId[] = ['scan', 'model', 'print'];
const BEFORE_FINISH: readonly AitoColumnId[] = ['devis', 'waiting', 'scan', 'model', 'print'];

/** What the date slot says — a real date, an honest "updating", a promise
 *  while in production, or nothing. Never a stale date shown as if all
 *  were well, never a fabricated one. Once the order is ready or over
 *  (Finish / Done), the date is dropped entirely — the state already
 *  says it all. */
export function etaCopy(
  data: AitoTracking,
  t: TFunction,
  lng: string,
  today: Date = new Date(),
): { kind: 'date' | 'updating' | 'soon' | 'none'; text: string } {
  if (!BEFORE_FINISH.includes(data.column)) return { kind: 'none', text: '' }; // ready or over: the state says it all
  if (data.due_date) {
    const passed = new Date(`${data.due_date}T23:59:59`) < today;
    return passed ? { kind: 'updating', text: t('aito.track.etaUpdating') } : { kind: 'date', text: longDate(data.due_date, lng) };
  }
  return PRODUCTION.includes(data.column) ? { kind: 'soon', text: t('aito.track.etaSoon') } : { kind: 'none', text: '' };
}

/** The first-load choreography's clock, in ms — one rail node per beat,
 *  then the state card, then the details. Read by TrackingRail and
 *  AitoTrackPage so the two can never drift; the shapes live in index.css
 *  (`.animate-track-*`). */
export const TRACK_MOTION = {
  start: 80, // the first node pops here
  beat: 90, // each next node, one beat later
  land: 60, // the current node lands this much after its beat
  state: 260, // the state card rises this much after the current node's beat
  parts: 100, // the parts list starts this much after the state card
  partStep: 50, // …and cascades at this step (capped at 7 steps)
  invoice: 250, // the invoice rises this much after the state card
  halo: 280, // the done halo fires this much after the state card
  reveal: 40, // "Voir les n pièces": step between revealed parts
  footer: 400, // the footer drops in this much after the state card
  footerAlone: 200, // …or this much after a 404 / error page paints
  invalidTitle: 0, // the invalid-link page: title, then body, then the way back in
  invalidBody: 60,
  invalidLink: 120,
} as const;

/** When rail node `i` pops, in ms after the data lands. `origin` is the
 *  first node that moves: 0 on the first load (the whole walk), or the
 *  node that was current before an advance — a refetch that brought a
 *  later stage replays the walk from there only, never from Devis. */
export const trackNodeDelay = (i: number, origin = 0) => TRACK_MOTION.start + (i - origin) * TRACK_MOTION.beat;

/** When the state card rises, for a rail whose current node is `current`. */
export const trackStateDelay = (current: number, origin = 0) => trackNodeDelay(current, origin) + TRACK_MOTION.state;

/** The code-entry page's clock (ms). Title and hint rise first, the six
 *  squares follow one 55 ms beat apart from `cells`, and `leaveAt` is when a
 *  recognised code may navigate: the squares fill one after another
 *  (45 ms apart, 260 ms each) and the row lifts away over the last 260 ms —
 *  the CSS delays under "tracking code entry" in index.css add up to it. */
export const ENTRY_MOTION = {
  title: 0,
  hint: 60,
  cells: 180,
  leaveAt: 760,
} as const;
