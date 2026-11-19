// Pure rules behind the revenue page (the components stay thin layers over them).
import { RANGE_PRESETS } from "./buckets";
import { STACK_DIMENSIONS, type StackDimension } from "./chart";
import type { CustomerSegment, RangePresetId, RevenueGranularity, RevenueKind, RevenueResponse, RevenueSyncStatus, TaxMode } from "./types";

const GRANULARITIES: readonly string[] = ["day", "week", "month", "year"];
const SEGMENTS: readonly string[] = ["pro", "particulier", "passage", "inconnu"];
export const isRevenueGranularity = (v: unknown): v is RevenueGranularity => typeof v === "string" && GRANULARITIES.includes(v);
export const isRevenueKind = (v: unknown): v is RevenueKind => v === "goods" || v === "services";
export const isCustomerSegment = (v: unknown): v is CustomerSegment => typeof v === "string" && SEGMENTS.includes(v);

/** `"default"` = let the route pick the per-granularity default range. */
export type RangeChoice = { preset: RangePresetId | "default" } | { preset: "custom"; from: string; to: string };

/** While the back-fill is running or a batch is in flight (`activeMs`), else idle. */
export const REVENUE_POLL = { activeMs: 4_000, idleMs: 60_000 };

function presetToQuery(choice: RangeChoice): string {
  if (choice.preset === "custom") return `&from=${choice.from}&to=${choice.to}`;
  return choice.preset === "default" ? "" : `&preset=${choice.preset}`;
}

/** The `&items=a,b` (ids unencoded), one `&brand=` per brand, then `&kind=` and `&segment=` narrowing a revenue read; "" when none. */
export function filterQuery(
  itemIds: readonly string[] | null | undefined,
  brands: Iterable<string> | null | undefined,
  kind: RevenueKind | null = null,
  segment: CustomerSegment | null = null,
): string {
  const items = itemIds && itemIds.length > 0 ? `&items=${itemIds.join(",")}` : "";
  return (
    items +
    [...(brands ?? [])].map((b) => `&brand=${encodeURIComponent(b)}`).join("") +
    (kind ? `&kind=${kind}` : "") +
    (segment ? `&segment=${segment}` : "")
  );
}

export function seriesQuery({
  granularity,
  range,
  basketIds,
  brands,
  kind = null,
  segment = null,
}: {
  granularity: RevenueGranularity;
  range: RangeChoice;
  basketIds: string[];
  brands?: Iterable<string>;
  kind?: RevenueKind | null;
  segment?: CustomerSegment | null;
}): string {
  return `/api/v1/revenue?granularity=${granularity}${presetToQuery(range)}${filterQuery(basketIds, brands, kind, segment)}`;
}

const KIND_SUFFIX: Record<RevenueKind, string> = { goods: "-biens", services: "-services" };

/** `brandsPicked`: the brand filter narrows the export too (« -marques » before « -produits »); `kind` adds « -biens » / « -services » first, `segment` « -pro » etc. after it. */
export function csvFileName(
  granularity: RevenueGranularity,
  from: string,
  to: string,
  basketSize: number,
  brandsPicked = false,
  kind: RevenueKind | null = null,
  segment: CustomerSegment | null = null,
): string {
  return `aito3d-ca-${granularity}-${from}-${to}${kind ? KIND_SUFFIX[kind] : ""}${segment ? `-${segment}` : ""}${brandsPicked ? "-marques" : ""}${basketSize > 0 ? "-produits" : ""}.csv`;
}

export function pollActive(sync: RevenueSyncStatus, itemsSyncedAt: string | null): boolean {
  return sync.backfilling || sync.running || itemsSyncedAt === null;
}

/** Delay before the next poll, or `null` while the tab is hidden (no poll is armed; the page reloads on return). */
export function nextPollDelay(active: boolean, hidden: boolean, poll: { activeMs: number; idleMs: number }): number | null {
  return hidden ? null : active ? poll.activeMs : poll.idleMs;
}

export interface SeriesPollerDeps {
  load: () => Promise<void>;
  isActive: () => boolean;
  isHidden: () => boolean;
  /** Subscribes to the page's visibility changes; returns the unsubscribe. */
  onVisibility: (handler: () => void) => () => void;
  poll: { activeMs: number; idleMs: number };
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (t: ReturnType<typeof setTimeout>) => void;
}

