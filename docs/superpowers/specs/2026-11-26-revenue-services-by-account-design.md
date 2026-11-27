# Revenue: services defined by the Zoho sales account

## Intent

On `/revenue`, "Services" must mean what the accounts call services: everything sold on Zoho account
**70610000 – O'SEA Prestation de service Aito 3D** (account id `66407000004504242`), instead of "items whose Zoho
type is `sales`". The owner compares the page with the chart of accounts and the two disagree.

## Measured on 2026 (read-only Zoho calls, 2026-11-26)

| | HT |
|---|---|
| Account 70610000 in Zoho (credits − debits) | 13 229 701 |
| Fenrir, items whose sales account is 70610000 | 12 257 265 |
| Fenrir today (item type `sales`) | 12 096 159 (as shown on the page) |

- Ten items point at the account: the nine current services plus `Usinage - Vente "AITO 3D"` (type `inventory`,
  274 805 in 2026), today counted as goods. All ten have brand `Aito3D`, so all are already in the 3D scope.
- No hand-typed invoice line posts money to the account: lines without an item are 0 F headings.
- The rest of the gap is discounts. Zoho posts the price before discount to 70610000 and the discount to
  **707001 – Remise**; the sales-by-item report Fenrir reads is after discount. Account 707001 carries 886 817 on the
  2026 invoices that touch 70610000 (an upper bound: a mixed invoice can discount goods too). About 52 000 was
  three invoices of the day before, not yet cached; about 33 000 is not broken down.

## Goals

- Service or goods is decided by the item's Zoho sales account, everywhere the page splits the two (filter, charts,
  product list, sales log, services per machine hour, services margin).
- The services figure stays **after discount** (owner's decision): what customers paid.
- The owner can check the page against the account without opening Zoho.

## Non-goals

- Reading every invoice to attribute discounts line by line.
- Changing the 3D scope rules (nature, brand, hand decisions).
- A setting for the account: it is a constant beside `REVENUE_PASSAGE_CUSTOMER_IDS` in `revenue/config.py`.

## Approaches

- **A. The item's sales account** (picked). The item sync already receives `account_id`; keep it, and
  `is_service_item` compares it with the configured account. Keeps natures, customers, products, margin and the cash
  3D share. Blind to a line whose account was changed on the invoice; none found in 2026.
- **B. The account's ledger entries.** Matches Zoho by construction but an entry only says invoice, customer, amount:
  no item, so no nature split, product filter or margin without ~1 100 invoice reads a year. And it is before
  discount, which the owner does not want as the headline.
- **C. A plus the ledger as a control** (picked for part 2). Detail from A, one extra figure from the ledger.

## Design

### Part 1 – classification (ship first)

- `revenue_items.account_id` (new nullable column, ALTER TABLE in `run_migrations`), filled by `_item_row` from the
  item listing's `account_id`. Carried on `ScopeItem`.
- `is_service_item(item)` = `item.account_id == REVENUE_SERVICE_ACCOUNT_ID`. `item_type` no longer decides.
- `service_nature` keys on the same account test instead of `item_type == "sales"`, and its name pattern also accepts
  `- Vente "AITO 3D"`, so `Usinage - Vente` falls under nature « Usinage » instead of « No category ».
- `replace_items` already detects item changes that affect classification; add `account_id` to that comparison.
- Until the next item sync fills the column (≤ 10 min after deploy, `items_ttl_s`), every item reads as goods.
  The migration does not back-fill; the first sync does.
- Consequence to accept: an in-scope item of type `sales` that is not on the account becomes goods. None exists today
  among the automatic rules; a hand-included one would move.
- Tests: `is_service_item` and `service_nature` on account / no account / `Vente` name; sweep fixtures that build
  `ScopeItem(item_type="sales")` to mean "service".
- `docs/revenue.md`: replace the "type `sales`" wording.

### Part 2 – account control line (after part 1 is checked on real data)

- A sync step reads the account's entries (`GET /chartofaccounts/transactions?account_id=…`, 200 per page; the date
  filter was not honoured in the probe, so page through and bucket by `transaction_date`), at most once a day, paced
  like the other steps, and stores credits − debits per month.
- The page shows, when the Services filter is on: « Compte 70610000 : X avant remise · Fenrir : Y après remise ·
  écart Z (remises) ». No attempt to split the gap further.
- New strings in all 16 locales.

## Left to the builder

- Where the per-month account totals are stored (a column on `revenue_month_checks` or a small table).
- Exact placement and wording of the control line.
