import { describe, expect, it } from 'vitest';
import { groupTimeline, timelineDay } from '../../../../components/projects/detail/timelineGroups';

const NOW = new Date(2026, 9, 17, 0, 10, 0); // ten past midnight, local time
const local = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m, 0).toISOString();
const event = (title: string, timestamp: string) => ({ event_type: 'queued', title, description: null, metadata: null, timestamp });

describe('timelineDay', () => {
  it('buckets by local calendar day, not by 24-hour windows', () => {
    expect(timelineDay(local(17, 0, 5), NOW)).toBe('today');
    expect(timelineDay(local(16, 23, 59), NOW)).toBe('yesterday');
    expect(timelineDay(local(16, 0, 0), NOW)).toBe('yesterday');
    expect(timelineDay(local(15, 23, 59), NOW)).toBe('earlier');
  });

  it('counts a future stamp as today and junk as earlier', () => {
    expect(timelineDay(local(18, 9), NOW)).toBe('today');
    expect(timelineDay('not a date', NOW)).toBe('earlier');
  });
});

describe('groupTimeline', () => {
  it('sorts newest first and emits one group per consecutive day', () => {
    const groups = groupTimeline(
      [
        event('old', local(2, 9)),
        event('yesterday late', local(16, 22)),
        event('today', local(17, 0, 1)),
        event('yesterday early', local(16, 8)),
      ],
      NOW
    );
    expect(groups.map((g) => [g.day, g.events.map((e) => e.title)])).toEqual([
      ['today', ['today']],
      ['yesterday', ['yesterday late', 'yesterday early']],
      ['earlier', ['old']],
    ]);
  });

  it('returns no groups for no events', () => {
    expect(groupTimeline([], NOW)).toEqual([]);
  });
});
