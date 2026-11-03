# App performance: lighter to load, lighter to use

Status: PROPOSAL, awaiting Paul's choices (see "Decisions" at the end).
Date: 2026-11-01

## 1. What the two Lighthouse runs actually say

Two reports were on the table. They measure different things.

**Run A: phone, `localhost:5173/aito` (screenshot).** This hit the Vite dev
server, which serves every module unminified and unbundled. The headline
numbers (17 MB payload, "minify JS saves 20 MB", 260 user timings) are
dev-server artefacts: the production build minifies everything, and the user
timings are React's dev-build profiler marks. That run tells us nothing about
what a phone downloads from the shop server. Ignore it for sizing.

**Run B: desktop Lighthouse against `app.aito3d.fr/projects` (JSON).** This is
the real production bundle behind Cloudflare (HTTP/3, gzip). Key facts:

| Metric | Value |
|---|---|
| Performance score | 55 |
| Requests / scripts | 160 / 112 |
| Transfer | 1,048 KiB |
| Observed FCP / LCP | 0.87 s / 2.2 s |
| Simulated FCP / LCP (score basis) | 5.3 s / 10.3 s |
| Main-thread work | 0.87 s (0.4 s script eval, 0.18 s parse) |
| Total blocking time | 0 ms |

The simulated numbers are what Lighthouse scores. They are so much worse than
the observed ones because Lighthouse's simulator punishes **long serial
dependency chains**, and the app's boot is a 5-hop chain (section 2.2).

**Run C: my own measurement.** I loaded the current production build from
`:8000` in headless Chrome with iPhone emulation, logged in as admin, French
locale, on `/aito`:

| Metric | Value |
|---|---|
| Requests / JS files | 148 / 113 |
| Transfer | 1,157 KB (963 KB JS) |
| API calls before the board renders | 29 |
| JS files preloaded before any route | 67 files, 1,755 KB raw, 491 KB gzipped |

So in production the problem is not minification. It is **how much ships
before the first page, how serial the boot is, and how much the app keeps
doing after it has loaded**.

## 2. Root causes, ranked

### 2.1 The eager set carries things no page needs at boot

The entry preloads 67 modules (491 KB gz) before React Router has even looked
at the URL. Inside that set:

| Chunk | Raw / gz | Why it is there | Unused at boot |
|---|---|---|---|
| `shippingLabel` | 195 KB / 61 KB | `App.tsx` imports `TrackingErrorBoundary` from `components/aito/trackingShell.tsx`, which imports the `AITO3D_SENDER` constant from `utils/shippingLabel.ts`, which imports `react-dom/server` and `qrcode.react` | 88% |
| `PrintModal` | 93 KB / 27 KB | `Layout.tsx` imports `ConfirmOutcomeDialog`, which imports `PrintModal` | 95% |
| `esm` (i18next + English strings) | 475 KB / 155 KB | English is bundled as the synchronous fallback. French users then also download `fr` (466 KB / 147 KB) | n/a |
| 60 one-icon lucide chunks | 100–600 B each | Natural code-splitting; each costs a request | 0% |

A French user on the Aito board therefore downloads two full string tables
(~300 KB gz) and a server-side HTML renderer they will never call.

### 2.2 The boot is a five-hop serial chain

From the production waterfall (times are from navigation start):

1. HTML → entry + 67 preloads (done ≈ 0.78 s)
2. `/system/appliance`, `/auth/status` (≈ 0.98 s)
3. `/auth/me` (≈ 1.17 s), only then the route chunk is requested
4. `ProjectListPage` + 45 more chunks (≈ 1.62 s), including the ones in 2.3
5. 23 shell + page API calls (≈ 1.7–2.1 s), then 10 thumbnails (≈ 2.45 s)

Each hop waits for the previous one. The route chunk could be fetched in
parallel with auth (the URL is known at t=0), and `/auth/me` does not need
`/auth/status` first (the token is in localStorage).

### 2.3 Route pages drag in heavy viewers eagerly

`/projects` pulls three.js (`OrbitControls` chunk, 730 KB / 186 KB gz, 73%
unused), `PartViewerModal` (200 KB / 59 KB), `jszip` (96 KB / 28 KB),
`LibraryFileDetailsModal` and `ProjectFilesPanel` on first paint of a list of
projects. Chain: `CatalogPane → ProjectFilesPanel → ItemCard → PartViewerModal
→ PartScene → three`. The same static import sits in `RevisionBlock`,
`ArchiveModals` and `FileManagerPage`, so Archives and File Manager pay it too.

### 2.4 The shell polls hard on every page

