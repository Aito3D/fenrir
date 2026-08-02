# Aito Import-Quote Drawer — Design

Date: 2026-08-02
Status: approved (direction and search pattern chosen via visual companion:
right-docked drawer, browse-first embedded list)

## Problem

`ImportQuoteModal` is a centered single-column dialog: a typeahead combobox,
then a stacked preview. The empty state is a blank combobox (recent quotes are
invisible until you type), duplicates only reveal themselves after a quote is
previewed, loading is a lone spinner, and the modal shares no anatomy with the
NewProjectDrawer even though the two are sibling entry points onto the same
board.

## Decision

Replace it with **`ImportQuoteDrawer`** — a right-docked drawer, the visual
and behavioral twin of `NewProjectDrawer`, with a **browse-first quote list**
in the main column and the commitment (description, totals, checklist,
Import) in a fixed rail.

## Anatomy

- Right-docked drawer over a dimmed board: `max-w-[900px]`, full height,
  body grid `grid-cols-[minmax(0,1fr)_288px]` (main column + rail), each
  column scrolling independently — the NewProjectDrawer's anatomy at a
  narrower cut.
- Motion reused verbatim from the existing vocabulary: `animate-overlay-in` /
  `animate-drawer-in` on mount; the `closing` state with
  `animate-overlay-out` / `animate-drawer-out` and the ~220ms deferred
  `onClose` (same timeout-not-animationend reasoning as NewProjectDrawer);
  `pointer-events-none` on the overlay while closing; reduced-motion falls
  back to fades.
- Escape and backdrop click close; ✕ closes; the drawer takes focus on mount
  (`role="dialog"`, `aria-modal`, `aria-label` = the import title). There is
  no Cancel button.
- **No draft persistence.** The drawer is a read-only picker; the one
  editable field (description) reseeds per quote, so closing loses nothing
  worth keeping. (Deliberate contrast with NewProjectDrawer's localStorage
  draft.)

## Main column — browse-first list

- **Recents on open:** on mount, query `api.searchZohoEstimates('')` — the
  backend documents that an empty `q` lists the most recent estimates. No
  backend changes anywhere in this feature.
- **Search:** an autofocused input above the list; input is debounced
  **250ms** into the query key; `placeholderData: keepPreviousData` keeps the
  previous results rendered while the next page loads, so the list never
  blanks mid-typing.
- **Rows** (from `ZohoEstimateSummary`, which already carries everything):
  quote number + customer name, date · status, total (via `Money`).
- **"Imported → #N" chip:** derived client-side by joining each row's `id`
  against the `['aito-projects']` board cache (`AitoProject.quote_id`).
  Trashed projects (`status !== 'active'`) do not count as imported. The chip
  warns before the user ever clicks; it never disables the row.
- **Keyboard:** ↑/↓ move a highlight, Enter selects the highlighted row,
  plain typing stays in the search input (the input keeps focus; arrows are
  intercepted there — same pattern as ClientCombobox).
- **Prefetch:** pointer-enter on a row and keyboard-highlight both call
  `queryClient.prefetchQuery({ queryKey: ['zoho-quote-preview', id] })` so
  the preview is usually cached before selection.