/**
 * Load, then poll: fast while the back-fill runs, slow otherwise. A hidden tab arms no poll and
 * reloads when shown again. `load` owns its error handling; a rejection is swallowed here so the
 * loop keeps polling.
 */
export function startSeriesPoller(deps: SeriesPollerDeps): { stop(): void } {
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  let cancelled = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    inFlight = true;
    try {
      await deps.load();
    } catch {
      // `load` reports its own errors; the poller only schedules, and `void run()` must not leak a rejection.
    } finally {
      inFlight = false;
    }
    if (cancelled) return;
    const delay = nextPollDelay(deps.isActive(), deps.isHidden(), deps.poll);
    if (delay !== null) timer = setT(run, delay);
  };
  const unsubscribe = deps.onVisibility(() => {
    if (timer) clearT(timer);
    timer = null;
    if (!deps.isHidden() && !inFlight) void run();
  });
  void run();
  return {
    stop() {
      cancelled = true;
      unsubscribe();
      if (timer) clearT(timer);
    },
  };
}

export type SeriesLoad<T = RevenueResponse> = { status: "data"; payload: T } | { status: "unchanged" } | { status: "stale" };

/**
 * The series fetch the poller's `load` calls: sends the auth headers (a function, so a refreshed
 * token is picked up) and `If-None-Match` for the last ETag of the same URL; a 304 is "unchanged"
 * (the page keeps its data) and an answer overtaken by a newer `load` is "stale" (dropped).
 * Throws on a failed or non-JSON current answer (`Error(failureMessage)`); an overtaken request never throws.
 */
export function createSeriesLoader<T = RevenueResponse>(getHeaders: () => Record<string, string>, doFetch: typeof fetch = fetch) {
  let seq = 0;
  let etag: { url: string; tag: string } | null = null;
  return {
    async load(url: string): Promise<SeriesLoad<T>> {
      const mySeq = ++seq;
      try {
        const headers = { ...getHeaders(), ...(etag?.url === url ? { "If-None-Match": etag.tag } : {}) };
        const res = await doFetch(url, { headers });
        if (mySeq !== seq) return { status: "stale" };
        if (res.status === 304) return { status: "unchanged" };
        const body = await readJsonBody(res);
        if (mySeq !== seq) return { status: "stale" };
        if (!res.ok || body === null) throw new Error(failureMessage(res.status, body));
        const tag = res.headers.get("etag");
        etag = tag ? { url, tag } : null;
        return { status: "data", payload: body as T };
      } catch (e) {
        if (mySeq !== seq) return { status: "stale" };
        throw e;
      }
    },
    /** Forget the ETag so the next load always returns data (the page's refresh). */
    reset() {
      etag = null;
    },
  };
}

export function dashboardReady(
  data: { sync: { fetchedDays: number }; itemsSyncedAt: string | null } | null,
): { itemsPending: boolean; ready: boolean } {
  const itemsPending = data != null && data.itemsSyncedAt === null;
  const ready = data != null && data.sync.fetchedDays > 0 && !itemsPending;
  return { itemsPending, ready };
}

/** Reads a response body as JSON; `null` when it is not JSON (a proxy's HTML error page). */
export async function readJsonBody(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}

/** The body's FastAPI `detail` when it is a non-empty string, else `Failed (<status>)`. */
export function failureMessage(status: number, body: unknown): string {
  const detail = typeof body === "object" && body !== null ? (body as { detail?: unknown }).detail : undefined;
  return typeof detail === "string" && detail !== "" ? detail : `Failed (${status})`;
}

export type BannerKind = "idle" | "error" | "progress";

/** Which of the sync banner's three faces to show; an error always wins over progress. */
export function bannerState(sync: RevenueSyncStatus): { kind: BannerKind; pctDone: number } {
  const showProgress = sync.backfilling || sync.running;
  const kind: BannerKind = !showProgress && !sync.lastError ? "idle" : sync.lastError ? "error" : "progress";
  const pctDone = sync.totalDays > 0 ? Math.round((sync.fetchedDays / sync.totalDays) * 100) : 0;
  return { kind, pctDone };
}

