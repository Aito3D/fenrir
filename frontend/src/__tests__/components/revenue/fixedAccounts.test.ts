import { describe, it, expect } from 'vitest';
import { rowCharge, totals } from '../../../components/revenue/lib/fixedAccounts';
import type { FixedAccount } from '../../../components/revenue/lib/types';

const account = (over: Partial<FixedAccount>): FixedAccount => ({
  id: 'a', code: '61320000', name: 'Location', active: true, flag: null, month: 0, year: 0, usual: 0, percent: 0, type: 'monthly', goodsShare: 50, ...over,
});
const rent = account({ id: 'rent', usual: 160000, year: 1920000, percent: 50, goodsShare: 40 });
const edf = account({ id: 'edf', month: 24000, usual: 72000, percent: 100, goodsShare: 100 });

describe('fixed accounts, the running month', () => {
  it('projects the usual amount a monthly account still misses', () => {
    expect(rowCharge(rent)).toEqual({ real: 0, estimated: 80000 });
    expect(rowCharge(edf)).toEqual({ real: 24000, estimated: 48000 });
    expect(rowCharge({ ...edf, month: 90000 })).toEqual({ real: 90000, estimated: 0 });
  });

  it('spreads an annual account over twelve months and never projects it', () => {
    expect(rowCharge(account({ type: 'annual', year: 216000, usual: 5000, percent: 30 })).real).toBeCloseTo(5400);
    expect(rowCharge(account({ type: 'annual', year: 216000, usual: 5000, percent: 30 })).estimated).toBe(0);
  });

  it('counts a one-off as entered and never projects it', () => {
    expect(rowCharge(account({ type: 'one_off', month: 238341, usual: 60000, percent: 100 }))).toEqual({ real: 238341, estimated: 0 });
    expect(rowCharge(account({ type: 'one_off', usual: 60000, percent: 100 }))).toEqual({ real: 0, estimated: 0 });
  });

  it('charges nothing without a share', () => {
    expect(rowCharge(account({ month: 1000, usual: 2000 }))).toEqual({ real: 0, estimated: 0 });
    expect(rowCharge(account({ month: 1000, percent: NaN }))).toEqual({ real: 0, estimated: 0 });
  });

  it('splits the total between goods and services', () => {
    expect(totals([rent, edf])).toEqual({ real: 24000, estimated: 128000, goods: 104000, services: 48000 });
    expect(totals([])).toEqual({ real: 0, estimated: 0, goods: 0, services: 0 });
  });
});
