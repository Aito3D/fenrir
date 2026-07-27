# Aito card header, modal latency, and morph z-order design

Date: 2026-07-27
Status: approved by user (brainstorming session)

## Goal

Four fixes to the Aito board, grouped because they all touch the card and its
modal:

1. The "New project" modal's client block appears only after a delay; it should
   be there on open.
2. The card gains a header carrying the client name and a drag handle, visually
   separate from the body. The card drags **only** from that handle and opens
   **only** from its body.
3. Phone and email leave the card entirely — they belong to the detail panel.
4. Expanding a card animates with the backdrop painted *over* the morphing card,
   so the panel looks dark and then jumps to full brightness.

## Diagnosis

Both bugs were traced to specific causes rather than guessed at; the fixes below
follow from these.

### The modal delay is a blocking reachability probe

`NewProjectModal` renders `{draft && <ClientSection …/>}`, and `draft` stays
`null` until `GET /zoho/status` resolves. That endpoint calls
`zoho_service.get_access_token(db)`, which on a cold or expired token performs a
live OAuth round-trip to `accounts.zoho.eu` before responding.

The modal does not use the result:

| Field the modal reads | Source |
|---|---|
| `default_contact_id` | settings table |
| `default_contact_name` | settings table |
| `configured` | `is_configured()` — settings table |
| `reachable` | **the only field needing the Zoho call — unused by the modal** |

Only the settings page's **Test** button consumes `reachable`. The client block
is therefore blocked on a network probe whose single result it discards.

Note: the access token is cached in memory for roughly 55 minutes, so this
should be intermittent rather than present on every open. If it reproduces on
*every* open, something additional is involved and must be diagnosed before this
design is trusted — the fix below removes the dependency either way, but the
"why" would be incomplete.

### The morph z-order depends on capture order

`ProjectDetailPanel` puts `view-transition-name: aito-backdrop` on the fixed
overlay and `aito-card` on the panel nested inside it. Neither
`::view-transition-group()` declares a `z-index`, so paint order falls back to
the order the groups were captured in.

On **open** that order works against us: `aito-card` exists in the old state (as
the board card) and is captured first; `aito-backdrop` is new, captured
afterwards, and appended later in the pseudo-element tree — so it paints on top
of the morphing card for the full 350 ms, until the real DOM takes over.

On **close** both names exist in the old state and the backdrop is the panel's
ancestor, so it is captured first and paints below. **The bug should therefore
be asymmetric — visible on open, absent on close.** Confirm that against the
observed behaviour; if closing is also wrong, this diagnosis is incomplete.

## Decisions made

| Decision | Choice |
|---|---|
| Modal latency fix | Make the reachability probe opt-in (`?probe=true`), not a prefetch or an optimistic render |
| Header contents | Client name + grab handle only |
| Expand affordance | Body click; the existing chevron button is removed |
| Keyboard expand | The description area becomes a `<button>` |
| Footer placement | Elapsed time + delete sit **outside** the clickable body |
| Header colour | Neutral band (`bg-bambu-dark-tertiary`), no per-column tint |
| Drag activation | Handle only, via `setActivatorNodeRef` |
| Phone/email on card | Removed; the detail panel keeps them |
| Morph z-order | Explicit `z-index` on both view-transition groups |

## 1. Modal opens instantly

### Backend — `GET /zoho/status`

Gains an optional `probe: bool = False` query parameter.

- **Without `probe`** (the modal): answer from the settings table only —
  `configured` from `is_configured()`, plus `default_contact_id` and
  `default_contact_name` from `get_default_contact()`. **No upstream request is
  made.** `reachable` is reported as `null`.
- **With `probe=true`** (the settings Test button): unchanged behaviour,
  including the `get_access_token` call and its `ZohoNotConfiguredError` /
  `ZohoUpstreamError` branches.

`ZohoStatus.reachable` becomes `bool | None`. A `null` means "not probed", which
is distinct from `false` ("probed and unreachable") — the settings page must not
render "unreachable" for an unprobed response.

### Frontend

- `api.getZohoStatus(probe?: boolean)` appends `?probe=true` when asked.
- `ZohoStatus.reachable` is typed `boolean | null`.

There are **four** call sites today, all sharing the key `['zoho-status']`, and
only one of them needs the probe:

| Call site | Reads | Key |
|---|---|---|
| `NewProjectModal` | `configured`, `default_contact_*` | `['zoho-status', { probe: false }]` |
| `ClientSection` | `configured` | `['zoho-status', { probe: false }]` |
| `ZohoSettings` passive query | `configured` only (secret-saved badges and placeholders) | `['zoho-status', { probe: false }]` |
| `ZohoSettings` **Test** button | `configured` **and** `reachable` | `['zoho-status', { probe: true }]` |

The settings page's passive query therefore also stops making an OAuth
round-trip on every load — it never read `reachable` in the first place.

