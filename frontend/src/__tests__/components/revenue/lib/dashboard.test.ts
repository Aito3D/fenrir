import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { REVENUE_POLL, bannerState, createSeriesLoader, csvFileName, dashboardReady, failureMessage, readJsonBody, withId, withoutId, toggleInSet, nextPollDelay, pollActive, startSeriesPoller, seriesQuery, filterQuery, REVENUE_STORAGE_KEYS, restoreStoredControls, storedRangeValue, shouldFetchProducts } from "@/components/revenue/lib/dashboard";
import type { RevenueSyncStatus } from "@/components/revenue/lib/types";

const sync = (over: Partial<RevenueSyncStatus> = {}) =>
  ({ backfilling: false, running: false, fetchedDays: 10, ...over }) as RevenueSyncStatus;

describe("seriesQuery", () => {
  it("adds no range suffix for the default choice", () => {
    expect(seriesQuery({ granularity: "month", range: { preset: "default" }, basketIds: [] })).toBe(
      "/api/v1/revenue?granularity=month",
    );
  });
  it("adds the preset", () => {
    expect(seriesQuery({ granularity: "day", range: { preset: "this-year" }, basketIds: [] })).toBe(
      "/api/v1/revenue?granularity=day&preset=this-year",
    );
  });
  it("adds from and to for a custom range", () => {
    expect(
      seriesQuery({ granularity: "week", range: { preset: "custom", from: "2026-01-01", to: "2026-02-01" }, basketIds: [] }),
    ).toBe("/api/v1/revenue?granularity=week&from=2026-01-01&to=2026-02-01");
  });
  it("adds no items for an empty basket and joins ids with commas otherwise", () => {
    expect(seriesQuery({ granularity: "month", range: { preset: "all" }, basketIds: ["a"] })).toBe(
      "/api/v1/revenue?granularity=month&preset=all&items=a",
    );
    expect(
      seriesQuery({ granularity: "year", range: { preset: "custom", from: "2025-01-01", to: "2025-12-31" }, basketIds: ["a", "b"] }),
    ).toBe("/api/v1/revenue?granularity=year&from=2025-01-01&to=2025-12-31&items=a,b");
  });
});

describe("filterQuery", () => {
  it("is empty for nothing, null or undefined", () => {
    expect(filterQuery([], [])).toBe("");
    expect(filterQuery(null, null)).toBe("");
    expect(filterQuery(undefined, undefined)).toBe("");
    expect(filterQuery([], new Set())).toBe("");
  });
  it("joins item ids with bare commas", () => {
    expect(filterQuery(["a", "b"], null)).toBe("&items=a,b");
  });
  it("emits one encoded brand param each", () => {
    expect(filterQuery(null, ["Bambu Lab", "eSUN & co"])).toBe("&brand=Bambu%20Lab&brand=eSUN%20%26%20co");
  });
  it("puts items before brands and keeps a Set's insertion order", () => {
    expect(filterQuery(["a"], new Set(["z", "Bambu Lab", "m"]))).toBe("&items=a&brand=z&brand=Bambu%20Lab&brand=m");
  });
});

describe("segment filter and views (2026-10-30)", () => {
  it("appends &segment= after &kind=", () => {
    expect(filterQuery(null, null, "goods", "pro")).toBe("&kind=goods&segment=pro");
    expect(seriesQuery({ granularity: "month", range: { preset: "default" }, basketIds: [], segment: "passage" })).toBe("/api/v1/revenue?granularity=month&segment=passage");
    expect(csvFileName("month", "2026-01-01", "2026-09-30", 0, false, "services", "particulier")).toBe("aito3d-ca-month-2026-01-01-2026-09-30-services-particulier.csv");
  });
  it("restores a stored segment and view, drops garbage", () => {
    const get = (m: Record<string, string>) => (k: string) => m[k] ?? null;
    expect(restoreStoredControls(get({ "revenue-segment": "pro", "revenue-view": "clients" }))).toEqual({ segment: "pro", view: "clients" });
    expect(restoreStoredControls(get({ "revenue-segment": "vip", "revenue-view": "nope" }))).toEqual({});
  });
});

