# Revenue: one « Charges » tab, with Zoho depreciation

Date: 2026-11-25. Size: small change. Status: awaiting approval.

## Intent

The shop has three big charges: labour, fixed costs (rent, electricity) and the depreciation of its machines.
The first two are typed by hand in two separate panels of `/revenue`; depreciation is only approximated by the
calculator's usage-based wear. The owner wants the month's result to match the books: depreciation read from
Zoho Books' fixed assets, chosen asset by asset, and charged by the minute like rent.

## Goals

- One « Charges » panel holding three tables: labour, fixed costs, depreciation.
- Depreciation rows come from Zoho (`GET /fixedassets`); the operator switches each asset, or a whole Zoho asset
  type, on or off. Nothing is on by default.
- A selected asset is charged from its `depreciation_start_date` for `total_life` months, spread per day and by
  the minute during today, exactly like fixed costs.
- Each table shows a per-month and a per-minute figure; the panel shows the per-minute total.

## Non-goals

- The calculator and quotes keep their usage-based wear. Nothing there changes.
- Filament: no change now. Step 2 (separate spec) will show the gap between grams printed and Zoho stock
  adjustments with reason « Mise en Production », over a rolling 3 months, valued at the item's **dealer price**
  (`cf_prix_dealer_usd_unformatted`: supplier + freight + customs, the shop's cost price). Those adjustments also
  hold consumables (plates, PTFE adapters).
- No start date on fixed costs.

## Anti-goal

Counting the machines twice. Once at least one asset is selected, the print log's `wear` part leaves the Revenue
result and margins (all days). With none selected, the page behaves as today.

## Constraints and facts (read live from Zoho, 2026-11-25)

- 16 assets, two types: « Machine 3D » (12 printers, 3 013 477 F) and « Ordinateur » (4: 3D scanner, two
  workstations, a display, 901 893 F). All straight-line, monthly, 36 months, no sailing asset.
  All selected = 108 760 F a month, about 2.5 F a minute.
- The list call returns `asset_cost`, `depreciation_start_date`, `total_life`, `status`, `fixed_asset_type_name`:
  enough to compute the charge locally (`asset_cost / total_life` a month). Residual value is assumed zero.
- The current Zoho token already has access; no new scope.
- Zoho calls hit the real account: tests stub them.

## Approaches

1. **Zoho replaces wear on the Revenue page (chosen by the owner).** The result matches the books and an idle
   month shows its real cost. Repairs, which the wear rate included, drop out of the result.
2. Keep wear, add only non-printer assets from Zoho. No formula change, but a wrong tick double counts and an
   idle machine costs nothing.
3. Option 1 plus a line comparing wear billed by prints with real depreciation. Useful later; can be added
   without undoing 1.

Build: one sensible way, the fixed-costs mechanism again (a settings row, a per-day spread in
`services/revenue/production.py`) plus one Zoho read.

## Design

- **Storage.** One settings row `revenue_depreciation`: the trimmed asset list as last read from Zoho, the
  selected asset ids, and the read time. The result never calls Zoho.
- **Backend.** `ZohoService.list_fixed_assets`; `GET /revenue/depreciation` (stored list + selection),
  `POST /revenue/depreciation/refresh` (re-read Zoho), `PUT /revenue/depreciation` (selection). Same rights as
  fixed costs. The new settings key joins the ETag keys of the result routes.
- **Computation.** `depreciation_by_day(assets, today, today_share)` beside `fixed_by_day`; added to the day's
  costs as its own part `depreciation`; `wear` is zeroed when the selection is not empty. Only `status == active`
  assets count.
- **Result block.** Depreciation is its own line (my call: the owner names it as one of three charges) and counts
  with fixed costs and labour in the break-even.
- **Frontend.** One `RevenueCharges` panel replaces the two ⋯ menu entries; it reuses the labour and fixed-cost
  tables as they are and adds the depreciation table grouped by Zoho type, with a switch per row and per group
  and a « Actualiser » button. Opening the panel reads Zoho once when the stored list is empty.

## Left to the builder

Exact JSON shapes, i18n keys (all 16 locales), test layout, and the registrations the sweeps demand
(`NOT_A_ROW_UPDATE`, route classification if any).

## Known limits

- An asset sold in Zoho stops counting for past months too (the list carries no disposal date).
- Depreciation is spread per calendar day, not Zoho's exact pro-rata; month totals match, the first partial
  month may differ by a few francs.
