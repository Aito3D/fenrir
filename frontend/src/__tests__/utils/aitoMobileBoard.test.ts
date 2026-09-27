import { describe, it, expect } from 'vitest';
import { summariseColumn } from '../../utils/aitoMobileBoard';
import { COLUMNS } from '../../components/aito/columns';
import { makeProject } from '../fixtures/aitoProject';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const devis = COLUMNS[0];

describe('summariseColumn', () => {
  it('counts and finds the oldest card in whole days', () => {
    const s = summariseColumn(devis, [
      makeProject({ id: 1, created_at: '2026-09-23T12:00:00Z' }),
      makeProject({ id: 2, created_at: '2026-09-18T11:00:00Z' }),
    ], NOW);
    expect(s.count).toBe(2);
    expect(s.oldestDays).toBe(9);
    expect(s.oldestCls).toMatch(/^text-/);
  });

  it('measures an accepted job from its acceptance', () => {
    const s = summariseColumn(devis, [
      makeProject({ created_at: '2026-08-01T12:00:00Z', quote_status: 'accepted', quote_accepted_at: '2026-09-25T12:00:00Z' }),
    ], NOW);
    expect(s.oldestDays).toBe(2);
  });

  it('has no oldest for an empty column', () => {
    expect(summariseColumn(devis, [], NOW)).toEqual({ column: devis, count: 0, oldestDays: null, oldestCls: '' });
  });
});
