# Build an "Order Board" page in this app

> The user's original brief, 2026-11-05, kept verbatim. The design that adapts it to this app is
> `2026-11-05-order-board-design.md`; where the two differ, the design wins.

I want you to rebuild a feature that exists in another of my back-office apps. This brief describes what it does, how it is laid out and how it works. It deliberately says nothing about colours, fonts, spacing or component libraries, because **the page must look and feel like the rest of this app**. Before writing anything, read two or three existing pages here and reuse their page header, cards, tiles, filter chips, badges, tables, empty states, loading skeletons, number/date formatting, data fetching and test setup. Where this brief names a colour (green, amber, red), it means "this app's success / warning / danger tone".

If something this brief relies on does not exist in this app (a data source, a sync mechanism, a page it links to), stop and ask me rather than inventing it.

## What the page is for

A reseller holds open customer orders and limited stock. The page answers one question each morning: **which orders can I ship today, and what is holding back the others?**

It lists every unfinished sales order. For each order line it works out whether the goods are on the shelf, on their way from a supplier, or not ordered at all, and it sums that up as one status per order. It is read-only: it never changes an order, a purchase order or stock.

## The data it works from

Three things, all read from data this app already stores. Map the fields onto what exists here.

- **Sales orders**: id, number, customer name, order date, status, total value. Each line: line id, item id, name, SKU, whether the item is stock-tracked, quantity ordered, quantity shipped, quantity cancelled, quantity invoiced.
- **Open purchase orders**: number, status. Each line: item id, quantity ordered, quantity already received, quantity cancelled.
- **Items**: id, name, SKU, brand, stock on hand.

Ground rules:

- Sales orders in draft or void status are ignored.
- A purchase order counts only while it is still open or partly received. Its incoming units per line are `quantity − received − cancelled`, never below 0. Add them up per item and keep the PO numbers that contribute. In my source system "received" is recorded by billing the PO, so use whichever field in this app actually means "these units have arrived".
- Negative stock on hand counts as 0.

## The mechanism: stock is handed out oldest order first

Stock is shared between orders, so a line cannot be judged on its own. Ten units on the shelf do not make two orders of eight both shippable. The rule is that **the oldest order is served first**, and a line's readiness is what is left after every older order has taken its share.

