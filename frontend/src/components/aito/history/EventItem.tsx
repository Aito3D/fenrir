import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EVENT_LABEL_KEY, dotClass } from './eventKinds';
import type { AitoEvent } from '../../../api/client';
import { parseUTCDate } from '../../../utils/date';

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}

/** `detail` is stored on every event but the label alone only carries the
 *  full story for a handful of kinds — the ones with nothing else to show:
 *
 *  - `zoho.comment` carries Books' verbatim text in `detail.text`. It is the
 *    lossless fallback tier for a comment the pattern table did not
 *    recognise, and without this the bare label "Comment in Zoho Books"
 *    tells the reader nothing.
 *  - `sync.failed` (and the two ambiguous-outcome kinds that share its
 *    shape) carries the reason in `detail.error`, or the two sides of a
 *    disagreement in `detail.ours`/`detail.theirs` — without this a card
 *    that failed last week can say THAT it failed but never WHY.
 *
 *  `detail` is `Record<string, unknown> | null` from the wire, so every read
 *  here is narrowed before use — never rendered as an object.
 *
 *  Deliberately returns plain text, not a translated sentence: the brief for
 *  this fix is explicit that no new i18n keys may be added, so the conflict
 *  sides are shown as bare values rather than composed into a phrase. */
function detailText(kind: string, detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;

  if (kind === 'zoho.comment') {
    return typeof detail.text === 'string' && detail.text ? detail.text : null;
  }

  if (kind === 'sync.failed') {
    return typeof detail.error === 'string' && detail.error ? detail.error : null;
  }

  if (kind === 'sync.conflict' || kind === 'sync.status_rejected') {
    const hasSides =
      (typeof detail.ours === 'string' && detail.ours) || (typeof detail.theirs === 'string' && detail.theirs);
    return hasSides ? `${formatValue(detail.ours)} → ${formatValue(detail.theirs)}` : null;
  }

  return null;
}

/** The gap from the PREVIOUS (older) entry to this one, in the reader's locale.
 *
 *  Rendered at Story depth only, where the entries are sparse enough for the
 *  gap between them to be the story: "accepted, 1 day after sending", "3 days
 *  in Model". At Detail and Everything the rows are minutes apart and it would
 *  be noise.
 *
 *  Intl.RelativeTimeFormat with a POSITIVE value is deliberate and it is not a
 *  sign error: the list runs newest-first, so this label sits below its own
 *  entry and above the older one, and read from that older entry forwards the
 *  phrasing "in 3 days" is the correct direction. It also means the gutter
 *  costs no new translation keys — the Intl data is the translation. */
function ElapsedGutter({ from, to, lang }: { from: Date; to: Date; lang: string }) {
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  if (seconds < 60) return null; // same minute — nothing worth a row

  const format = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    seconds >= 86_400
      ? [Math.round(seconds / 86_400), 'day']
      : seconds >= 3_600
        ? [Math.round(seconds / 3_600), 'hour']
        : [Math.round(seconds / 60), 'minute'];

  return <p className="pl-4 pb-2 text-[11px] text-bambu-gray/70 italic">{format.format(value, unit)}</p>;
}

/** One entry: who, what, the diff, and when.
 *
 *  A kind with no label key renders its raw string rather than an empty row —
 *  the server can learn a new kind before this map does, and a silently blank
 *  entry would be worse than an ugly one. */
export function EventItem({
  event,
  previous,
  showElapsed = false,
  animateIn = false,
}: {
  event: AitoEvent;
  /** The next-older event, for the elapsed gutter. Undefined on the last row. */
  previous?: AitoEvent;
  showElapsed?: boolean;
  /** Whether this row is arriving now (first load, a note just written, a page
   *  just fetched) rather than already being on screen. Owned by the rail —
   *  see its `seenIds` ref — because only the rail can tell an arrival from a
   *  row that merely re-rendered under a new key. */
  animateIn?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const labelKey = EVENT_LABEL_KEY[event.kind];
  const label = labelKey ? t(labelKey) : event.kind;
  const at = parseUTCDate(event.occurred_at);
  const previousAt = previous ? parseUTCDate(previous.occurred_at) : null;
  const until = event.occurred_until ? parseUTCDate(event.occurred_until) : null;

  const changes = event.changes ?? [];
  const hasMany = changes.length > 1;
  const shown = expanded || !hasMany ? changes : changes.slice(0, 1);
  const detail = detailText(event.kind, event.detail);

  return (
    <li className={`relative pl-4 pb-3 ${animateIn ? 'animate-rise' : ''}`}>
      <span
        aria-hidden="true"
        // `-translate-x-1/2` centres the dot ON the rail. With `left-0` alone
        // the dot's left EDGE sat on the line, so every dot hung a full width
        // to the right of it and the rail read as two parallel elements
        // rather than one thread with beads on it.
        className={`absolute left-0 top-1.5 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${dotClass(event.kind, event.actor_class)}`}
      />
      <div className="text-sm text-white">
        {event.actor_name && <span className="font-medium">{event.actor_name} </span>}
        <span className={event.actor_name ? 'text-bambu-gray-light' : ''}>{label}</span>
        {event.subject_label && <span className="text-bambu-gray-light"> “{event.subject_label}”</span>}
        {hasMany && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="ml-1 text-xs text-bambu-gray hover:text-white"
          >
            {t('aito.history.changeCount', { count: changes.length })}
          </button>
        )}
      </div>

      {event.note && <p className="mt-0.5 text-sm text-white whitespace-pre-wrap break-words">{event.note}</p>}

      {detail && (
        <p className="mt-0.5 text-xs text-bambu-gray whitespace-pre-wrap break-words">{detail}</p>
      )}

      {shown.length > 0 && (
        <dl className="mt-0.5 text-xs text-bambu-gray">
          {shown.map((change, i) => (
            // Only the rows the expander just revealed carry the entrance: the
            // first row is keyed by its own field and stays mounted across the
            // toggle, so it would not replay anyway — but stating the index
            // keeps a collapsed row from animating if the changes ever
            // reorder. Without this the extra rows appeared on one frame and
            // the timestamp under them jumped down to meet them.
            <div key={change.field} className={`flex gap-1 ${expanded && i > 0 ? 'animate-rise' : ''}`}>
              <dt className="flex-shrink-0">{change.field}</dt>
              <dd className="min-w-0 truncate text-white">
                {formatValue(change.from)} → {formatValue(change.to)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-0.5 text-[11px] text-bambu-gray">
        {at ? at.toLocaleString(i18n.language) : '—'}
        {until && at && until.getTime() !== at.getTime() && ` – ${until.toLocaleTimeString(i18n.language)}`}
        {event.actor_class === 'client' && ` · ${t('aito.history.fromZoho')}`}
        {event.actor_class === 'system' && ` · ${t('aito.history.automatic')}`}
      </p>

      {showElapsed && previousAt && at && (
        <ElapsedGutter from={previousAt} to={at} lang={i18n.language} />
      )}
    </li>
  );
}
