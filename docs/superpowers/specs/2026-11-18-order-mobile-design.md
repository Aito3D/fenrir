# Order Board on the phone (design A)

Date: 2026-11-18. Mockup: `docs/superpowers/specs/2026-11-18-order-mobile-demo/index.html` (variant A).

## Why

The shop uses `/orders` from a phone (at the counter, in the stockroom). At 390 px today:
the six status tiles fill the first screen, the filters stack on four lines, an opened order shows
billing before the products, and the products table scrolls sideways with the "Manque" column cut off.
The user picked variant A on 2026-11-18 ("OK for A").

## Goals

- Below 768 px (`useIsMobile`), the list fits: a row of status chips that scrolls sideways, one search
  row with a filter button, compact order rows, a floating "+" for a new order.
- An opened order takes the whole screen, with tabs **Produits / Facturation / Client / Activité**,
  products readable without scrolling sideways, and the next step in a bar at the bottom.
- The phone's Back button closes the order (the `?order=` history entry already behaves this way).
- Every action that works on desktop still works on the phone: pick check, parcel check + scan, order
  edit, parcel edit, hand-over, invoice now, payment link / terminal / manual, emails, SMS, sync, watch,
  cancel, tracking link.

## Non-goals

- Desktop and tablet (≥ 768 px) do not change at all.
- No new backend routes or fields.
- The counter "new order" draft (`NewOrderDraftRow`) is not redesigned; it already stacks below `lg`.
- No swipe between orders, no pull to refresh.

## Anti-goals

- A second copy of the fulfilment logic for the phone. The bars (check, edit, parcel edit, hand-over)
  and their state stay in `OrderLinesPanel`; the phone view only lays them out differently.
- An order whose open bar is lost when the operator switches tab.

## Approaches considered

- **A · list + full-screen order (picked).** Chips + filter sheet; order full screen with tabs and a
  bottom action bar.
- B · one swipe page per status (like the Queue / Aito phone board), order as a 92 % bottom sheet. Lost
  the overview of all open orders and the total; search would need to span pages.
- C · same page tightened, order still opens inline. Least work, but a long order stays long and the
  actions sit at its far end.

## Design

### List (phone)

- `OrderBoardPage` keeps one component and branches on `useIsMobile()` for the header block only; the
  list, filters state (`useOrderFilters`, URL) and data are shared.
- **Status chips**: the same six entries as the tiles (`STATUSES` + En cours + Terminées), each a pill with
  a tone dot, label and count, in a horizontally scrolling row; pressed = the tile's pressed state.
  The "À expédier" money hint and "dont N partielles" hints are dropped on the phone.
- **Search row**: the existing search input + a filter button (badge = number of non-default filters)
  that opens `components/mobile/Sheet` with: 3D seulement toggle (+N masquées), payment chips, follow-up
  pills, sort buttons, and the "Chiffres" strip toggle. The sheet acts live; a footer button closes it.
- **Summary line** under the search: value · % paid of the listed open orders (`moneyLine`), sync status
  (`orders.syncing` / `orders.updated`) and a refresh icon button (orders:update).
- **"+" FAB** (orders:update) starts the draft; hidden while drafting. Same z-order rules as Aito's FAB.
- **Rows**: `OrderCard`'s collapsed row keeps its current phone grid. The batch-prep checkbox column
  is hidden on the phone (batch printing is a desk task). The row icon (`OrderRowAction`) stays.
- The sync error banner and empty/loading notices are unchanged.

### Order (phone)