- **Selection:** picking a row collapses the list into a compact
  selected-quote card (number · client · total) with a **Change** button;
  Change restores the list with the search text intact. The preview then owns
  the rest of the column:
  - Header: number · client, date · status; total as an external link to
    `quote.url` (today's affordance kept).
  - Warnings, same three as today: already imported (warning, includes the
    project id), currency mismatch (quote currency vs configured), no
    service lines (error).
  - **Receipt table** replacing today's task cards: one tight row per task —
    title, service chips (`ServiceBadges`), amount; task descriptions as a
    muted second line when present; skipped lines inline as muted rows
    (sku · name, amount); a final total row showing the project total, and
    project-vs-quote totals whenever they differ (not only when lines were
    skipped, fixing today's gap where a currency-converted total difference
    was silent).
- **Loading:** skeleton rows for the list, skeleton header/receipt blocks
  for the preview — no lone centered spinner. Query errors render inline
  (list: retry affordance; preview: today's `quoteLoadFailed` line).
- **Zoho not configured:** today's inline notice + `/settings?tab=zoho`
  link, rendered in place of the search/list.

## Rail

Top to bottom:

1. **Description** textarea — seeded from `suggested_description` once per
   quote (today's `seededFor` latch kept verbatim); user edits survive
   re-renders but reseed when a different quote is selected.
2. **Receipt summary** — task count and project total (and the quote total
   when it differs), the numbers the CTA commits to.
3. **Pre-import checklist** — reuses `CreateChecklist`'s visual language by
   **exporting its `Line` component** (box, tick with `animate-tick-in`,
   300ms color transition) and consuming it here — no visual fork:
   - has service lines — `ok`/`miss` (miss blocks Import)
   - not already imported — `ok`/`warn` (warns, never blocks: re-import is
     allowed today and stays allowed)
   - currency matches — `ok`/`warn` (never blocks)
   - description present — `ok`/`miss` (miss blocks Import)
4. **Import CTA** — full-width, `aria-disabled` (not `disabled`) with the
   NewProjectDrawer's reveal pattern: clicking a disabled Import draws the
   eye to the unmet checklist lines rather than swallowing the click.
   Label: *Import* / *Import again* (when already imported), with the
   project total beside the label. `submitting` renders the busy state.

## Interface (unchanged)

```ts
export interface ImportQuoteDrawerProps {
  onClose: () => void;
  onImport: (payload: { description: string; preview: ZohoQuotePreview }) => void;
  submitting?: boolean;
}
```

`AitoPage` swaps `<ImportQuoteModal …>` for `<ImportQuoteDrawer …>` with the
same props and handlers; the import mutation, toasts and board refresh are
untouched.

## Code plan

- Create `frontend/src/components/aito/ImportQuoteDrawer.tsx` with a small
  `QuoteResultList` child component (rows, keyboard nav, prefetch) — either
  in-file or as a sibling file if it grows.
- **Delete** `QuoteCombobox.tsx` and `QuoteCombobox.test.tsx` — the modal
  was its only caller.
- Delete `ImportQuoteModal.tsx`; rewrite its test file as
  `ImportQuoteDrawer.test.tsx`.
- `servicesOf`/`taskTotal` helpers move over unchanged.
- No new CSS: drawer/overlay keyframes, `animate-rise`, `animate-tick-in`
  and skeleton styling (`animate-pulse`) all exist.

## Reactive/perf notes

- All server state through React Query (list, preview, status, settings —
  the latter two keep today's shared keys and staleTimes so they ride
  existing caches).
- The list query is keyed by the debounced term; React Query cancels/ignores
  stale responses. Prefetch makes selection render from cache in the common
  case.
- Search state is isolated in the list component so typing never re-renders
  the preview or rail.
- Result rows render inline (not a memoized component — an accepted
  simplification); the list is page-sized and re-renders only within
  `QuoteResultList`, whose state isolation (see above) already covers it. The
  receipt renders from `preview` only.

## Testing (Vitest — rewrite of ImportQuoteModal.test.tsx)

- Recents listed on open (empty-`q` search) and rendered as rows.
- Typing debounces to one query per pause and filters the list.
- ↑/↓ + Enter selects; hover prefetches (assert via cache or fetch count).
- "Imported → #N" chip appears for a row whose id matches a board project's
  `quote_id`; trashed projects don't produce the chip.
- Selecting shows the preview; Change restores the list with search intact.
- Checklist gating: no-service-lines and empty description block (aria-
  disabled + click reveals), already-imported and currency mismatch warn
  but don't block.
- Import posts `{description, preview}`; Import-again label when duplicate.
- ✕/Escape play the exit then call `onClose` (deferred-close contract).
- Zoho-not-configured notice with settings link.