describe("kind filter (Biens / Services)", () => {
  it("appends &kind= last, nothing for null", () => {
    expect(filterQuery(["a"], ["SUNLU"], "goods")).toBe("&items=a&brand=SUNLU&kind=goods");
    expect(filterQuery(null, null, null)).toBe("");
    expect(seriesQuery({ granularity: "month", range: { preset: "default" }, basketIds: [], kind: "services" })).toBe("/api/v1/revenue?granularity=month&kind=services");
  });
  it("names the export -biens / -services before the other suffixes", () => {
    expect(csvFileName("month", "2026-01-01", "2026-09-30", 2, true, "goods")).toBe("aito3d-ca-month-2026-01-01-2026-09-30-biens-marques-produits.csv");
    expect(csvFileName("month", "2026-01-01", "2026-09-30", 0, false, "services")).toBe("aito3d-ca-month-2026-01-01-2026-09-30-services.csv");
  });
  it("restores a stored kind, drops garbage", () => {
    expect(restoreStoredControls((k) => (k === "revenue-kind" ? "services" : null))).toEqual({ kind: "services" });
    expect(restoreStoredControls((k) => (k === "revenue-kind" ? "all" : null))).toEqual({});
  });
});

describe("seriesQuery with brands", () => {
  it("appends items then brands after the range", () => {
    expect(
      seriesQuery({ granularity: "month", range: { preset: "all" }, basketIds: ["a", "b"], brands: new Set(["Bambu Lab"]) }),
    ).toBe("/api/v1/revenue?granularity=month&preset=all&items=a,b&brand=Bambu%20Lab");
  });
});

describe("csvFileName brand suffix (T-1527)", () => {
  it("appends -marques for a brand pick, then -produits for a basket", () => {
    expect(csvFileName("month", "2026-01-01", "2026-09-30", 0, true)).toBe("aito3d-ca-month-2026-01-01-2026-09-30-marques.csv");
    expect(csvFileName("month", "2026-01-01", "2026-09-30", 2, true)).toBe("aito3d-ca-month-2026-01-01-2026-09-30-marques-produits.csv");
  });
});

describe("csvFileName", () => {
  it("suffixes -produits only with a basket", () => {
    expect(csvFileName("month", "2026-01-01", "2026-02-01", 0)).toBe("aito3d-ca-month-2026-01-01-2026-02-01.csv");
    expect(csvFileName("month", "2026-01-01", "2026-02-01", 2)).toBe("aito3d-ca-month-2026-01-01-2026-02-01-produits.csv");
  });
});

describe("polling", () => {
  it("is active while backfilling, running or items are unsynced", () => {
    expect(pollActive(sync({ backfilling: true }), "t")).toBe(true);
    expect(pollActive(sync({ running: true }), "t")).toBe(true);
    expect(pollActive(sync(), null)).toBe(true);
  });
  it("is idle otherwise", () => {
    expect(pollActive(sync(), "t")).toBe(false);
  });
});

describe("nextPollDelay (T-1502)", () => {
  const poll = { activeMs: 5, idleMs: 50 };
  it("arms nothing while the tab is hidden", () => {
    expect(nextPollDelay(true, true, poll)).toBeNull();
    expect(nextPollDelay(false, true, poll)).toBeNull();
  });
  it("gives the active or idle delay while visible", () => {
    expect(nextPollDelay(true, false, poll)).toBe(5);
    expect(nextPollDelay(false, false, poll)).toBe(50);
    expect(nextPollDelay(false, false, REVENUE_POLL)).toBe(REVENUE_POLL.idleMs);
    expect(nextPollDelay(true, false, REVENUE_POLL)).toBe(REVENUE_POLL.activeMs);
  });
});

describe("dashboardReady", () => {
  it("is not ready without data", () => {
    expect(dashboardReady(null)).toEqual({ itemsPending: false, ready: false });
  });
  it("is not ready while items are unsynced", () => {
    expect(dashboardReady({ sync: { fetchedDays: 3 }, itemsSyncedAt: null })).toEqual({ itemsPending: true, ready: false });
  });
  it("is not ready with no fetched days", () => {
    expect(dashboardReady({ sync: { fetchedDays: 0 }, itemsSyncedAt: "t" })).toEqual({ itemsPending: false, ready: false });
  });
  it("is ready otherwise", () => {
    expect(dashboardReady({ sync: { fetchedDays: 3 }, itemsSyncedAt: "t" })).toEqual({ itemsPending: false, ready: true });
  });
});

