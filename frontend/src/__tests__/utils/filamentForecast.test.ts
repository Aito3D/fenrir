import { describe, it, expect } from 'vitest';
import {
  computeDeltaRate,
  computeHistoryRate,
  computeSkuForecasts,
  groupSpoolsBySku,
} from '../../utils/filamentForecast';
import type { InventorySpool, SpoolUsageRecord } from '../../api/client';

function spool(overrides: Partial<InventorySpool>): InventorySpool {
  return {
    id: 1,
    material: 'PLA',
    subtype: null,
    color_name: 'Black',
    rgba: null,
    extra_colors: null,
    effect_type: null,
    brand: 'Generic',
    label_weight: 1000,
    core_weight: 200,
    core_weight_catalog_id: null,
    weight_used: 0,
    weight_used_baseline: 0,
    archived_at: null,
    created_at: '2024-06-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    ...overrides,
  } as InventorySpool;
}

function usage(spoolId: number, day: string, grams: number): SpoolUsageRecord {
  return {
    id: Math.random(),
    spool_id: spoolId,
    weight_used: grams,
    created_at: `${day}T12:00:00Z`,
  } as SpoolUsageRecord;
}

describe('groupSpoolsBySku', () => {
  it('groups by material/subtype/brand/color and skips archived spools', () => {
    const groups = groupSpoolsBySku([
      spool({ id: 1 }),
      spool({ id: 2 }),
      spool({ id: 3, color_name: 'Red' }),
      spool({ id: 4, archived_at: '2024-06-01T00:00:00Z' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.colorName === 'Black')?.spools).toHaveLength(2);
  });
});

describe('computeHistoryRate', () => {
  it('needs at least two distinct days', () => {
    expect(computeHistoryRate([usage(1, '2024-06-01', 50)])).toBeNull();
    expect(computeHistoryRate([usage(1, '2024-06-01', 50), usage(1, '2024-06-01', 30)])).toBeNull();
  });

  it('computes a positive rate from multi-day history', () => {
    const result = computeHistoryRate([
      usage(1, '2024-06-01', 50),
      usage(1, '2024-06-02', 50),
      usage(1, '2024-06-03', 50),
    ]);
    expect(result).not.toBeNull();
    expect(result!.rate).toBeGreaterThan(0);
  });
});

describe('computeDeltaRate', () => {
  it('respects the usage-reset baseline (#1390)', () => {
    const s = spool({ weight_used: 500, weight_used_baseline: 500 });
    expect(computeDeltaRate([s])).toBeNull();
  });
});

describe('computeSkuForecasts', () => {
  it('derives days remaining from the consumption rate', () => {
    const spools = [spool({ id: 1, weight_used: 300, created_at: '2024-01-01T00:00:00Z' })];
    const groups = groupSpoolsBySku(spools);
    const [forecast] = computeSkuForecasts(groups, [], [], 0);
    // 700g remaining; delta rate = 300g since Jan 2024
    expect(forecast.totalRemainingG).toBe(700);
    expect(forecast.rateTier).toBe('delta');
    expect(forecast.daysRemaining).not.toBeNull();
    expect(forecast.daysRemaining!).toBeGreaterThan(0);
  });

  it('returns null days remaining when there is no usage at all', () => {
    const [forecast] = computeSkuForecasts(groupSpoolsBySku([spool({})]), [], [], 0);
    expect(forecast.daysRemaining).toBeNull();
    expect(forecast.rateTier).toBe('none');
  });
});
