import { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { AitoProject } from '../../../api/client';
import { daysSince, type FollowupBucket, type FollowupKey } from '../../../utils/aitoFollowups';
import { ageAnchor, dueDateDays } from '../../../utils/aitoAging';
import { isFinished } from '../../../utils/aitoBoard';
import { parseLocalDateKey } from '../../../utils/date';
import { COLUMNS } from '../columns';
import { Panel } from './primitives';
import { useStatsFormat } from './useStatsFormat';

/** What the page hands the strip: the board list and the follow-up buckets
 *  it already computes for the header pills, with the same clock, so a
 *  quote accepted in the panel leaves « Chase » in the same render. */
export interface BriefInput {
  projects: AitoProject[];
  buckets: Record<FollowupKey, FollowupBucket>;
  /** Wall-clock epoch (ms) for the day counts. */
  now: number;
  /** The operator's local calendar day, `YYYY-MM-DD`. */
  today: string;
  onOpenCard: (id: number) => void;
}

const ROW_CAP = 5;
const DAY_MS = 86_400_000;

interface Row {
  id: number;
  who: string;
  what: string;
  wait: string;
  waitDays: number;
  amount: string | null;
}

type ListKind = 'chase' | 'tell' | 'collect';

/** Each list hangs under the stage its cards sit in: quotes out are in
 *  Waiting, jobs to announce are in Finish, unpaid invoices belong to cards
 *  being printed. Column starts on the six-column strip (lg and up). */
const HANG: Record<ListKind, { dot: string; wait: string; start: string }> = {
  chase: { dot: 'bg-amber-400', wait: 'text-amber-400', start: 'lg:col-start-2' },
  collect: { dot: 'bg-status-error', wait: 'text-status-error', start: 'lg:col-start-5' },
  tell: { dot: 'bg-bambu-green', wait: 'text-white', start: 'lg:col-start-6' },
};

/** Today, above the line: the board drawn as a strip. A day line, the money
 *  on the board as one stacked bar in the stage colours, six stage cells
 *  (count, amount, oldest wait — the board's single longest wait in amber),
 *  and the to-dos hanging under the stage they belong to. Everything comes
 *  from the board list; nothing here waits on the statistics call. */
export function TodayStrip({ brief }: { brief: BriefInput | null }) {
  const { t, i18n } = useTranslation();
  const { money } = useStatsFormat();

  const cells = useMemo(() => {
    const live = (brief?.projects ?? []).filter((p) => p.status === 'active' && p.column !== 'done');
    const now = brief?.now ?? Date.now();
    return COLUMNS.map((column) => {
      const mine = live.filter((p) => p.column === column.id);
      let oldestDays = 0;
      let oldest: AitoProject | null = null;
      for (const p of mine) {
        const at = ageAnchor(p).at;
        if (!at) continue;
        const days = Math.floor((now - at.getTime()) / DAY_MS);
        if (oldest === null || days > oldestDays) {
          oldestDays = days;
          oldest = p;
        }
      }
      return {
        column,
        count: mine.length,
        total: mine.reduce((s, p) => s + (p.quote_total ?? 0), 0),
        oldestDays,
        oldest,
      };
    });
  }, [brief]);
  const boardTotal = cells.reduce((s, c) => s + c.total, 0);
  const longest = cells.reduce<(typeof cells)[number] | null>(
    (best, c) => (c.oldest && (best === null || c.oldestDays > best.oldestDays) ? c : best),
    null,
  );

  const lists = useMemo(() => {
    if (!brief) return { chase: [] as Row[], tell: [] as Row[], collect: [] as Row[] };
    const byId = new Map(brief.projects.map((p) => [p.id, p]));
    const firstLine = (p: AitoProject) => (p.description || '').split('\n')[0].trim();
    const who = (p: AitoProject) => p.client_name || t('aito.noClient');
    const pick = (keys: FollowupKey[]) => {
      const seen = new Set<number>();
      const ids: number[] = [];
      for (const key of keys) for (const id of brief.buckets[key]?.ids ?? []) if (!seen.has(id) && byId.has(id)) { seen.add(id); ids.push(id); }
      return ids.map((id) => byId.get(id)!);
    };
    const wait = (n: number) => t('aito.followups.longest', { days: n });

    const chase: Row[] = pick(['quoteOut', 'linkExpiring']).map((p) => {
      const n = daysSince(p.quote_sent_at, brief.now) ?? 0;
      return { id: p.id, who: who(p), what: firstLine(p), wait: wait(n), waitDays: n, amount: p.quote_total === null ? null : money(p.quote_total) };
    });
    const tell: Row[] = pick(['notTold', 'notCollected']).map((p) => {
      const collected = p.column === 'finish' && p.client_contacted_at !== null;
      const n = (collected ? daysSince(p.client_contacted_at, brief.now) : daysSince(ageAnchor(p).raw, brief.now)) ?? 0;
      return {
        id: p.id,
        who: who(p),
        what: collected ? t('aito.stats.brief.ready') : firstLine(p),
        wait: wait(n),
        waitDays: n,
        amount: p.quote_total === null ? null : money(p.quote_total),
      };
    });
    const collect: Row[] = pick(['unpaid']).map((p) => {
      const n = p.invoice_due_date
        ? Math.max(0, Math.round((parseLocalDateKey(brief.today).getTime() - parseLocalDateKey(p.invoice_due_date).getTime()) / DAY_MS))
        : 0;
      return { id: p.id, who: who(p), what: firstLine(p), wait: t('aito.stats.brief.late', { days: n }), waitDays: n, amount: money(p.invoice_balance ?? 0) };
    });
    const byWait = (a: Row, b: Row) => b.waitDays - a.waitDays || a.id - b.id;
    return { chase: chase.sort(byWait), tell: tell.sort(byWait), collect: collect.sort(byWait) };
  }, [brief, money, t]);

  const collectTotal = lists.collect.reduce((s, r) => s + (brief?.projects.find((p) => p.id === r.id)?.invoice_balance ?? 0), 0);
  const allClear = lists.chase.length + lists.tell.length + lists.collect.length === 0;

  const dueSoon = useMemo(() => {
    if (!brief) return 0;
    return brief.projects.filter((p) => {
      if (p.status !== 'active' || isFinished(p.column)) return false;
      const n = dueDateDays(p.due_date, brief.today);
      return n !== null && n <= 7;
    }).length;
  }, [brief]);

  const inProduction = brief ? brief.projects.filter((p) => p.status === 'active' && p.column !== 'done').length : null;
  const dateLine = new Intl.DateTimeFormat(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' }).format(
    brief ? parseLocalDateKey(brief.today) : new Date(),
  );

  const fragments: Array<{ kind: ListKind; text: string }> = [];
  if (lists.chase.length) fragments.push({ kind: 'chase', text: t('aito.stats.brief.chase', { count: lists.chase.length }) });
  if (lists.tell.length) fragments.push({ kind: 'tell', text: t('aito.stats.brief.tell', { count: lists.tell.length }) });
  if (lists.collect.length) fragments.push({ kind: 'collect', text: t('aito.stats.brief.collect', { amount: money(collectTotal) }) });
  const due = dueSoon > 0 ? t('aito.stats.strip.dueSoon', { count: dueSoon }) : null;

  return (
    <Panel
      testId="aito-stats-strip"
      className="space-y-3"
      title={
        <h3 className="text-[15px] font-semibold text-white">
          <span className="capitalize">{dateLine}</span>
          {inProduction !== null && <> · {t('aito.inProduction', { count: inProduction })}</>}
        </h3>
      }
      action={
        !allClear ? (
          <p className="text-[12.5px] text-bambu-gray-light">
            {fragments.map((f, i) => (
              <span key={f.kind}>
                {i > 0 && ' · '}
                <span className={f.kind === 'chase' ? 'text-amber-400' : f.kind === 'collect' ? 'text-status-error' : undefined}>{f.text}</span>
              </span>
            ))}
            {due && ` · ${due}`}
          </p>
        ) : undefined
      }
    >
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 text-[12.5px] text-bambu-gray-light">
          <span>
            <Trans i18nKey="aito.stats.strip.onBoard" values={{ amount: money(boardTotal) }} components={{ b: <b className="font-semibold text-white" /> }}>
              {'<b>{{amount}}</b> on the board'}
            </Trans>
          </span>
          {longest?.oldest && (
            <span data-testid="aito-strip-longest">
              <Trans
                i18nKey="aito.stats.strip.longest"
                values={{
                  name: longest.oldest.client_name || t('aito.noClient'),
                  days: t('aito.followups.longest', { days: longest.oldestDays }),
                  stage: t(longest.column.labelKey),
                }}
                components={{ who: <b className="font-medium text-amber-400" /> }}
              />
            </span>
          )}
        </div>
        <div className="flex h-2.5 gap-[2px]" aria-hidden="true" data-testid="aito-strip-money">
          {cells
            .filter((c) => c.total > 0)
            .map((c) => (
              <span
                key={c.column.id}
                data-segment={c.column.id}
                title={`${t(c.column.labelKey)} · ${money(c.total)}`}
                className={`block h-full min-w-[3px] rounded-[2px] ${c.column.dot}`}
                style={{ flexGrow: c.total }}
              />
            ))}
          {boardTotal === 0 && <span className="block h-full flex-1 rounded-[2px] bg-bambu-dark-tertiary" />}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
        {cells.map((c) => {
          const isLongest = longest !== null && c.column.id === longest.column.id;
          return (
            <div
              key={c.column.id}
              data-testid={`aito-strip-${c.column.id}`}
              className={`vt-aito-col-${c.column.id} grid min-w-0 gap-1.5 rounded-lg bg-bambu-dark px-3 py-3`}
            >
              <h4 className="flex items-center gap-1.5 truncate text-xs font-medium text-bambu-gray-light">
                <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${c.column.dot}`} />
                <span className="truncate">{t(c.column.labelKey)}</span>
              </h4>
              <p className="flex items-baseline gap-1.5 min-w-0">
                <span key={c.count} className={`text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums animate-value-tick ${c.count === 0 ? 'text-bambu-gray' : 'text-white'}`}>
                  {c.count}
                </span>
                <span className="truncate text-xs text-bambu-gray-light">
                  {c.total > 0 ? money(c.total) : c.count > 0 ? t('aito.stats.strip.noQuote') : ''}
                </span>
              </p>
              <p className={`text-[11.5px] ${isLongest ? 'font-medium text-amber-400' : 'text-bambu-gray'}`}>
                {c.oldest ? t('aito.stats.strip.oldest', { days: c.oldestDays }) : ' '}
              </p>
            </div>
          );
        })}
      </div>

      {allClear ? (
        <p
          data-testid="aito-stats-clear"
          className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg bg-bambu-dark px-4 py-3 text-[13px] text-bambu-gray-light"
        >
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-bambu-green" />
          <b className="font-medium text-white">{t('aito.stats.brief.allClear')}</b>
          {due && <span>{due}</span>}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
          {(['chase', 'collect', 'tell'] as ListKind[]).map((kind) =>
            lists[kind].length > 0 ? (
              <HangList
                key={kind}
                kind={kind}
                heading={t(`aito.stats.brief.${kind}Heading`)}
                count={kind === 'collect' ? money(collectTotal) : String(lists[kind].length)}
                rows={lists[kind]}
                onOpen={brief?.onOpenCard}
              />
            ) : null,
          )}
        </div>
      )}
    </Panel>
  );
}

/** One list under its stage. Each row is a button: it opens the card. */
function HangList({
  kind,
  heading,
  count,
  rows,
  onOpen,
}: {
  kind: ListKind;
  heading: string;
  count: string;
  rows: Row[];
  onOpen?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const shown = rows.slice(0, ROW_CAP);
  return (
    <div data-testid={`aito-brief-${kind}`} className={`grid min-w-0 content-start gap-1.5 ${HANG[kind].start}`}>
      <h4 className="flex items-center gap-1.5 px-1 text-[11.5px] font-medium text-bambu-gray-light before:mr-0.5 before:h-3.5 before:w-px before:bg-bambu-dark-tertiary before:content-['']">
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${HANG[kind].dot}`} />
        <span className="truncate">{heading}</span>
        <span className="ml-auto tabular-nums">{count}</span>
      </h4>
      <ul className="grid gap-1.5">
        {shown.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onOpen?.(row.id)}
              className="card-shadow relative grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-px rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2.5 py-2 text-left text-xs transition-[background-color,border-color] duration-150 hover:border-bambu-green/40 hover:bg-bambu-dark-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40"
            >
              <span className="col-span-2 truncate pr-4 font-medium text-white">{row.who}</span>
              <ChevronRight aria-hidden="true" className="absolute right-1.5 top-2 h-3.5 w-3.5 text-bambu-gray" />
              <span className={`font-semibold tabular-nums ${HANG[kind].wait}`}>{row.wait}</span>
              <span className="text-right text-[11px] tabular-nums text-bambu-gray">{row.amount ?? ''}</span>
              <span className="col-span-2 truncate text-[11px] text-bambu-gray">{row.what}</span>
            </button>
          </li>
        ))}
        {rows.length > ROW_CAP && (
          <li className="px-1 text-[11px] text-bambu-gray">{t('aito.stats.brief.andMore', { count: rows.length - ROW_CAP })}</li>
        )}
      </ul>
    </div>
  );
}