describe("failureMessage", () => {
  it("falls back to the HTTP status when there is no JSON body", () => {
    expect(failureMessage(502, null)).toBe("Failed (502)");
  });
  it("uses the body's error", () => {
    expect(failureMessage(422, { detail: "bad" })).toBe("bad");
  });
  it("ignores loki's error key: Fenrir's API answers FastAPI's detail", () => {
    expect(failureMessage(500, { error: "bad" })).toBe("Failed (500)");
  });
  it("falls back on an empty error", () => {
    expect(failureMessage(500, { detail: "" })).toBe("Failed (500)");
  });
  it("falls back on a non-object body", () => {
    expect(failureMessage(500, "text")).toBe("Failed (500)");
  });
});

describe("readJsonBody", () => {
  it("resolves null for a non-JSON body", async () => {
    await expect(readJsonBody(new Response("<!DOCTYPE html>", { status: 502 }))).resolves.toBeNull();
  });
  it("parses a JSON body", async () => {
    await expect(readJsonBody(new Response('{"a":1}'))).resolves.toEqual({ a: 1 });
  });
});

describe("bannerState", () => {
  const st = (over: Partial<RevenueSyncStatus>) => sync({ lastError: null, totalDays: 0, fetchedDays: 0, ...over });
  it("is 'error' when backfilling with an error (error wins over progress)", () => {
    expect(bannerState(st({ backfilling: true, lastError: "boom" })).kind).toBe("error");
  });
  it("is 'progress' when running with no error", () => {
    expect(bannerState(st({ running: true })).kind).toBe("progress");
  });
  it("is 'progress' when backfilling with no error", () => {
    expect(bannerState(st({ backfilling: true })).kind).toBe("progress");
  });
  it("is 'idle' while a routine sync runs over a complete history", () => {
    expect(bannerState(st({ running: true, totalDays: 1055, fetchedDays: 1055 })).kind).toBe("idle");
    expect(bannerState(st({ running: true, totalDays: 1055, fetchedDays: 1054 })).kind).toBe("progress");
  });
  it("is 'idle' when neither backfilling nor running and no error", () => {
    expect(bannerState(st({})).kind).toBe("idle");
  });
  it("is 'error' when idle but an error is stored", () => {
    expect(bannerState(st({ lastError: "boom" })).kind).toBe("error");
  });
  it("pctDone is 0 when totalDays is 0", () => {
    expect(bannerState(st({ totalDays: 0, fetchedDays: 5 })).pctDone).toBe(0);
  });
  it("pctDone rounds 1/3 to 33 and 2/3 to 67", () => {
    expect(bannerState(st({ totalDays: 3, fetchedDays: 1 })).pctDone).toBe(33);
    expect(bannerState(st({ totalDays: 3, fetchedDays: 2 })).pctDone).toBe(67);
  });
  it("pctDone rounds 999/1019 to 98", () => {
    expect(bannerState(st({ totalDays: 1019, fetchedDays: 999 })).pctDone).toBe(98);
  });
});

describe("startSeriesPoller (T-1502)", () => {
  const poll = { activeMs: 5, idleMs: 50 };
  let hidden: boolean;
  let active: boolean;
  let handler: (() => void) | null;
  let unsubscribe: Mock<() => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    hidden = false;
    active = false;
    handler = null;
    unsubscribe = vi.fn<() => void>();
  });
  afterEach(() => vi.useRealTimers());
  const start = (load: () => Promise<void>) =>
    startSeriesPoller({
      load,
      isActive: () => active,
      isHidden: () => hidden,
      onVisibility: (h) => {
        handler = h;
        return unsubscribe;
      },
      poll,
    });

  it("loads at once, then re-arms with the idle or active delay", async () => {
    const load = vi.fn(async () => {});
    start(load);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    active = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("arms no timer when the tab is hidden at re-arm time", async () => {
    hidden = true;
    const load = vi.fn(async () => {});
    start(load);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the pending timer when the tab becomes hidden, without loading", async () => {
    const load = vi.fn(async () => {});
    start(load);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    hidden = true;
    handler?.();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads at once when the tab becomes visible and nothing is in flight, then resumes", async () => {
    hidden = true;
    const load = vi.fn(async () => {});
    start(load);
    await vi.advanceTimersByTimeAsync(0);
    hidden = false;
    handler?.();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not start a second load while one is in flight; that load re-arms itself", async () => {
    let release: () => void = () => {};
    const load = vi.fn(() => new Promise<void>((r) => { release = r; }));
    start(load);
    hidden = true;
    handler?.();
    hidden = false;
    handler?.();
    expect(load).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop() cancels the timer, unsubscribes and ends the loop, even mid-load", async () => {
    const load = vi.fn(async () => {});
    const poller = start(load);
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);

    let release: () => void = () => {};
    const slow = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const second = start(slow);
    second.stop();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a rejecting load resets inFlight, re-arms the normal poll and surfaces no unhandled rejection (T-1524)", async () => {
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    try {
      const load = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("boom"));
      start(load);
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      // inFlight was reset: a visibility change can start a new load.
      handler?.();
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0);
      // the poll re-arms with the normal (idle, then active) delay
      await vi.advanceTimersByTimeAsync(49);
      expect(load).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(load).toHaveBeenCalledTimes(3);
      active = true;
      await vi.advanceTimersByTimeAsync(50);
      expect(load).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(5);
      expect(load).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      await new Promise<void>((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
    }
  });
});

