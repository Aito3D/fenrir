/**
 * Run `fn` over `items` with at most `limit` calls in flight, and settle every
 * one: the result array matches `items` order, failures included.
 *
 * For bulk actions that fire one request per row. Firing them all at once
 * (Promise.all over a few hundred DELETEs) contends for SQLite's single
 * writer, and one failure rejected the whole batch even though most rows had
 * already gone.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
