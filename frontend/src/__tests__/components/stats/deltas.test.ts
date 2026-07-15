import { describe, it, expect } from 'vitest';
import { computeDelta } from '../../../components/stats/deltas';

describe('computeDelta', () => {
  it('returns null without a usable baseline', () => {
    expect(computeDelta(10, undefined, 'more-is-good')).toBeNull();
    expect(computeDelta(10, null, 'more-is-good')).toBeNull();
    expect(computeDelta(10, 0, 'more-is-good')).toBeNull();
  });

  it('computes signed percentage change', () => {
    const up = computeDelta(120, 100, 'more-is-good');
    expect(up).toEqual({ pct: 20, direction: 'up', tone: 'good' });
    const down = computeDelta(80, 100, 'more-is-good');
    expect(down?.pct).toBeCloseTo(-20);
    expect(down?.direction).toBe('down');
    expect(down?.tone).toBe('bad');
  });

  it('inverts tone for more-is-bad metrics', () => {
    expect(computeDelta(120, 100, 'more-is-bad')?.tone).toBe('bad');
    expect(computeDelta(80, 100, 'more-is-bad')?.tone).toBe('good');
  });

  it('keeps neutral metrics neutral in both directions', () => {
    expect(computeDelta(120, 100, 'neutral')?.tone).toBe('neutral');
    expect(computeDelta(80, 100, 'neutral')?.tone).toBe('neutral');
  });

  it('treats sub-0.5% changes as flat', () => {
    expect(computeDelta(1002, 1000, 'more-is-good')).toEqual({ pct: 0, direction: 'flat', tone: 'neutral' });
  });
});
