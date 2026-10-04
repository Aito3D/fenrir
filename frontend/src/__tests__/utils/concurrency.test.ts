import { describe, it, expect } from 'vitest';
import { settleWithConcurrency } from '../../utils/concurrency';

describe('settleWithConcurrency', () => {
  it('never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    await settleWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  it('settles every item in input order, failures included', async () => {
    const results = await settleWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, (5 - n) * 2));
      if (n % 2 === 0) throw new Error(`no ${n}`);
      return n * 10;
    });
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected']);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('no 2');
  });

  it('handles an empty list', async () => {
    expect(await settleWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
