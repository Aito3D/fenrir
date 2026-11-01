import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../utils';
import { HoursChart } from '../../components/maintenance/hours/HoursChart';
import type { HourEvent, HourMachine } from '../../api/client';
import type { MachineSeries } from '../../utils/hoursSeries';

// jsdom has no layout, so ResponsiveContainer renders nothing; pin a size.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={800} height={300} />
    ),
  };
});

const machine = (id: number, trust: HourMachine['trust']): HourMachine => ({
  id, printer_id: id, name: `M${id}`, model: 'X1C', retired: false, current_hours: 500, trust,
  last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null,
  purchase_price: null, purchase_date: null, added_on: null,
});
const seriesFor = (): MachineSeries => ({
  manual: [{ date: '2026-01-01', hours: 100 }, { date: '2026-04-01', hours: 300 }],
  auto: [{ date: '2026-04-10', hours: 330 }, { date: '2026-04-20', hours: 360 }],
});

function setup(over: Partial<ComponentProps<typeof HoursChart>> = {}) {
  const machines = over.machines ?? [machine(1, 'calibrated')];
  const props: ComponentProps<typeof HoursChart> = {
    mode: 'cumulative',
    machines,
    hidden: new Set(),
    series: new Map(machines.map((m) => [m.id, seriesFor()])),
    colors: new Map(machines.map((m) => [m.id, '#00ff00'])),
    today: '2026-04-25',
    range: 'all',
    focusId: null,
    onFocus: vi.fn(),
    events: [],
    gap: { lastDate: '2026-04-01', days: 10 },
    ...over,
  };
  return render(<HoursChart {...props} />);
}