**The key split is load-bearing, not tidiness.** The Test button currently calls
`queryClient.fetchQuery({ queryKey: ['zoho-status'], staleTime: 0 })` — the same
key the modal uses. Left shared, an unprobed response sitting in the cache would
be handed to the Test button, which would render "unreachable" from a
`reachable: null` that only means "never probed".

Only the Test button's rendering distinguishes the three states: `configured &&
reachable` → connected, `configured` alone → unreachable, otherwise → not
configured. Since it always probes, it never sees `null`; no other call site
renders reachability at all.

The `{draft && …}` gate stays as it is. It is no longer a latency problem once
the query resolves locally, and keeping it means an unconfigured install still
shows the not-configured notice rather than a client block.

## 2. Card structure

```
┌────────────────────────────┐
│ ACME SARL              ⠿  │  header — bg-bambu-dark-tertiary + divider
├────────────────────────────┤  drag handle only
│ Support de caméra pour     │  <button> — opens the detail panel
│ drone, 2 pièces            │
├────────────────────────────┤
│ 3h                     🗑  │  footer — outside the button
└────────────────────────────┘
```

### Header

- Client name, or `t('aito.noClient')` in grey for legacy cards whose
  `client_name` is `NULL`.
- `bg-bambu-dark-tertiary`, a bottom divider, and `rounded-t-xl` so it meets the
  card's corners.
- Not clickable: clicking the header neither opens the card nor starts a drag
  (only the handle within it drags).

### Grab handle

- `GripVertical` (lucide), right-aligned in the header.
- Receives `useSortable`'s `listeners` **and** `attributes`, attached via
  `setActivatorNodeRef`. Both must go on the handle: `attributes` carries the
  `role`, `tabIndex` and `aria-describedby` that make keyboard dragging work, so
  leaving them on the wrapper would keep the whole card as the keyboard drag
  target.
- `touch-none` moves off the card wrapper and onto the handle. Left on the
  wrapper, it would block touch-scrolling the column from anywhere on a card.
- `aria-label` from a new i18n key `aito.dragHandle`.

### Body

- The description only, wrapped in a `<button type="button">` calling
  `onExpand`, full width, text left-aligned.
- The chevron "show details" button is removed — the body click replaces it.

**Known trade-off:** the panel is now discoverable only by clicking, with no
visible affordance hinting at it. Accepted; the hover state on the body plus the
cursor change carry the hint.

**Why the footer is outside:** a `<button>` may not contain another button, so
`DeleteHoldButton` cannot live inside the body button. The alternative — a `div`
with `role="button"` wrapping everything — keeps the whole body clickable but
nests an interactive control inside a button role, which assistive technology
handles badly. Consequence: clicking the empty space beside the elapsed time
does not open the card.

### Footer

- Elapsed time + `DeleteHoldButton`, unchanged, as a sibling of the body button.

### Removed from the card

- `client_phone` and the `tel:` link.
- `client_email` was never rendered on the card.
- Both remain in `ProjectDetailPanel`.

### Drag activation

`activationConstraint: { distance: 8 }` is dropped from the `PointerSensor`. It
exists to distinguish a click from a drag on a whole-card handle; with a
dedicated handle there is nothing to disambiguate, and dropping it makes the
handle respond immediately.

`DeleteHoldButton`'s and the `tel:` link's `stopPropagation` guards were there
because the whole card was a drag handle and an expand target. The delete
button's guards stay (it sits in the footer, which is not a drag source, but the
guards are harmless and defend against future nesting); the `tel:` link's go
with the link.

## 3. Morph z-order

Two rules in `index.css`, beside the existing `aito-card` transition rules:

```css
::view-transition-group(aito-backdrop) { z-index: 0; }
::view-transition-group(aito-card)     { z-index: 1; }
```

This pins paint order independently of capture order, fixing open and leaving
close (already correct) unchanged.

## Testing

**Backend (`httpx.MockTransport`):**
- `GET /zoho/status` without `probe` makes **no** upstream request — assert a
  transport call counter stays at zero, so the test fails if the probe returns.
- The unprobed response carries `configured`, `default_contact_id` and
  `default_contact_name`, with `reachable: null`.
- `GET /zoho/status?probe=true` still reports `reachable: true` on a good token
  and `reachable: false` on an upstream error.
- The unprobed path still reports `configured: false` when settings are missing.

**Frontend:**
- The Test button and the modal do not share a cache entry: a probed result must
  not satisfy the modal's query, nor an unprobed result the Test button's.

**Card component:**
- A pointer drag starting on the body does **not** start a drag; one starting on
  the handle does.
- Clicking the body calls `onExpand`; clicking the header does not.
- The delete control still fires and does not open the panel.
- Neither `client_phone` nor `client_email` appears anywhere in the card's
  output, given a project that has both.
- The header falls back to `aito.noClient` when `client_name` is `null`.

**Not unit-tested:** the `z-index` fix is CSS-only and verified by eye.

## i18n

One new key, `aito.dragHandle`, in all 12 locale files. `aito.showDetails`
becomes unused when the chevron goes — remove it from all 12 rather than leaving
an orphan, since the parity test counts keys on both sides.