`Layout.tsx` runs 11 queries on every page. Two of them poll every 5 s
(`queue?status=pending` and `pending-uploads/count`, for the sidebar badges),
and `useWebSocket` does not invalidate either key, so the polls are the only
freshness mechanism. Three more poll every 30–60 s (external links,
developer-mode warnings, debug-logging state). On a phone with the app in the
foreground this keeps the radio and the main thread busy for two badge
numbers.

### 2.5 Non-composited animations on cards

`index.css` has 93 keyframe sets. `flag-halo` (urgent/SAV cards),
`aito-rating-halo`, `code-breathe` and `grid-border-blink` animate
`box-shadow` or `border-color`, which repaints the element every frame on the
main thread. `flag-halo` runs forever on every flagged card. This is the "5
animated elements" line in Run A, and on the phone board it competes with
scrolling.

### 2.6 Smaller delivery issues

- `sw-register.js` is a synchronous `<script>` in `<body>`; Lighthouse counts
  it as render-blocking (371 ms simulated).
- Library thumbnails (`/api/v1/library/files/{id}/thumbnail`) are served by
  `FileResponse` with no `Cache-Control`, so every visit refetches all of them.
- On the LAN deployment uvicorn speaks HTTP/1.1 (6 connections), so the
  113-file waterfall is slower there than through Cloudflare's HTTP/3.
- Origin compression is gzip only; brotli would cut JS transfer ~15%.
- Only 2 components in the tree use `React.memo`; the Aito board re-renders
  every card on each WebSocket invalidation (unmeasured, see 3.3c).

## 3. Proposal

Four phases, independent, in recommended order. Each has a measurable target.

### Phase 1: cut the eager set (frontend only, low risk)

a. Move `AITO3D_SENDER` into its own module (`utils/aitoSender.ts`) and point
   `trackingShell`, `TrackingPaymentMethods`, `TrackingShopPanel` and
   `aitoShop` at it. `shippingLabel.ts` (react-dom/server + QR) then loads
   only when a label is printed. Also lazy-load the four public tracking
   routes in `App.tsx` so `trackingShell` leaves the entry entirely.
b. Lazy-load `PrintModal` behind a `React.lazy` wrapper used by
   `ConfirmOutcomeDialog` and the other 7 call sites, so the entry stops
   carrying it. It renders only when opened.
c. Lazy-load `PartViewerModal` and `LibraryFileDetailsModal` at their four
   static call sites. three.js, jszip and the mesh loaders then load on first
   "open viewer", not on page load.
d. Add `defer` to the `sw-register.js` script tag.
e. Guard rail: a Vitest that reads `static/index.html` and asserts the
   preload set stays under a byte budget and never includes `shippingLabel`,
   `PrintModal`, `OrbitControls` or `PartViewerModal`.

Targets: entry preload 491 KB → ≈ 400 KB gz; `/projects` first load 1,048 KB
→ ≈ 700 KB; `/aito` phone load 1,157 KB → ≈ 950 KB; requests 160 → ≈ 110.

### Phase 2: break the serial boot (frontend, medium risk)

a. Prefetch the route chunk at t=0: a small `preloadRoute(pathname)` map in
   `App.tsx` that calls the same `import()` the lazy routes use, invoked
   before the auth bootstrap starts.
b. Parallelise the auth bootstrap in `AuthContext`: fire `/auth/status`,
   `/auth/me` (when a token exists) and `/system/appliance` together instead
   of status → me.
c. Defer non-critical shell queries (update check, announcements, external
   links, smart plugs, debug logging, developer-mode warnings) until after
   first paint with an `enabled` flag flipped by `requestIdleCallback`, so the
   page's own data calls are not queued behind them. Matters most on the
   HTTP/1.1 LAN deployment.

Targets: observed LCP on production 2.2 s → ≈ 1.3 s; two fewer serial hops;
Lighthouse performance score 55 → 80+.

### Phase 3: stop the background churn ("lighter to use")

a. Sidebar badges: replace the two 5 s polls with WebSocket-driven
   invalidation. Backend emits a `queue_changed` / `pending_uploads_changed`
   message where it already broadcasts queue and upload events;
   `useWebSocket` invalidates `['queue']` and `['pending-uploads']`. Keep a
   60 s fallback poll plus `refetchOnWindowFocus`. Raise external links and
   developer-mode warnings to 5 min; debug-logging to focus-only.
b. Rewrite `flag-halo`, `aito-rating-halo`, `code-breathe` and
   `grid-border-blink` to animate `opacity`/`transform` on a pseudo-element
   (same look, composited). Respect `prefers-reduced-motion` while there.
c. Board re-render cost: profile the Aito board with the React profiler under
   a WebSocket burst first. If cards re-render wholesale, add `React.memo`
   to `CardView` with stable callbacks. This item is measure-then-decide.

Targets: zero periodic API calls while idle on the board except the 60 s
fallback; no main-thread paint work from idle animations.

