import { useMemo } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Building2, User } from 'lucide-react';
import type { AitoProject, AitoStats } from '../../../api/client';
import { daysSince, type FollowupBucket, type FollowupKey } from '../../../utils/aitoFollowups';
import { ageAnchor, dueDateDays } from '../../../utils/aitoAging';
import { isFinished } from '../../../utils/aitoBoard';
import { parseLocalDateKey } from '../../../utils/date';
import { eyebrowCls } from '../panelTypography';
import { useStatsFormat } from './useStatsFormat';

/** What the page hands the brief: the board list and the follow-up buckets
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
  company: boolean;
  what: string;
  wait: string;
  waitDays: number;
  amount: string | null;
}

type ListKind = 'chase' | 'tell' | 'collect';

const TONE: Record<ListKind, { dot: string; wait: string }> = {
  chase: { dot: 'bg-amber-400', wait: 'text-amber-400' },
  tell: { dot: 'bg-sky-400', wait: 'text-white' },
  collect: { dot: 'bg-status-error', wait: 'text-status-error' },
};

/** The morning brief: one sentence that answers « what do I do today », then
 *  the three lists that are the work. Everything comes from the board list
 *  through the follow-up rules; nothing here waits on the statistics call. */
export function Briefing({ brief, stats }: { brief: BriefInput | null; stats?: AitoStats }) {
  const { t, i18n } = useTranslation();
  const { money, days } = useStatsFormat();

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
      return { id: p.id, who: who(p), company: !!p.client_is_company, what: firstLine(p), wait: wait(n), waitDays: n, amount: p.quote_total === null ? null : money(p.quote_total) };
    });
    const tell: Row[] = pick(['notTold', 'notCollected']).map((p) => {
      const collected = p.column === 'finish' && p.client_contacted_at !== null;
      const n = (collected ? daysSince(p.client_contacted_at, brief.now) : daysSince(ageAnchor(p).raw, brief.now)) ?? 0;
      return {
        id: p.id,
        who: who(p),
        company: !!p.client_is_company,
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
      return { id: p.id, who: who(p), company: !!p.client_is_company, what: firstLine(p), wait: t('aito.stats.brief.late', { days: n }), waitDays: n, amount: money(p.invoice_balance ?? 0) };
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
  const finished = stats?.throughput?.done ?? null;
  const finishedBefore = stats?.previous?.done ?? null;

  return (
    <section data-testid="aito-stats-brief" className="space-y-4">
      <div className="space-y-1.5 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 py-3.5">
        <p className={`${eyebrowCls} text-bambu-gray`}>
          <span className="capitalize">{dateLine}</span>
          {inProduction !== null && <> · {t('aito.inProduction', { count: inProduction })}</>}
        </p>
        <h2 className="max-w-[30ch] text-[28px] font-semibold leading-tight tracking-[-0.02em] text-white text-balance">
          {allClear ? (
            t('aito.stats.brief.allClear')
          ) : (
            <Trans
              i18nKey="aito.stats.brief.sentence"
              values={{
                chase: lists.chase.length ? t('aito.stats.brief.chase', { count: lists.chase.length }) : t('aito.stats.brief.chaseNone'),
                tell: lists.tell.length ? t('aito.stats.brief.tell', { count: lists.tell.length }) : t('aito.stats.brief.tellNone'),
                collect: lists.collect.length ? t('aito.stats.brief.collect', { amount: money(collectTotal) }) : t('aito.stats.brief.collectNone'),
              }}
              components={{
                chase: <b className={lists.chase.length ? 'font-semibold text-amber-400' : 'font-semibold'} />,
                tell: <b className="font-semibold" />,
                collect: <b className={lists.collect.length ? 'font-semibold text-status-error' : 'font-semibold'} />,
              }}
            />
          )}
        </h2>
        <p className="text-sm text-bambu-gray-light">
          {dueSoon > 0 ? t('aito.stats.brief.due', { count: dueSoon }) : t('aito.stats.brief.dueNone')}
          {finished !== null && (
            <>
              {' '}
              {t('aito.stats.brief.finished', { count: finished })}
              {finishedBefore !== null && finished > finishedBefore && ` ${t('aito.stats.brief.more', { count: finished - finishedBefore })}`}
              {finishedBefore !== null && finished < finishedBefore && ` ${t('aito.stats.brief.fewer', { count: finishedBefore - finished })}`}
            </>
          )}
          {stats?.throughput?.lead_days != null && ` ${t('aito.stats.brief.lead', { days: days(stats.throughput.lead_days) })}`}
        </p>
      </div>

      {!allClear && (
        <div className="grid gap-4 md:grid-cols-3">
          <List kind="chase" heading={t('aito.stats.brief.chaseHeading')} rows={lists.chase} onOpen={brief?.onOpenCard} />
          <List kind="tell" heading={t('aito.stats.brief.tellHeading')} rows={lists.tell} onOpen={brief?.onOpenCard} />
          <List kind="collect" heading={t('aito.stats.brief.collectHeading')} rows={lists.collect} onOpen={brief?.onOpenCard} />
        </div>
      )}
    </section>
  );
}

/** A list is a board column and each row a board card — the same shells the
 *  operator drags all day, so the brief reads as the board's own to-do rather
 *  than a separate report. The card is a button: it opens the panel. */
function List({ kind, heading, rows, onOpen }: { kind: ListKind; heading: string; rows: Row[]; onOpen?: (id: number) => void }) {
  const { t } = useTranslation();
  const shown = rows.slice(0, ROW_CAP);
  return (
    <div
      data-testid={`aito-brief-${kind}`}
      className="flex min-w-0 flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary/40"
    >
      <h3 className="flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-bambu-gray-light">
        <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${TONE[kind].dot}`} />
        <span className="truncate">{heading}</span>
        <span className="ml-auto min-w-[1.5rem] rounded-full bg-bambu-dark-tertiary px-1.5 py-0.5 text-center text-xs font-medium tabular-nums text-bambu-gray-light">
          {rows.length}
        </span>
      </h3>
      {rows.length === 0 ? (
        <p className="mx-2 mb-2 rounded-lg border border-dashed border-bambu-dark-tertiary px-3 py-3 text-xs text-bambu-gray">
          {t(`aito.stats.brief.${kind}Empty`)}
        </p>
      ) : (
        <ul className="space-y-2 px-2 pb-2">
          {shown.map((row) => {
            const Icon = row.company ? Building2 : User;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => onOpen?.(row.id)}
                  className="card-shadow block w-full rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-bambu-green/40 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40 motion-reduce:hover:translate-y-0"
                >
                  <span className="flex items-center gap-2 px-3 pt-2.5">
                    <Icon aria-hidden="true" strokeWidth={2.5} className="h-3.5 w-3.5 shrink-0 text-white" />
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em] text-white">{row.who}</span>
                  </span>
                  <span className="block truncate px-3 pt-1 text-sm text-bambu-gray-light">{row.what}</span>
                  <span className="flex items-center justify-between gap-2 px-3 pb-2 pt-1.5 text-xs">
                    <span className={`font-semibold tabular-nums ${TONE[kind].wait}`}>{row.wait}</span>
                    <span className="text-bambu-gray tabular-nums">{row.amount ?? ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {rows.length > ROW_CAP && (
            <li className="px-1 text-xs text-bambu-gray">{t('aito.stats.brief.andMore', { count: rows.length - ROW_CAP })}</li>
          )}
        </ul>
      )}
    </div>
  );
}
