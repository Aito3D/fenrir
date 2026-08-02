import { describe, expect, it } from 'vitest';
import { agingLevel, agingTextCls } from '../../utils/aitoAging';

const DAY = 86_400_000;

describe('agingLevel', () => {
  it('maps the spec boundaries to their levels', () => {
    expect(agingLevel(0)).toBe(0);
    expect(agingLevel(2.9 * DAY)).toBe(0);
    expect(agingLevel(3 * DAY)).toBe(1);
    expect(agingLevel(6.9 * DAY)).toBe(1);
    expect(agingLevel(7 * DAY)).toBe(2);
    expect(agingLevel(10 * DAY)).toBe(3);
    expect(agingLevel(15 * DAY)).toBe(4);
    expect(agingLevel(21 * DAY)).toBe(5);
    expect(agingLevel(29.9 * DAY)).toBe(5);
    expect(agingLevel(30 * DAY)).toBe(6);
    expect(agingLevel(365 * DAY)).toBe(6);
  });
});

describe('agingTextCls', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  const live = { status: 'active', column: 'devis' };
  const at = (days: number) => new Date(now - days * DAY);

  it('walks the heat ramp on a live card', () => {
    expect(agingTextCls(live, at(1), now)).toBe('text-bambu-gray');
    expect(agingTextCls(live, at(4), now)).toBe('text-[#d9c26b]');
    expect(agingTextCls(live, at(8), now)).toBe('text-amber-400');
    expect(agingTextCls(live, at(12), now)).toBe('text-orange-400');
    expect(agingTextCls(live, at(17), now)).toBe('text-orange-500');
    expect(agingTextCls(live, at(24), now)).toBe('text-[#f75c4c]');
    expect(agingTextCls(live, at(38), now)).toBe('text-red-500 font-medium');
  });

  it('stays gray for done, deleted, and unparseable cards regardless of age', () => {
    expect(agingTextCls({ status: 'active', column: 'done' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingTextCls({ status: 'deleted', column: 'devis' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingTextCls(live, null, now)).toBe('text-bambu-gray');
  });
});