### Phase 4: delivery (backend and build, small, optional)

a. Thumbnails: `Cache-Control: private, max-age=86400` + `ETag` from file id
   and mtime on the library thumbnail routes, so repeat visits get 304s.
b. Brotli at origin: add the `brotli` package and a `.br` branch next to the
   gzip branch in `AssetStaticFiles` (same LRU cache). ≈ 15% less JS transfer
   on the LAN; Cloudflare already passes origin encoding through.
c. Locale: stop bundling English into the entry for non-English users. Load
   only the active locale before first render (main.tsx already waits on
   `i18nReady`), keep a 2 KB English stub for the boot screen. Saves ≈ 150 KB
   gz for every French user. Medium risk: any string read before the locale
   resolves falls back to the key.
d. Icon chunks: group the lucide one-icon modules into a single shared chunk
   via rolldown's `output.advancedChunks` limited to `lucide-react`. This is
   NOT the `manualChunks` footgun (that pulled heavy vendor libs into the
   entry); icons are tiny and used everywhere. Verify with the Phase 1 guard
   test that the preload set does not grow.

### Not proposed now

- Splitting `SettingsPage` (790 KB chunk) and `PrintersPage` (517 KB source):
  real wins but large upstream files; separate campaign.
- Splitting `api/client.ts` types out: no runtime effect.
- The accessibility findings in Run B (contrast on `text-bambu-gray`, the
  catalog `listbox` whose children are `<li>`, `user-scalable=no` in the
  viewport meta): worth a small follow-up, not performance.

## 4. How success is checked

- Re-run `scratchpad/perf.mjs` (headless Chrome, iPhone emulation, prod build
  on `:8000`) before and after each phase; it reports requests, bytes, API
  count, LCP.
- Lighthouse against `app.aito3d.fr/projects` and `/aito` after deploy.
- The Phase 1 guard test runs in `test_frontend.sh`.

## 5. Decisions for Paul

1. Order: 1 → 3 → 2 → 4 is my recommendation (biggest wins per hour, lowest
   risk first). OK, or load-time first (1 → 2)?
2. Phase 4c (English out of the entry): yes or no? Biggest single byte win
   for the shop, but it changes how the first render waits on i18n.
3. Phase 4d (icon chunk grouping): yes or no? It touches the Vite config that
   a past session marked "do not add manualChunks back"; the proposal is a
   narrower rule and is guarded by the test, but it is your call.
4. Badge polling: WebSocket-driven with a 60 s fallback (my proposal), or just
   lengthen the polls to 30 s and refetch on focus (smaller change)?

## 6. Results (2026-11-01, branch `perf-lighter-app`)

Measured in headless Chrome with iPhone emulation, 4× CPU throttle, simulated
LTE (40 ms RTT, 10 Mbps), cold cache, logged in, French locale. Old = the
build on `main` served by the dev backend on :8000; new = this branch served
by a sandboxed uvicorn on :8034. Two runs each; both shown.

| Page | Build | Requests | Transfer | JS | First paint | LCP | DOMContentLoaded |
|---|---|---|---|---|---|---|---|
| /aito | old | 152 | 1,166 KB | 971 KB | 1.06 / 1.45 s | 1.65 / 2.05 s | 0.83 / 1.21 s |
| /aito | new | 97 | 882 KB | 699 KB | 0.94 / 1.24 s | 1.34 / 1.61 s | 0.41 / 0.70 s |
| /projects | old | 150 | 1,261 KB | 1,032 KB | 1.49 / 1.33 s | 2.21 / 2.04 s | 1.26 / 1.09 s |
| /projects | new | 90 | 644 KB | 467 KB | 1.09 / 1.08 s | 1.55 / 1.55 s | 0.68 / 0.68 s |

Eager preload set (what every page loads before the router reads the URL):
67 files / 491 KB gzipped → 29 files / 269 KB gzipped, guarded by
`frontend/scripts/check-preload-budget.mjs` in `npm run build`.

Lighter to use: the two 5 s sidebar polls are gone (WebSocket events +
60 s fallback), card halos and tile blinks animate on the compositor, an
unrelated board re-render no longer re-renders every card (241 → 1
component renders per tick for 20 cards in the measurement test), library
thumbnails are cached per client for as long as their media token lives
(the token is in the URL and rotates per boot and every 50 minutes, so the
day-long `max-age` is really "no refetch while navigating within a
session"; the ETag/304 path is correct but rarely reached), and `/assets`
ships brotli (11% smaller than gzip) to clients that accept it.

Not changed: the Lighthouse accessibility findings (contrast, catalog
`listbox` children, `user-scalable=no`), the 790 KB Settings chunk and the
517 KB-source Printers page.
