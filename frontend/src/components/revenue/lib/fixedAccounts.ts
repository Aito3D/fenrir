import type { FixedAccount } from './types';

/** What an account charges to 3D printing in the running month; same rules as the server's `account_charge`. */
export function rowCharge(a: FixedAccount): { real: number; estimated: number } {
  const share = a.percent / 100;
  if (!(share > 0)) return { real: 0, estimated: 0 };
  if (a.type === 'annual') return { real: (a.year / 12) * share, estimated: 0 };
  // Only a monthly account projects the usual amount it still misses.
  const estimated = a.type === 'monthly' ? Math.max(0, a.usual - a.month) * share : 0;
  return { real: a.month * share, estimated };
}

export function totals(rows: FixedAccount[]): { real: number; estimated: number; goods: number; services: number } {
  const sum = { real: 0, estimated: 0, goods: 0, services: 0 };
  for (const a of rows) {
    const { real, estimated } = rowCharge(a);
    sum.real += real;
    sum.estimated += estimated;
    sum.goods += ((real + estimated) * a.goodsShare) / 100;
    sum.services += ((real + estimated) * (100 - a.goodsShare)) / 100;
  }
  return sum;
}