describe('HoursChart', () => {
  it('draws the dashed tail only for the auto points the series carries', () => {
    const a = setup({ series: new Map([[1, { ...seriesFor(), auto: [] }]]) });
    expect(a.container.querySelectorAll('path.recharts-line-curve[stroke-dasharray="4 4"]')).toHaveLength(0);
    a.unmount();
    const b = setup();
    expect(b.container.querySelectorAll('path.recharts-line-curve[stroke-dasharray="4 4"]')).toHaveLength(1);
  });

  it('draws the gap band when the last reading is older than 30 days', () => {
    const a = setup({ gap: { lastDate: '2026-02-01', days: 190 } });
    expect(a.container.querySelector('.recharts-reference-area')).not.toBeNull();
    a.unmount();
    const b = setup({ gap: { lastDate: '2026-04-15', days: 10 } });
    expect(b.container.querySelector('.recharts-reference-area')).toBeNull();
    expect(b.container.querySelector('.recharts-reference-line')).not.toBeNull();
  });

  it('fades non-focused lines', () => {
    const { container } = setup({ machines: [machine(1, 'calibrated'), machine(2, 'calibrated')], focusId: 1 });
    const manual = [...container.querySelectorAll('path.recharts-line-curve:not([stroke-dasharray])')];
    expect(manual).toHaveLength(2);
    expect(manual[0].getAttribute('stroke-opacity')).not.toBe('0.2');
    expect(manual[0].getAttribute('stroke-width')).toBe('3');
    expect(manual[1].getAttribute('stroke-opacity')).toBe('0.2');
  });

  it('draws a forecast line for a machine with a current pace', () => {
    const a = setup({ machines: [machine(1, 'calibrated')] });
    expect(a.container.querySelectorAll('.hours-forecast')).toHaveLength(1);
    a.unmount();
    const b = setup({ machines: [machine(1, 'calibrated')], today: '2026-09-01' });
    expect(b.container.querySelectorAll('.hours-forecast')).toHaveLength(0);
  });

  it('draws the next service reference for the focused calibrated machine', () => {
    const machines = [{ ...machine(1, 'calibrated'), next_service_hours: 2500 }, machine(2, 'calibrated')];
    const a = setup({ machines, focusId: 1 });
    expect(a.container.querySelector('.hours-service-line')).not.toBeNull();
    expect(a.container.textContent).toContain('next service at 2,500 h · around');
    a.unmount();
    const b = setup({ machines, focusId: 2 });
    expect(b.container.querySelector('.hours-service-line')).toBeNull();
    b.unmount();
    const c = setup({ machines, focusId: null });
    expect(c.container.querySelector('.hours-service-line')).toBeNull();
  });

  it('same age mode starts every machine at day 0', () => {
    const machines = [machine(1, 'calibrated'), machine(2, 'calibrated')];
    const series = new Map<number, MachineSeries>([
      [1, seriesFor()],
      [2, { manual: [{ date: '2026-03-01', hours: 40 }, { date: '2026-04-01', hours: 90 }], auto: [] }],
    ]);
    const { container } = setup({ mode: 'sameAge', machines, series });
    const lines = container.querySelectorAll('.recharts-line');
    expect(lines).toHaveLength(2);
    const groups = container.querySelectorAll('.recharts-line-dots');
    expect(groups).toHaveLength(2);
    const firstCx = [...groups].map((g) => Number(g.querySelector('.recharts-line-dot')?.getAttribute('cx')));
    expect(firstCx[0]).toBeCloseTo(firstCx[1], 3);
    const allCx = [...container.querySelectorAll('.recharts-line-dot')].map((d) => Number(d.getAttribute('cx')));
    expect(firstCx[0]).toBe(Math.min(...allCx));
    expect(container.querySelector('.hours-forecast')).toBeNull();
    expect(container.querySelector('[data-testid="hours-same-age-hint"]')).toBeNull();
  });

  it('shows the same age hint when more than four machines are visible', () => {
    const machines = [1, 2, 3, 4, 5].map((id) => machine(id, 'calibrated'));
    const { container } = setup({ mode: 'sameAge', machines });
    expect(container.querySelector('[data-testid="hours-same-age-hint"]')).not.toBeNull();
    expect(container.querySelectorAll('.recharts-line')).toHaveLength(5);
  });

  it('renders one tick per visible event', () => {
    const machines = [machine(1, 'calibrated'), machine(2, 'calibrated')];
    const events: HourEvent[] = [
      { id: 1, machine_id: 1, event_date: '2026-02-01', kind: 'note', label: 'Belt changed', source_id: null },
      { id: 2, machine_id: 1, event_date: '2026-03-01', kind: 'maintenance', label: 'Service', source_id: null },
      { id: 3, machine_id: 2, event_date: '2026-03-01', kind: 'calibrated', label: 'Calibrated', source_id: null },
      { id: 4, machine_id: 1, event_date: '2026-01-01', kind: 'added', label: 'Added', source_id: null },
    ];
    const { container } = setup({ machines, hidden: new Set([2]), events });
    const ticks = container.querySelectorAll('.hours-event-tick');
    expect(ticks).toHaveLength(2);
    expect(ticks[0].querySelector('title')?.textContent).toBe('Belt changed');
    expect(ticks[1].getAttribute('data-kind')).toBe('maintenance');
  });

  it('ticks sit on their curve', () => {
    const machines = [machine(1, 'calibrated')];
    const series = new Map<number, MachineSeries>([
      [1, { manual: [{ date: '2026-01-01', hours: 100 }, { date: '2026-04-01', hours: 2873 }], auto: [] }],
    ]);
    const events: HourEvent[] = [{ id: 1, machine_id: 1, event_date: '2026-04-01', kind: 'note', label: 'On the reading', source_id: null }];
    const { container } = setup({ machines, series, events });
    const rect = container.querySelector('.hours-event-tick rect')!;
    const middle = Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2;
    const dots = container.querySelectorAll('.recharts-line-dot');
    const cy = Number(dots[dots.length - 1].getAttribute('cy'));
    expect(Math.abs(middle - cy)).toBeLessThan(1);
  });
});
