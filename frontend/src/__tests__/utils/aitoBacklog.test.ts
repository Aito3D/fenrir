import { describe, it, expect } from 'vitest';
import { printBacklog, dailyCapacityHours, formatBacklogHours } from '../../utils/aitoBacklog';
import type { AitoProject } from '../../api/client';

const p = (o: Partial<AitoProject>): AitoProject =>
  ({ status: 'active', column: 'print', quote_status: 'accepted', print_minutes_pending: 60, ...o }) as AitoProject;

describe('printBacklog', () => {
  it('sums accepted live cards only', () => {
    const minutes = printBacklog([
      p({ print_minutes_pending: 90 }),
      p({ print_minutes_pending: 30, column: 'scan' }),
      p({ print_minutes_pending: 500, quote_status: 'sent' }),
      p({ print_minutes_pending: 500, column: 'done' }),
      p({ print_minutes_pending: 500, status: 'deleted' }),
    ]);
    expect(minutes).toBe(120);
  });
});

describe('dailyCapacityHours', () => {
  it('multiplies printers by the mean daily hours, defaulting sensibly', () => {
    expect(dailyCapacityHours(3, [8, 10])).toBe(27);
    expect(dailyCapacityHours(0, [])).toBe(8);
    expect(dailyCapacityHours(2, [])).toBe(16);
  });
});

describe('formatBacklogHours', () => {
  it('keeps one decimal under ten hours and none above', () => {
    expect(formatBacklogHours(150)).toBe('2.5');
    expect(formatBacklogHours(2280)).toBe('38');
    expect(formatBacklogHours(0)).toBe('0');
  });
});
