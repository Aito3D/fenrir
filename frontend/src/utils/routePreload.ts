/** Start a lazy route's chunk import as soon as the URL is known.
 *
 *  The route pages are `React.lazy`, and React only calls a lazy loader when
 *  it first renders the element — which, behind the auth gate, is two round
 *  trips (status, me) after the HTML arrived. The pathname is known at t=0,
 *  so `App.tsx` calls this at module load with the same loader the lazy
 *  route uses: the browser caches a module's `import()` promise, and the
 *  later `React.lazy` call finds it resolved (or in flight) instead of
 *  starting from zero.
 *
 *  A failed import is swallowed here: the lazy route runs the same loader
 *  again and reports (or reloads after a redeploy) through `lazyWithReload`.
 */
export type RoutePreloadTable = Array<[RegExp, () => Promise<unknown>]>;

const started = new WeakSet<() => Promise<unknown>>();

export function preloadRoute(pathname: string, table: RoutePreloadTable): void {
  const match = table.find(([pattern]) => pattern.test(pathname));
  if (!match) return;
  const load = match[1];
  if (started.has(load)) return;
  started.add(load);
  void load().catch(() => {});
}