- On the phone, `OrderCard` / `FinishedOrderCard` do not expand inline. When open, they render
  `OrderMobileView`: a `fixed inset-0` layer (above the shell's top bar, below modals and sheets) with:
  - **Header**: back button (closes = `onToggle`), customer, order number, and a ⋯ button opening a
    `Sheet` with what `OrderRefChips` holds today (Zoho / Shopify / quote links, tracking link, watch,
    sync, cancel-hold).
  - **Summary**: total, status chip, units line ("0/23 expédiés · 91 % prêt"), `PaymentPill` (fill).
  - **Tabs**: Produits (with unit count) / Facturation / Client / Activité. Default Produits.
  - **Body**, scrolling on its own.
  - **Action bar** at the bottom (safe-area padding): primary = the order's next step from `nextStep(row)`
    with the `OrderRowAction` label (Préparer / Créer le colis / Remettre), which switches to Produits and
    starts that step (the same `onStart` the row icon uses); secondary = "Encaisser", which switches to
    Facturation. No primary when there is no next step or no orders:update. While a bar (check, edit,
    parcel, hand-over) is open, the action bar hides: the open bar carries its own confirm buttons.
- **One panel, laid out by tab**: `OrderLinesPanel` gets a `phoneTab` prop. When set, it renders the
  products table only on Produits and the `OrderSidePanel` parts per tab (`OrderSidePanel` gets the same
  prop and skips its own Details/Activity `PanelTabs`): Facturation = `OrderInvoicesBlock` with deposit
  + payment; Client = `OrderContactBlock` (+ SMS modal); Activité = `OrderActivity`. Hidden tabs stay
  mounted where they hold state (the products part holds the bars), so switching tab never drops an open
  check or edit.
- **Products as cards without a second component**: below 768 px the products table restyles via
  `max-md:` classes: table/tbody/tr become block/grid, the header row hides, each product row is a card
  (name + SKU · price on top; quantity, "Disponible n", "Manque −n", state below). The two cells that
  rely on the hidden header get a phone-only label, reusing `orders.col.available` / `orders.col.short`.
  Band rows and the colSpan bar rows become full-width blocks, so every bar keeps working.
- Scrolling: the page under the layer keeps its scroll, so Back returns to the same place in the list.
  The page's "scroll the opened order into view" effect is skipped on the phone.

### i18n

New keys (16 locales, real translations): filter sheet title, "show N orders" footer, Encaisser,
back label, ⋯ label, tab labels Produits / Facturation / Client (Activité reuses `aito.history.title`).
No `{{count}}` keys (ru/uk/pl plural trap): use `{{n}}`.

### Tests

- Page: phone branch renders chips (counts, pressed state), filter sheet changes the URL filters, FAB
  starts the draft, opened order renders the full-screen view and Back/close clears `?order=`.
- `OrderMobileView`: tab switching keeps an open pick check; action bar label follows `nextStep`; Encaisser
  switches to Facturation; no primary without orders:update.
- Desktop tests stay green unchanged (matchMedia default = desktop in `__tests__/setup.ts`).
- Browser look at 390 px on the real dev stack (headless, read-only: opening orders only).

### Calls I made after the builder check (yours to overrule)

1. **Mounting**: Produits, Facturation and Client stay mounted and are hidden with `hidden` when not
   selected (desktop mounts all of them today, so no extra Zoho reads). Activité mounts only when
   selected (read-only history). A `?sms=1` link opens the order on the Client tab.
2. **Scan**: `useScan` listens only while Produits is the selected tab; an open bar keeps its state
   when hidden.
3. **Action bar**: finished orders have no primary step. "Encaisser" shows only with orders:update, a
   `payment`, and something left to pay; with neither button the bar is not rendered.
4. **"Also open for this customer"** swaps the order in place (`?order=` changes, Back returns to the
   previous order); the view is keyed by order id, so the tab resets to Produits and the body scrolls to top.
5. **Step start**: the page keeps owning `start` / `startTick` as today; `OrderCard` passes `onStart`
   to `OrderMobileView`, whose primary button calls it and selects Produits.
6. **"Chiffres" strip**: when toggled on in the filter sheet, it renders under the summary line.

## Constraints

- The uncommitted Aito-parity work in the main checkout touches `OrderSidePanel`, `OrderInvoicesBlock`,
  `OrderPaymentBlock`, `OrderContactBlock`; this build sits on top of it.
- Root rem is 14.4 px; sticky does not work inside the shell's `<main>`, hence the fixed layer.
- Browser baseline Safari 16.

## Left to the builder

- Exact Tailwind classes, the ⋯ sheet layout, the tab strip component (reuse `PanelTabs` styling if it fits).
- Whether the restyled table uses CSS grid or flex per row.
