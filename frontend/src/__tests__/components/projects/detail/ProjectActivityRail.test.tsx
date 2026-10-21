/** The activity rail's arrival animation: events that land while the rail is on screen rise in
 *  (`animate-rise`); the first load, a loading -> loaded transition and a refetch of the same
 *  events do not. Timestamps are years in the past, so every event sits under "Earlier" whatever
 *  the clock says (no fake timers needed). */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../../utils';
import { ProjectActivityRail } from '../../../../components/projects/detail/ProjectActivityRail';
import type { TimelineEvent } from '../../../../api/client';

const ev = (title: string, timestamp: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
  event_type: 'queued',
  timestamp,
  title,
  description: null,
  metadata: null,
  ...over,
});

const base = (): TimelineEvent[] => [
  ev('Printed bracket', '2020-03-02T10:00:00Z', { event_type: 'print_completed' }),
  ev('Queued bracket', '2020-03-01T10:00:00Z'),
];

const rail = (events: TimelineEvent[] | undefined, isLoading = false) => (
  <ProjectActivityRail events={events} isLoading={isLoading} timeFormat="24h" />
);

/** The activity-event li's titles that carry the entrance class, in rail order. */
const risen = () =>
  screen
    .getAllByTestId('activity-event')
    .filter((li) => li.classList.contains('animate-rise'))
    .map((li) => li.querySelector('p')?.textContent);

describe('ProjectActivityRail arrivals', () => {
  it('does not animate the events of the first load', () => {
    render(rail(base()));
    expect(screen.getAllByTestId('activity-event')).toHaveLength(2);
    expect(risen()).toEqual([]);
  });

  it('rises in only the event that arrives after the first render', () => {
    const { rerender } = render(rail(base()));
    rerender(rail([ev('Print started', '2020-03-03T10:00:00Z', { event_type: 'print_started' }), ...base()]));
    expect(screen.getAllByTestId('activity-event')).toHaveLength(3);
    expect(risen()).toEqual(['Print started']);
  });

  it('takes the baseline when loading ends: nothing is flagged by the load itself', () => {
    const { rerender } = render(rail(undefined, true));
    expect(screen.queryByTestId('activity-event')).not.toBeInTheDocument();
    rerender(rail(base(), false));
    expect(screen.getAllByTestId('activity-event')).toHaveLength(2);
    expect(risen()).toEqual([]);
    // the rail is now live: a later event still rises
    rerender(rail([ev('Print started', '2020-03-03T10:00:00Z'), ...base()], false));
    expect(risen()).toEqual(['Print started']);
  });

  it('ignores events that are present while still loading', () => {
    const { rerender } = render(rail(base(), true));
    rerender(rail(base(), false));
    expect(risen()).toEqual([]);
  });

  it('keys events by content, not object identity: a refetch of the same events flags nothing', () => {
    const { rerender } = render(rail(base()));
    rerender(rail(base()));
    expect(risen()).toEqual([]);
    // the same timestamp and type with another title is another event
    rerender(rail([ev('Queued bracket (2)', '2020-03-01T10:00:00Z'), ...base()]));
    expect(risen()).toEqual(['Queued bracket (2)']);
  });

  it('a different description makes a different event', () => {
    const { rerender } = render(rail(base()));
    rerender(rail([...base(), ev('Queued bracket', '2020-03-01T10:00:00Z', { description: 'second plate' })]));
    expect(risen()).toEqual(['Queued bracket']);
    expect(screen.getByText('second plate').closest('li')).toHaveClass('animate-rise');
  });
});
