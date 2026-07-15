import { describe, it, expect } from 'vitest';
import { computeUtilization } from '../../../components/stats/printerUtilization';
import type { ArchiveSlim } from '../../../api/client';

function slim(overrides: Partial<ArchiveSlim>): ArchiveSlim {
  return {
    id: 1,
    printer_id: 1,
    print_name: 'Test',
    print_time_seconds: 3600,
    actual_time_seconds: 3600,
    filament_used_grams: 10,
    filament_type: 'PLA',
    filament_color: null,
    status: 'completed',
    started_at: null,
    completed_at: null,
    cost: null,
    quantity: 1,
    created_at: '2024-06-15T00:00:00Z',
    ...overrides,
  } as ArchiveSlim;
}

const printerMap = new Map([['1', 'X1C']]);
// Fixed "now" well after the test window so clamping never kicks in
const NOW = new Date('2024-07-01T00:00:00Z').getTime();

// Windows span 3 local days around the prints so the tests hold in any
// machine timezone (local-day boundaries shift by up to ±14h vs UTC).
describe('computeUtilization', () => {
  it('computes busy share of the selected window', () => {
    // 6h print inside a 72h window
    const archives = [
      slim({ started_at: '2024-06-15T06:00:00Z', completed_at: '2024-06-15T12:00:00Z' }),
    ];
    const [row] = computeUtilization(archives, printerMap, '2024-06-14', '2024-06-16', NOW);
    expect(row.name).toBe('X1C');
    expect(row.busySeconds).toBe(6 * 3600);
    expect(row.pct).toBeCloseTo((6 / 72) * 100, 1);
  });

  it('merges overlapping runs so utilization never exceeds 100%', () => {
    const archives = [
      slim({ started_at: '2024-06-15T00:00:00Z', completed_at: '2024-06-16T00:00:00Z' }),
      slim({ id: 2, started_at: '2024-06-15T06:00:00Z', completed_at: '2024-06-15T18:00:00Z' }),
    ];
    const [row] = computeUtilization(archives, printerMap, '2024-06-14', '2024-06-16', NOW);
    expect(row.pct).toBeLessThanOrEqual(100);
    // Overlapping 24h + 12h runs merge to 24h, not 36h
    expect(row.busySeconds).toBe(24 * 3600);
  });

  it('falls back to duration when completed_at is missing', () => {
    const archives = [
      slim({ started_at: '2024-06-15T06:00:00Z', completed_at: null, actual_time_seconds: 7200 }),
    ];
    const [row] = computeUtilization(archives, printerMap, '2024-06-14', '2024-06-16', NOW);
    expect(row.busySeconds).toBe(7200);
  });

  it('returns empty when nothing has timing data', () => {
    const archives = [slim({ started_at: null })];
    expect(computeUtilization(archives, printerMap, '2024-06-15', '2024-06-15', NOW)).toEqual([]);
  });
});