describe("withId / withoutId (T-1504)", () => {
  it("withId adds without mutating the input", () => {
    const base: ReadonlySet<string> = new Set(["a"]);
    const next = withId("b")(base);
    expect([...next]).toEqual(["a", "b"]);
    expect([...base]).toEqual(["a"]);
    expect(next).not.toBe(base);
  });
  it("withoutId deletes without mutating the input", () => {
    const base: ReadonlySet<string> = new Set(["a", "b"]);
    const next = withoutId("a")(base);
    expect([...next]).toEqual(["b"]);
    expect([...base]).toEqual(["a", "b"]);
  });
  it("withoutId of an absent id returns an equal set", () => {
    const base: ReadonlySet<string> = new Set(["a"]);
    expect(withoutId("zz")(base)).toEqual(base);
  });
  it("keeps A busy when B finishes first or last", () => {
    let s: ReadonlySet<string> = new Set();
    s = withId("A")(s);
    s = withId("B")(s);
    s = withoutId("A")(s);
    expect(s.has("B")).toBe(true);
    expect(s.has("A")).toBe(false);
  });
});

describe("toggleInSet (T-1509)", () => {
  it("adds a key that is absent", () => {
    expect([...toggleInSet(new Set(["a"]), "b")]).toEqual(["a", "b"]);
  });
  it("removes a key that is present", () => {
    expect([...toggleInSet(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });
  it("never mutates the input", () => {
    const base = new Set(["a"]);
    const added = toggleInSet(base, "b");
    const removed = toggleInSet(base, "a");
    expect([...base]).toEqual(["a"]);
    expect(added).not.toBe(base);
    expect(removed).not.toBe(base);
  });
});

describe("persisted controls", () => {
  const from = (m: Record<string, string>) => (k: string) => m[k] ?? null;
  it("pins the localStorage key names", () => {
    expect(REVENUE_STORAGE_KEYS).toEqual({
      granularity: "revenue-granularity",
      taxMode: "revenue-tax-mode",
      stack: "revenue-stack",
      range: "revenue-range",
      kind: "revenue-kind",
      segment: "revenue-segment",
      view: "revenue-view",
      journalGroup: "revenue-journal-group",
    });
  });
  it("restores each valid stored value", () => {
    expect(
      restoreStoredControls(from({ "revenue-granularity": "week", "revenue-tax-mode": "ttc", "revenue-stack": "brand", "revenue-range": "this-year" })),
    ).toEqual({ granularity: "week", taxMode: "ttc", stack: "brand", preset: "this-year" });
  });
  it("restores nothing from an empty store", () => {
    expect(restoreStoredControls(() => null)).toEqual({});
  });
  it("ignores garbage values", () => {
    expect(
      restoreStoredControls(from({ "revenue-granularity": "decade", "revenue-tax-mode": "gross", "revenue-stack": "zzz", "revenue-range": "custom" })),
    ).toEqual({});
  });
  it("never restores the item stack", () => {
    expect(restoreStoredControls(from({ "revenue-stack": "item" }))).toEqual({});
  });
  it("ignores a preset not in RANGE_PRESETS, including default", () => {
    expect(restoreStoredControls(from({ "revenue-range": "default" }))).toEqual({});
    expect(restoreStoredControls(from({ "revenue-range": "nope" }))).toEqual({});
  });
  it("maps custom and default to null and a preset to its id", () => {
    expect(storedRangeValue({ preset: "default" })).toBeNull();
    expect(storedRangeValue({ preset: "custom", from: "2026-01-01", to: "2026-02-01" })).toBeNull();
    expect(storedRangeValue({ preset: "all" })).toBe("all");
    expect(storedRangeValue({ preset: "this-year" })).toBe("this-year");
  });
});

describe("shouldFetchProducts", () => {
  const none = { fetchedDays: undefined, reviewCount: undefined };
  const first = { fetchedDays: 40, reviewCount: 2 };
  it("fetches on mount", () => {
    expect(shouldFetchProducts(null, none, false)).toBe(true);
  });
  it("skips the first payload once the mount fetch delivered", () => {
    expect(shouldFetchProducts(none, first, true)).toBe(false);
  });
  it("retries on the first payload when the mount fetch has not delivered", () => {
    expect(shouldFetchProducts(none, first, false)).toBe(true);
  });
  it("fetches on every later change", () => {
    expect(shouldFetchProducts(first, { fetchedDays: 41, reviewCount: 2 }, true)).toBe(true);
    expect(shouldFetchProducts(first, { fetchedDays: 40, reviewCount: 3 }, true)).toBe(true);
  });
});

describe("createSeriesLoader", () => {
  const ok = (payload: unknown, etag?: string) => new Response(JSON.stringify(payload), { status: 200, headers: etag ? { etag } : {} });
  const sent = (f: Mock) => f.mock.calls.map((c) => (c[1] as RequestInit).headers);

  it("sends the auth headers and the last ETag of the same url, and keeps the data on a 304", async () => {
    const f = vi.fn().mockResolvedValueOnce(ok({ a: 1 }, 'W/"x"')).mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(ok({ a: 2 }));
    const loader = createSeriesLoader(() => ({ Authorization: "Bearer t" }), f);
    expect(await loader.load("/u")).toEqual({ status: "data", payload: { a: 1 } });
    expect(await loader.load("/u")).toEqual({ status: "unchanged" });
    expect(await loader.load("/other")).toEqual({ status: "data", payload: { a: 2 } });
    expect(sent(f)).toEqual([{ Authorization: "Bearer t" }, { Authorization: "Bearer t", "If-None-Match": 'W/"x"' }, { Authorization: "Bearer t" }]);
  });

  it("reset forgets the ETag", async () => {
    const f = vi.fn().mockImplementation(async () => ok({}, 'W/"x"'));
    const loader = createSeriesLoader(() => ({}), f);
    await loader.load("/u");
    loader.reset();
    await loader.load("/u");
    expect(sent(f)[1]).toEqual({});
  });

  it("drops an answer overtaken by a newer load, and throws the detail of a current failure", async () => {
    let release: (r: Response) => void = () => {};
    const f = vi.fn().mockImplementationOnce(() => new Promise<Response>((r) => { release = r; })).mockResolvedValueOnce(ok({ n: 2 }));
    const loader = createSeriesLoader(() => ({}), f);
    const first = loader.load("/u");
    const second = await loader.load("/u");
    release(ok({ n: 1 }));
    expect(await first).toEqual({ status: "stale" });
    expect(second).toEqual({ status: "data", payload: { n: 2 } });
    const failing = createSeriesLoader(() => ({}), vi.fn().mockResolvedValue(new Response('{"detail":"nope"}', { status: 422 })));
    await expect(failing.load("/u")).rejects.toThrow("nope");
  });

  it("an older request that rejects after a newer one started resolves stale, without throwing", async () => {
    let fail: (e: Error) => void = () => {};
    const f = vi.fn().mockImplementationOnce(() => new Promise<Response>((_, rej) => { fail = rej; })).mockResolvedValueOnce(ok({ n: 2 }));
    const loader = createSeriesLoader(() => ({}), f);
    const first = loader.load("/u");
    await loader.load("/u");
    fail(new Error("network"));
    expect(await first).toEqual({ status: "stale" });
  });

  it("the latest request's rejection throws, and the next load works normally", async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(ok({ n: 3 }));
    const loader = createSeriesLoader(() => ({}), f);
    await expect(loader.load("/u")).rejects.toThrow("network");
    expect(await loader.load("/u")).toEqual({ status: "data", payload: { n: 3 } });
  });

  it("a 2xx answer whose body is not JSON throws the failure message instead of yielding null data", async () => {
    const loader = createSeriesLoader(() => ({}), vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(loader.load("/u")).rejects.toThrow("Failed (200)");
  });
});