Put this in one pure function (orders, purchase orders, items, today's date in, board rows out) with no I/O, so it can be unit-tested.

1. Sort the orders by date, oldest first. Break ties by order number.
2. Keep two running pools per item: stock left (starts at stock on hand) and incoming left (starts at the item's incoming PO units).
3. Walk the orders in that sequence, and each order's lines in their own sequence. For each line:
   - `remaining = max(0, quantity − shipped − cancelled)`.
   - `invoiced = min(remaining, max(0, quantityInvoiced − shipped))`. In my source system stock leaves the shelf when the invoice is created, not when the parcel ships. Units that are invoiced but not yet shipped are therefore already set aside: they count as ready and must not be taken from the pool a second time. **Check how this app's source system behaves.** If stock only moves on shipment, treat `invoiced` as 0.
   - Then give the line a state:
     - The item is not stock-tracked, or the line has no item id: **Service**. It takes nothing from any pool and never blocks the order.
     - `quantity − cancelled` is 0: **Cancelled**.
     - `remaining` is 0: **Shipped**.
     - Otherwise take `fromStock = min(remaining − invoiced, stock left)` out of the stock pool. `covered = invoiced + fromStock` and `shortfall = remaining − covered`.
       - Shortfall 0: **Ready**.
       - Otherwise take `fromPo = min(shortfall, incoming left)` out of the incoming pool. If that covers the whole shortfall the line is **Backorder** (the goods are on a purchase order). If not, it is **To order** (somebody has to buy them).
   - Record on the line: `stockAvailable` (what the stock pool held just before this line took from it), `covered`, `shortfall`, `coveredByPo` (= `fromPo`), and the item's PO numbers **only when `coveredByPo` is above 0**. Without that condition, a line whose purchase order was already used up by an older order would still print that PO number, suggesting goods are coming for it when they are not.
4. Roll the lines up into one order status, looking only at "live" lines (not Shipped, Cancelled or Service):
   - No live line: the order is finished. Leave it off the board.
   - Every live line Ready: **To ship**.
   - Some Ready, some not: **Partial**.
   - None Ready and at least one To order: **To order**.
   - None Ready and all Backorder: **Incoming**.
5. Unit counts per order, over stock-tracked lines only. They feed the progress bar:
   - `total` = Σ (quantity − cancelled)
   - `shipped` = Σ shipped
   - `ready` = Σ remaining of Ready lines, plus Σ covered of short lines (the part of a short line that is on the shelf counts as ready)
   - `backordered` = Σ shortfall of Backorder lines
   - `toOrder` = Σ shortfall of To order lines
   - `readyRatio = ready / (ready + backordered + toOrder)`, or 1 when nothing is owed
   - `ageDays` = whole days from the order date to today, never negative

A worked case to use as a test. Item A has 5 in stock and one open purchase order, PO-0012, with 4 units incoming.

| Order | Date | Wants | From stock | Short | From PO | Line state | Shown beside the state |
|---|---|---|---|---|---|---|---|
| SO-1 | 3 Jan | 4 | 4 | 0 | – | Ready | – |
| SO-2 | 5 Jan | 3 | 1 | 2 | 2 | Backorder | PO-0012 · +2 |
| SO-3 | 9 Jan | 5 | 0 | 5 | 2 | To order | PO-0012 · +2 |
| SO-4 | 10 Jan | 1 | 0 | 1 | 0 | To order | nothing |

SO-2 has `ready` 1, `backordered` 2 and a ready ratio of 33 %. Its only live line is not Ready, so the order reads Incoming.

Also cover in tests: the order-number tie-break, invoiced units counting as ready without touching the pool, Service / Cancelled / Shipped lines, each branch of the roll-up, and a finished order being left out.

Write filtering, sorting and the summary counts (described below) as pure functions too, with tests.

## Serving the data

Compute the board on the server from stored data and keep the result, so that opening the page costs one cheap local read and never a round of calls to the ERP. If this app already keeps a synced copy of orders, purchase orders and stock, recompute the board whenever that copy changes.

The read endpoint returns the rows, the time the board was last computed, the time stock was last loaded, and the sync status if this app has one (running, documents still pending, last error).

One rule matters more than the rest: **an empty or half-built board must never look like a verified answer.** The page counts as ready only when the rows have arrived, the board has been computed at least once, and stock has been loaded at least once. A board computed against an empty stock table shows every line as To order, which looks like a fact and is not one.

## Page layout, top to bottom

**Header.** The page title. On the right, either "Syncing · N remaining" with a spinner while a sync is running or has documents pending, or "Updated <date and time>" otherwise. Then a Refresh button that asks the server for one bounded sync pass and re-reads the board.

**Sync failure notice.** Shown only when the last sync failed: "Last sync failed: <reason> — showing data from <time>." The page keeps showing the last good board underneath.

**Five summary tiles in a row.** Each is a button that sets the status filter. The active one is highlighted. Each carries its status tone as an accent.

| Tile | Number | Small text |
|---|---|---|
| To ship | orders that are To ship | everything in stock |
| Partial | Partial orders | partly shippable |
| Incoming | Incoming orders | shortfall covered by a PO |
| To order | To order orders | shortfall with no open PO |
| In progress | all orders (clears the filter) | total value of those orders |

**Toolbar**, one row that wraps on narrow screens:

- A search box, "Order number, customer, product, SKU…". It ignores case and accents and matches the order number, the customer name, or the name or SKU of any line.
- A **core-brands toggle** (called "3D only" in my app), on by default. It hides orders that have no line from a configured list of core brands, so the board shows the main business and not the side lines. The list is a config constant. Mine is Bambu Lab, eSUN, SUNLU, Polymaker, Inslogic, Magigoo, compared without regard to case. Classification is by item brand only: an item with no brand, an item missing from the catalogue and a Service line never count. Remember the choice in the browser, and read it after the page has mounted so the server and the browser render the same first frame. While it is on and hiding orders, show a muted "+N hidden" inside it. If this app has no equivalent notion of core brands, ask me before building it.
- Status chips: All, To ship, Partial, Incoming, To order, each with a count.
- A sort control: Age (default, oldest first), Value (highest first), Customer (A to Z, locale-aware), % ready (highest first). Clicking the active one flips its direction, shown by an arrow. An order with no known value sorts as 0.

How the numbers relate, which is easy to get wrong:

- The tiles and the total value follow the brand toggle but **not** the search box and not the status filter.
- The chip counts follow the search box and the brand toggle, but not the status chip itself.
- The list follows all three.

**The order list.** One card per order, collapsed at first. The whole collapsed row is the button that expands it. Its columns:

1. Order number.
2. Customer name, with the order date beneath it.
3. Age in days: neutral up to 20, warning from 21 to 45, danger above 45.
4. A stacked progress bar of the order's units: shipped (neutral), ready (green), incoming (amber), to order (red). Beneath it, "X/Y shipped" on the left and "Z % ready" on the right.
5. The status badge.
6. The order value, right-aligned, or a dash when unknown.
7. A chevron that turns when the row is open.

**The expanded panel.** A table of the order's lines:

| Column | Content |
|---|---|
| Product | name, with the SKU beneath it |
| Qty | quantity ordered, as "shipped/ordered" once something has shipped, plus a small "invoiced" tag when invoiced units are waiting to ship |
| Available | `stockAvailable`: what was left on the shelf for this line after older orders. Green when the line is Ready, a dash for a Service line |
| Short | "−N" in amber for Backorder, red for To order, otherwise a dash |
| State | the line state, and for a short line that drew from purchase orders, the PO numbers and the units drawn: "PO-0012, PO-0015 · +3" |

Shipped, Cancelled and Service lines are dimmed. Under the table, two links:

- "Open in <ERP>", to the order in the source system, if this app knows how to build that URL.
- "View in Back Orders", shown only when the order has a To order line with a SKU. It opens this app's back-order or purchasing page filtered on the first such SKU. Leave it out if there is no such page.

**What the list area shows**, checked in this sequence:

1. Loading failed: the error and a Retry button.
2. Not ready yet: skeleton rows. Once a first response has arrived, add "First sync in progress — N documents remaining".
3. No orders at all: "No open orders. Every customer order has shipped."
4. The brand toggle is on, hides everything, and no search or status filter is set: "No open 3D orders. Turn off '3D only' to see the other orders."
5. The search or filters match nothing: "No results."

The tiles show skeletons in place of numbers until the page is ready.

## Keeping it current

- Poll the read endpoint every 4 seconds while a sync is running, has documents pending or has never run, and every 60 seconds once it has caught up.
- A background refresh swaps the numbers in place. It must not blank the list or flash skeletons over a board someone is reading.
- Refresh runs one bounded sync pass, not a full re-download.

## Done when

- The allocation, roll-up, filter, sort and summary functions have tests, including the worked case above, and they pass.
- The page uses this app's existing components and matches its other pages, including at narrow widths.
- You have opened it against real or seeded data and checked two things by hand: an older order takes stock ahead of a newer one for the same item, and a cold start shows the loading state rather than an empty or all-red board.

Tell me which parts you had to adapt because this app's data differs from what this brief assumes.

Add in Navbar and a special tab for it in settings
