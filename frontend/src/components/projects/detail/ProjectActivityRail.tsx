import { useMemo, useState, type ElementType } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, History, ListTodo, Loader2, Plus, Printer, XCircle } from 'lucide-react';
import type { TimelineEvent } from '../../../api/client';
import { formatDateTime, formatRelativeTime, type TimeFormat } from '../../../utils/date';
import { ProjectPanel } from './ProjectPanel';
import { groupTimeline, type TimelineDay } from './timelineGroups';
import { useArrivals } from '../../../hooks/useArrivals';

// Stable identity for an event across refetches (the API carries no id).
const eventKey = (e: TimelineEvent) => `${e.timestamp}|${e.event_type}|${e.title}|${e.description ?? ''}`;

/** Events shown before "Show all"; the page fetches 20. */
const ACTIVITY_PREVIEW = 10;

const NEUTRAL = 'bg-bambu-dark-tertiary text-bambu-gray';

const EVENT_LOOK: Record<string, { icon: ElementType; cls: string }> = {
  print_completed: { icon: CheckCircle, cls: 'bg-status-ok/20 text-status-ok' },
  print_failed: { icon: XCircle, cls: 'bg-status-error/20 text-status-error' },
  print_started: { icon: Printer, cls: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400' },
  queued: { icon: ListTodo, cls: NEUTRAL },
  project_created: { icon: Plus, cls: NEUTRAL },
};

const DAY_KEYS: Record<TimelineDay, string> = {
  today: 'time.today',
  yesterday: 'time.yesterday',
  earlier: 'projectDetail.timeline.earlier',
};

/** The project's activity as a vertical rail: a 2px line, one ringed icon per
 *  event on it, grouped under Today / Yesterday / Earlier. */
export function ProjectActivityRail({
  events,
  isLoading,
  timeFormat,
}: {
  events: TimelineEvent[] | undefined;
  isLoading: boolean;
  timeFormat: TimeFormat;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const total = events?.length ?? 0;
  // Events that land while the rail is on screen rise in; the first load does not.
  const arrived = useArrivals((events ?? []).map(eventKey), !isLoading);

  const groups = useMemo(() => {
    const all = groupTimeline(events ?? []);
    if (showAll) return all;
    // Keep the first ACTIVITY_PREVIEW events, in order, across the groups.
    let left = ACTIVITY_PREVIEW;
    return all
      .map((group) => {
        const take = group.events.slice(0, Math.max(left, 0));
        left -= take.length;
        return { ...group, events: take };
      })
      .filter((group) => group.events.length > 0);
  }, [events, showAll]);

  const when = (day: TimelineDay, timestamp: string) => {
    if (day === 'today') return formatRelativeTime(timestamp, timeFormat, t);
    if (day === 'yesterday') return formatDateTime(timestamp, timeFormat, { hour: '2-digit', minute: '2-digit' });
    return formatDateTime(timestamp, timeFormat, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const toggle =
    total > ACTIVITY_PREVIEW ? (
      <button
        type="button"
        onClick={() => setShowAll((v) => !v)}
        className="min-h-[44px] px-1 text-xs text-bambu-gray hover:text-white md:min-h-0"
      >
        {showAll ? t('projectDetail.timeline.showLess') : t('projectDetail.timeline.showAll', { total })}
      </button>
    ) : undefined;

  return (
    <ProjectPanel icon={History} title={t('projectDetail.timeline.title')} action={toggle} testId="project-activity">
      {isLoading ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 className="h-6 w-6 animate-spin text-bambu-green" />
        </div>
      ) : total === 0 ? (
        <p className="text-sm italic text-bambu-gray/70">{t('projectDetail.timeline.empty')}</p>
      ) : (
        <ol className="relative space-y-4 before:absolute before:bottom-1.5 before:left-[15px] before:top-1.5 before:w-0.5 before:rounded before:bg-bambu-dark-tertiary">
          {groups.map((group) => [
            <li
              key={`day-${group.day}`}
              data-testid={`activity-day-${group.day}`}
              className="relative pl-10 text-[11px] font-medium uppercase tracking-wide text-bambu-gray"
            >
              {t(DAY_KEYS[group.day])}
            </li>,
            ...group.events.map((event) => {
              const look = EVENT_LOOK[event.event_type];
              const Icon = look?.icon ?? History;
              return (
                <li key={eventKey(event)} data-testid="activity-event" className={`relative pl-10 ${arrived.has(eventKey(event)) ? 'animate-rise' : ''}`}>
                  <span className="absolute left-0 top-0 rounded-full bg-bambu-dark-secondary ring-4 ring-bambu-dark-secondary">
                    <span className={`flex h-8 w-8 items-center justify-center rounded-full ${look?.cls ?? NEUTRAL}`}>
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                  </span>
                  <div className="flex items-baseline gap-2">
                    <p className="min-w-0 text-sm text-white">{event.title}</p>
                    <time
                      dateTime={event.timestamp}
                      title={formatDateTime(event.timestamp, timeFormat)}
                      className="ml-auto whitespace-nowrap text-[11px] text-bambu-gray/70"
                    >
                      {when(group.day, event.timestamp)}
                    </time>
                  </div>
                  {event.description && <p className="mt-0.5 break-words text-xs text-bambu-gray">{event.description}</p>}
                </li>
              );
            }),
          ])}
        </ol>
      )}
    </ProjectPanel>
  );
}
