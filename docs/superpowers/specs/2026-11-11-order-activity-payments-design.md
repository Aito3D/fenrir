# Order Board: activity history, bell alerts, payments, tracking link

Date: 2026-11-11. Status: draft for the user's read.
Mockup (history): `2026-11-11-order-activity-demo/index.html`. The user chose **A, a tab beside Details**.

The four features share one thing: the order's **event log**. History shows it, the bell is fed from it, and
payments and tracking views write into it. So the log is built first.

Build order: **1 history → 2 bell → 3 payments + retainer → 4 tracking link** (mockup first, it is customer-facing).
All of it starts after the `order-board-polish` branch lands.

---

## 1. Activity history (tab "Activité")

**Storage.** A new table, `order_board_events`, shaped like `aito_events`: `id`, `salesorder_id` (str 64, indexed
with `occurred_at, id`), `occurred_at`, `kind`, `actor_class` (user / client / system), `actor_name`, `changes`
(JSON list of `[field, before, after]`), `detail` (JSON), `note`, `created_at`.
Why not reuse `aito_events`: every Aito query and the inbox fan-out assume an `AitoProject` exists. Making
`project_id` nullable would touch all of them, and a miss would fail silently. A sibling table costs about 15 lines.

**Recording.** `order_board_events.record(db, salesorder_id, kind, …)` uses the same rules as Aito's `record()`:
it refuses kinds that aren't registered, does not commit, and runs inside the writer's transaction. A row is only
written once the Zoho write has succeeded.

| Kind | Depth | Written by |
|---|---|---|
| `order.received` (Shopify / direct / quote no.) | story | sync, the first time it sees the order (`occurred_at` = Books `created_time`) |
| `order.ready` (stock arrived, now To ship) | story | recompute, when the status moves to `to_ship` |
| `package.created`, `handover.delivered` / `.shipped`, `invoice.created`, `payment.received`, `order.cancelled`, `order.finished` | story | Fenrir writers / sync |
| `picklist.created`, `order.edited`, `package.edited`, `invoice.emailed`, `sms.sent`, `payment_link.sent`, `terminal.started` | detail | Fenrir writers |
| `prep.printed`, `tracking.viewed`, `zoho.edited` (a change made in Books or Shopify, seen by the sync, no author) | everything | writers / sync |
| `note.added` | story | note box |

`zoho.edited`: when the sync stores a fresh detail for an order **not** marked by `note_write`, it compares the
lines (quantity, item) and the expected shipment date against the previous copy and logs the difference. Changes
caused by our own writes are skipped because of the `note_write` window.
`payment.received`: the order's paid amount (invoices + linked retainers, see §3) went up between two passes.

**Routes** (`orders:read`; the note needs `orders:update`):
`GET /order-board/orders/{id}/events?depth&before&before_at&limit` (the same two-part cursor as Aito), and
`POST /order-board/orders/{id}/events` {note}.

**Frontend.** The side column gets the Details / Activity tab strip (`usePanelTab`-style memory). `ActivityRail`
and `useProjectEvents` take a small source object (`{key, fetchPage, addNote}`) in place of `projectId`, so Aito and
orders share the rail, the depth toggle and the note box. Order kinds get their own label map beside
`eventKinds.ts`. The order row shows the latest event under the customer name ("Marie · SMS de retrait · il y a 2 h").
That needs one extra field on the board row, `last_event`, filled in a single query when the board is read.

---

## 2. Bell alerts

Two inbox kinds, family `orders`, both on by default and switchable in the existing inbox preferences:
- `order.ready`: stock arrived and the order can now be prepared. This is the main one.
- `order.new`: a new order arrived from Shopify or Books.

Recipients: every user with `orders:read`, not the person who caused it (the direct-insert pattern of
`printer_hours`, no watch list; a per-order watch can come later). Fed from `record()` for these two kinds.
`Notification` gains a nullable `target_ref` (str 64, one additive ALTER) because Zoho ids don't fit the int
`target_id`. `inboxTarget` maps `order` → `/orders?order=<id>`, a deep link that already exists.
Guard: when Zoho resyncs from scratch (the first pass after a restart, or a reset), `order.new` must not fire for
every open order. It only fires for orders created after the sync's previous success.

---

## 3. Payments from the order ("like Aito") + retainer through the quote

**Which Books document gets paid** (Heimdall books the payment itself, given `{type, id}`):
1. The order has an invoice with a balance → **the invoice** (the newest one with a balance). This is the usual
   counter flow: hand over → invoice created → TPE.
2. No invoice yet and the order has a quote (`estimate_id`) → a **retainer invoice on the quote**, through the same
   path Aito uses (retainer `reference_number` = quote number).
3. No invoice and no quote (Shopify orders, normally already paid on Shopify) → no payment buttons. *(Ask if
   needed.)*

**UI.** The Paiement block gets Aito's two buttons, **Lien de paiement** and **TPE**, prefilled with "left to pay"
(editable, capped at the document balance), plus Aito's `PaymentLinkModal` / `TerminalPaymentModal`. The link
goes out by SMS through the existing order SMS path, or is copied. Admin and operator (`orders:update`).

**Backend.** `resolve_document` and the payment-link / terminal services take a small "payer" object
(`quote_id, quote_number, customer_id, number`) instead of an `AitoProject`. The Aito call sites pass one built
from the project, and the order routes build one from the stored sales order. Both ledger tables gain a nullable
`salesorder_id`. Idempotency keys for orders are `order:{so_id}:{n}`. Status polling stays in Aito's existing
sweeps. A settled payment writes `payment.received` and refreshes the order.

**Retainer through the quote (the user's 2.8 rule).** `order_payment` counts as paid: invoice payments + **paid
retainers linked to the order's quote** (`reference_number` = quote number, or in the estimate's
`retainerinvoices[]`), read with Aito's `list_project_retainers` through the same payer object. Customer credit
that no retainer explains stays a customer-wide "avoir" shown once in the block. It no longer counts as paid on
every open order. That ends the double counting from 2.8.

---

## 4. Customer tracking link (mockup first)

The current `/t/` page needs an Aito project, and orders have a different life cycle (prepared → ready to collect →
handed over). Plan: a token on the order (a `track` row in `order_board_docs`, minted the first time a link is
asked for), a public `GET /order-board/track/{token}` (rate-limited, the same 404 for every failure, added to
`PUBLIC_API_PREFIXES`) that returns status, lines with quantities, left to pay, and an open payment link if there is
one. The page reuses the `/t/` shell and its motion with an order step rail: *Commande reçue → En préparation →
Prête à retirer → Remise*. The pickup SMS template gains the link. Each open writes `tracking.viewed`.
A mockup in Brave comes before any build, because customers see this page.

---

## Owed / risks
- None of the order writes has been run live yet. Payments add Heimdall calls on top: the first watched run should
  include one TPE payment on a real invoice.
- Do Heimdall's terminal and link endpoints accept a Books **invoice** for an order with no Aito card? The code says
  the document is generic; it has never been tried outside Aito.
- `zoho.edited` diffing only covers lines and the shipment date at first; other fields can be added later.
