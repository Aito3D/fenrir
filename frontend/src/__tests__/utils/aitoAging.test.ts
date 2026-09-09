import { describe, expect, it } from 'vitest';
import {
  ageAnchor,
  agingColorCls,
  agingLevel,
  agingTextCls,
  dueDateCls,
  dueDateLevel,
  isIsoDateKey,
} from '../../utils/aitoAging';

const DAY = 86_400_000;

describe('agingLevel', () => {
  it('maps the spec boundaries to their levels', () => {
    expect(agingLevel(-DAY)).toBe(0);
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
    expect(agingTextCls(live, at(24), now)).toBe('text-[#fb7a6a]');
    expect(agingTextCls(live, at(38), now)).toBe('text-red-400 font-medium');
  });

  it('stays gray for done, deleted, and unparseable cards regardless of age', () => {
    expect(agingTextCls({ status: 'active', column: 'done' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingTextCls({ status: 'deleted', column: 'devis' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingTextCls(live, null, now)).toBe('text-bambu-gray');
  });
});

describe('agingColorCls', () => {
  const now = Date.parse('2026-08-01T12:00:00Z');
  const live = { status: 'active', column: 'devis' };
  const at = (days: number) => new Date(now - days * DAY);

  it('walks the same ramp as agingTextCls but never sets a font weight', () => {
    expect(agingColorCls(live, at(1), now)).toBe('text-bambu-gray');
    expect(agingColorCls(live, at(12), now)).toBe('text-orange-400');
    expect(agingColorCls(live, at(38), now)).toBe('text-red-400');
  });

  it('keeps the same exemptions', () => {
    expect(agingColorCls({ status: 'active', column: 'done' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingColorCls({ status: 'deleted', column: 'devis' }, at(38), now)).toBe('text-bambu-gray');
    expect(agingColorCls(live, null, now)).toBe('text-bambu-gray');
  });
});

describe('ageAnchor', () => {
  const base = { quote_status: null, quote_accepted_at: null, created_at: '2026-07-01T00:00:00' };

  it('measures an accepted quote from its acceptance stamp', () => {
    const result = ageAnchor({ ...base, quote_status: 'accepted', quote_accepted_at: '2026-07-20T00:00:00' });
    expect(result.anchor).toBe('accepted');
    expect(result.raw).toBe('2026-07-20T00:00:00');
    expect(result.at?.toISOString()).toBe('2026-07-20T00:00:00.000Z');
  });

  it('ignores the acceptance stamp while the quote is not accepted', () => {
    const result = ageAnchor({ ...base, quote_status: 'sent', quote_accepted_at: '2026-07-20T00:00:00' });
    expect(result.anchor).toBe('created');
    expect(result.raw).toBe('2026-07-01T00:00:00');
  });

  it('falls back to creation when an accepted quote carries no stamp', () => {
    const result = ageAnchor({ ...base, quote_status: 'accepted', quote_accepted_at: null });
    expect(result.anchor).toBe('created');
    expect(result.raw).toBe('2026-07-01T00:00:00');
  });

  it('falls back to creation when the acceptance stamp is unparseable', () => {
    const result = ageAnchor({ ...base, quote_status: 'accepted', quote_accepted_at: 'not-a-date' });
    expect(result.anchor).toBe('created');
    expect(result.at?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('reports a null date rather than an Invalid Date when creation is unparseable too', () => {
    const result = ageAnchor({ ...base, created_at: 'not-a-date' });
    expect(result.anchor).toBe('created');
    expect(result.at).toBeNull();
  });
});

describe('dueDateLevel', () => {
  const today = '2026-09-10';
  it('walks none / far / soon / today / past against a fixed today', () => {
    expect(dueDateLevel(null, today)).toBe('none');
    expect(dueDateLevel('2026-09-20', today)).toBe('far');
    expect(dueDateLevel('2026-09-14', today)).toBe('far');
    expect(dueDateLevel('2026-09-13', today)).toBe('soon');
    expect(dueDateLevel('2026-09-11', today)).toBe('soon');
    expect(dueDateLevel('2026-09-10', today)).toBe('today');
    expect(dueDateLevel('2026-09-09', today)).toBe('past');
    expect(dueDateLevel('2020-01-01', today)).toBe('past');
  });
  it('treats an unparseable date as none', () => {
    expect(dueDateLevel('soon', today)).toBe('none');
  });
  it('maps levels to complete colour classes', () => {
    expect(dueDateCls('far')).toBe('text-bambu-gray');
    expect(dueDateCls('soon')).toBe('text-amber-400');
    expect(dueDateCls('today')).toBe('text-orange-500');
    expect(dueDateCls('past')).toBe('text-red-400 font-medium');
    expect(dueDateCls('none')).toBe('');
  });
});

describe('isIsoDateKey', () => {
  it('accepts a plain YYYY-MM-DD string', () => {
    expect(isIsoDateKey('2026-09-06')).toBe(true);
  });
  it('rejects non-ISO shapes, empty strings, and stamps with a time component', () => {
    expect(isIsoDateKey('10/02/2026')).toBe(false);
    expect(isIsoDateKey('')).toBe(false);
    expect(isIsoDateKey('2026-9-6')).toBe(false);
    expect(isIsoDateKey('2026-09-06T00:00')).toBe(false);
  });
});

describe('dueRelativeLabel', () => {
  const t = ((key: string, opts?: { count?: number }) => `${key}:${opts?.count}`) as unknown as import('i18next').TFunction;
  it('speaks the language handed to it and rounds to the unit a glance wants', async () => {
    const { dueRelativeLabel } = await import('../../utils/aitoAging');
    expect(dueRelativeLabel(0, 'en', t)).toBe('today');
    expect(dueRelativeLabel(1, 'en', t)).toBe('tomorrow');
    expect(dueRelativeLabel(6, 'en', t)).toBe('in 6 days');
    expect(dueRelativeLabel(7, 'en', t)).toBe('in 1 week');
    expect(dueRelativeLabel(27, 'en', t)).toBe('in 4 weeks');
    expect(dueRelativeLabel(28, 'en', t)).toBe('in 1 month');
    expect(dueRelativeLabel(3, 'fr', t)).toBe('dans 3 jours');
    expect(dueRelativeLabel(1, 'fr', t)).toBe('demain');
    expect(dueRelativeLabel(-2, 'fr', t)).toBe('aito.dueLateDays:2');
  });
});
