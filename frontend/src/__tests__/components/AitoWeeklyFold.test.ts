import { describe, it, expect } from 'vitest';
import { weekKey, weekStart } from '../../components/aito/stats/weeklyFold';

describe('weekStart / weekKey', () => {
  it('a Monday folds to itself', () => {
    const monday = new Date(2026, 8, 14); // 2026-09-14 is a Monday
    expect(monday.getDay()).toBe(1);
    expect(weekKey(monday)).toBe('2026-09-14');
    expect(weekStart(monday).getDate()).toBe(14);
  });

  it('a Sunday folds back to the PREVIOUS Monday, not forward', () => {
    const sunday = new Date(2026, 8, 20); // 2026-09-20 is a Sunday
    expect(sunday.getDay()).toBe(0);
    expect(weekKey(sunday)).toBe('2026-09-14');
  });

  it('folds across a month boundary', () => {
    // 2026-10-01 is a Thursday; its week started Monday 2026-09-28.
    const thursday = new Date(2026, 9, 1);
    expect(thursday.getDay()).toBe(4);
    expect(weekKey(thursday)).toBe('2026-09-28');
  });

  it('folds across a year boundary', () => {
    // 2027-01-01 is a Friday; its week started Monday 2026-12-28.
    const friday = new Date(2027, 0, 1);
    expect(friday.getDay()).toBe(5);
    expect(weekKey(friday)).toBe('2026-12-28');
  });
});
