# Revenue page: five finance blocks (design, approved 2026-11-20)

## Intent

Make `/revenue` answer five more questions without leaving the page: do I make money, who owes me what and when
does cash arrive, why did sales move, who comes back, where do I lose quotes. Everything is computed from what is
already cached locally: **no new Zoho call**.

## Non-goals

- No historical late-payer ranking (paid invoices are not cached; only open ones are).
- No segment split in the quote funnel (sample too small).
- No automatic import of fixed costs from Zoho (the org is shared with the sailing business): typed by hand, 3D part
  only.
- No new permission: reads use `revenue:read`; margin figures need `revenue:view_margin`, customer figures
  `revenue:view_customers`; fixed costs are edited with `revenue:manage_targets`, like labour.

## Approaches

1. **One pure builder + one read route + one panel per block, like every existing block** (picked: it is the page's
   pattern, each block ships and tests alone).
2. One `/revenue/finance` payload for all five: fewer requests, but one slow part delays all and the ETags differ
   (cards vs day cache vs cash).
3. Compute in the browser from existing payloads: no payload carries per-customer or per-item history.

## Blocks

Each: pure function in `backend/app/services/revenue/`, `GET` route in `routes/revenue.py` with the existing ETag /
permission-stripping pattern, panel in `frontend/src/components/revenue/`, i18n in all 16 locales, entry in
`docs/revenue.md`, route count/classification in the permission tests.

### 1. Result and break-even (Évolution; needs `view_margin`)

- Fixed costs: list of `{label, monthly}` stored as a JSON `settings` row, edited in a panel modelled on
  `RevenueLabor` (`GET/PUT /revenue/fixed-costs`).
- Per month (last 12): `gross margin HT` (existing series) `− production costs − labour − fixed costs = result`.
  Current month: labour and fixed costs prorated to days gone, like labour today.
- Break-even: `(fixed + labour of the full month) ÷ contribution rate`, contribution rate =
  `(gross margin − production costs) ÷ revenue HT` of the month (trailing 3 closed months when the month's revenue is
  0). Shown as an amount, a % reached, and the day of the month it was crossed (cumulative daily revenue), or the
  projected day from the existing pace when not yet crossed.
- User call: labour counts as a fixed charge.

### 2. Aged receivables and cash forecast (Cash panel)

- From `revenue_invoice_shares` with the same 3D share rule as `outstanding()`: buckets not due / 1-30 / 31-60 /
  61-90 / 90+ days overdue; unknown shares stay in `unknown`.
- DSO = outstanding ÷ in-scope TTC invoiced over the last 90 days × 90.
- Per customer: open balance, overdue part, oldest days overdue (top 10 by overdue).
- Forecast: expected cash in 0-30 / 31-60 / 61-90 days = open balances by due date (overdue ones fall in 0-30) +
  accepted-not-invoiced order book (`quote_total − retainer_paid_total`) in 0-30, shown as two stacked parts.

### 3. Price / volume / mix (Produits)

- Period shown vs the previous period of equal length, in-scope lines grouped by item (qty, amount HT).
- Items in both periods: `volume = (q1 − q0) × p0`, `price = (p1 − p0) × q1`. Items only in one: `new` / `lost`.
  Mix = volume effect minus the effect of total-quantity growth at the old average price
  (`mix = Σ volume_i − (Q1 − Q0) × P0avg`, reported as volume = `(Q1 − Q0) × P0avg`). The four parts plus new and
  lost sum to the revenue change exactly; a test asserts it.
- Output: the bridge (previous → volume → mix → price → new → lost → current) and the top 10 items by absolute
  effect. Items with quantity 0 count in new/lost.

### 4. Cohorts and customers at risk (Clients; needs `view_customers`)

- Identified customers only (`customer_id != ""`), in-scope lines.
- Cohort = month of first in-scope purchase (existing `first_days_in_scope`), last 12 cohorts: size, % buying again
  in M+1…M+12 (cells past today are empty), cumulative revenue per customer.
- LTV: average cumulative revenue per customer at 12 months, by segment (`segment_of`).
- At risk: customers with ≥ 3 purchase days, days since last purchase > 1.5 × their median gap; sorted by 12-month
  revenue, top 20, with last purchase date, usual gap, 12-month revenue.

### 5. Quote funnel (Évolution, beside the order book)

- Aito cards with `quote_sent_at` in the last 12 months, trashed cards included: trashing a card declines its quote in Books, so it counts
  as declined (corrected 2026-11-21 on real data; `quote_status_before_trash` only serves a restore).
- Counts and totals: sent → accepted / declined / expired / still awaiting. Conversion in count and in value, both
  over decided quotes, with `n` shown.
- Median days `quote_sent_at → quote_accepted_at`.
- Same conversion by amount band (< 10 000, 10 000-50 000, > 50 000 XPF TTC).

## Left to the builder

Panel look (follow the neighbouring panels), exact route names, where the pure functions live among the existing
modules, band thresholds as named constants.