/** State updater: copy of the set with `id` added (updaters must stay pure, so the input is never mutated). */
export function withId(id: string): (set: ReadonlySet<string>) => Set<string> {
  return (set) => {
    const next = new Set(set);
    next.add(id);
    return next;
  };
}

/** State updater: copy of the set with `id` removed. */
export function withoutId(id: string): (set: ReadonlySet<string>) => Set<string> {
  return (set) => {
    const next = new Set(set);
    next.delete(id);
    return next;
  };
}

/** Copy of the set with `key` removed when present, added when absent (the input is never mutated). */
export function toggleInSet(set: ReadonlySet<string>, key: string): Set<string> {
  return set.has(key) ? withoutId(key)(set) : withId(key)(set);
}

/** The localStorage keys of the seven persisted controls. */
export const REVENUE_STORAGE_KEYS = {
  granularity: "revenue-granularity",
  taxMode: "revenue-tax-mode",
  stack: "revenue-stack",
  range: "revenue-range",
  kind: "revenue-kind",
  segment: "revenue-segment",
  view: "revenue-view",
} as const;

/** The ids tying a `RevenueSegmented` tab to its panel (fast refresh wants the component file to export components only). */
export const segmentTabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
export const segmentPanelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

/** The page's four views: the series (« Évolution »), the customer split, the product analysis, the seasonality charts. */
export const REVENUE_VIEWS = [
  { id: "evolution", label: "Évolution" },
  { id: "clients", label: "Clients" },
  { id: "produits", label: "Produits" },
  { id: "saison", label: "Saisonnalité" },
] as const;
export type RevenueView = (typeof REVENUE_VIEWS)[number]["id"];
export const isRevenueView = (v: unknown): v is RevenueView => REVENUE_VIEWS.some((x) => x.id === v);

interface StoredControls {
  granularity?: RevenueGranularity;
  taxMode?: TaxMode;
  stack?: StackDimension;
  preset?: RangePresetId;
  kind?: RevenueKind;
  segment?: CustomerSegment;
  view?: RevenueView;
}

/** The stored controls that are still valid; an absent or garbage value is left out. */
export function restoreStoredControls(get: (key: string) => string | null): StoredControls {
  const out: StoredControls = {};
  const g = get(REVENUE_STORAGE_KEYS.granularity);
  if (isRevenueGranularity(g)) out.granularity = g;
  const t = get(REVENUE_STORAGE_KEYS.taxMode);
  if (t === "ht" || t === "ttc") out.taxMode = t;
  const s = get(REVENUE_STORAGE_KEYS.stack);
  // « Produit » needs a basket, which is never persisted.
  if (s !== "item" && STACK_DIMENSIONS.some((d) => d.id === s)) out.stack = s as StackDimension;
  const r = get(REVENUE_STORAGE_KEYS.range);
  if (RANGE_PRESETS.some((p) => p.id === r)) out.preset = r as RangePresetId;
  const k = get(REVENUE_STORAGE_KEYS.kind);
  if (isRevenueKind(k)) out.kind = k;
  const seg = get(REVENUE_STORAGE_KEYS.segment);
  if (isCustomerSegment(seg)) out.segment = seg;
  const v = get(REVENUE_STORAGE_KEYS.view);
  if (isRevenueView(v)) out.view = v;
  return out;
}

/** What to store for a range choice; null means remove the key (custom and default are never persisted). */
export function storedRangeValue(choice: RangeChoice): string | null {
  return choice.preset === "custom" || choice.preset === "default" ? null : choice.preset;
}

/**
 * Whether the products-list effect should fetch. It always fetches on mount (`prev` null). The
 * first series payload moves both deps from undefined to a number, which is not a real change:
 * that run is skipped when the mount fetch already delivered the list, and kept as the retry when not.
 */
export function shouldFetchProducts(
  prev: { fetchedDays: number | undefined; reviewCount: number | undefined } | null,
  next: { fetchedDays: number | undefined; reviewCount: number | undefined },
  listLoaded: boolean,
): boolean {
  if (prev === null) return true;
  const firstPayload =
    prev.fetchedDays === undefined && prev.reviewCount === undefined &&
    next.fetchedDays !== undefined && next.reviewCount !== undefined;
  return !(firstPayload && listLoaded);
}
