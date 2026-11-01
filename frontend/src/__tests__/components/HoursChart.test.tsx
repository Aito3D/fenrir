import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../utils';
import { HoursChart } from '../../components/maintenance/hours/HoursChart';
import type { HourMachine } from '../../api/client';
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
  it('hides the auto tail for an uncalibrated machine', () => {
    const a = setup({ machines: [machine(1, 'uncalibrated')] });
    expect(a.container.querySelectorAll('path.recharts-line-curve[stroke-dasharray]')).toHaveLength(0);
    a.unmount();
    const b = setup({ machines: [machine(1, 'calibrated')] });
    expect(b.container.querySelectorAll('path.recharts-line-curve[stroke-dasharray]')).toHaveLength(1);
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
});
