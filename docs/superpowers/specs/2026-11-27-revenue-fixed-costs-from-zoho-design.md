# Revenue: fixed costs read from Zoho's class 6 accounts

Date: 2026-11-27. Follows `2026-11-25-revenue-charges-design.md` (the « Charges » dialog) and
`2026-11-26-revenue-services-by-account-design.md` (goods vs services by sales account).
Mock-up the user approved: `.superpowers/brainstorm/20670-1795774811/content/charges-fixes-zoho.html` (gitignored,
local; the layout and behaviour count, not the colours).

## Intent

The company keeps one set of books in Zoho for several activities (3D printing, sailing, import). Aito 3D carries
only a share of each expense. Today the « Charges fixes » table of `/revenue` is typed by hand
(`{label, monthly}`), so it drifts from the books. The user wants `/revenue` to follow the books as they stand now:
fixed costs come from Zoho's expense accounts, the user only says which share of each account is Aito 3D's and how
that share splits between goods and services.

The page must never show a positive month when it is negative only because a usual charge (the rent) is not entered
yet, and it must always tell a real figure from a projected one.

## Goals

- The hand-typed fixed-cost list is gone. The « Charges fixes » block of the Charges dialog lists every Zoho account
  whose code starts with `6`.
- Per account: the amount entered this month, the last 12 months, a share for Aito 3D in % (default 0), a type, and
  one slider that splits the share between goods and services.
- A month's fixed costs are the books' real amounts of that month times the shares. Closed months are exactly Zoho.
- The current month projects the usual amount of a monthly account that is not (fully) entered yet, shown apart from
  the real figure everywhere.
- Every charge is spread to the minute, as fixed costs are today.
- With the page's goods/services filter, only that side's part of the fixed costs is charged.

## Non-goals

- No history of shares: today's share, type and split apply to every month shown (as today's list has no start date).
- No goods/services split for labour or depreciation.
- No projection for closed months, for annual or one-off accounts, or from Zoho's recurring expenses.
- No automatic guess of an account's type.
- The old amounts are not migrated: past months are recomputed from Zoho.

## Anti-goals

- A real figure and a projected figure merged into one number with no way to tell them apart.
- A share silently applied to an account the page already counts elsewhere (double counting without a warning).
- A Zoho failure that empties or zeroes the charges: the last read stays in use, with its date shown.

## Facts measured live on 2026-11-27 (read-only)

- `GET /chartofaccounts` (one page, 173 accounts): 89 have a code starting with `6`, all `account_type: expense`.
  Rows carry `account_id`, `account_code`, `account_name`, `is_active`, `parent_account_id`, `depth`.
- **Account codes are not unique** (`60431000` is both « Autres frais » and « Prestations de services - Extérieur
  AITO 3D »): key everything by `account_id`.
- `GET /reports/profitandloss?from_date=YYYY-MM-01&to_date=YYYY-MM-DD` honours the dates and returns a tree
  (`profit_and_loss[] → account_transactions[] → …`). Leaf rows carry `account_id`, `account_code`, `name`, `total`,
  `total_sub_account`, `is_child_present`. Class 6 accounts appear in two sections (« Coût des marchandises vendues »
  and « Dépenses d'exploitation »). Only non-zero accounts are listed. Totals can be negative (credit notes). Basis is
  accrual. One call gives a whole month.

## Design

### Account types

| Type | Example | Charge of month M (before the share) | Projected |
|---|---|---|---|
| `monthly` (default) | rent, electricity | the amount entered in M | current month only: `max(entered, usual)`, where `usual` is the mean of the 3 closed months before it; the part above `entered` is the estimate |
| `annual` | insurance | sum of the 12 months ending with M, ÷ 12 | never |
| `one_off` | equipment, screws | the amount entered in M | never |

- An account with share 0 has no type and no slider in the UI and charges nothing.
- `charge = amount × percent / 100`; goods part `= charge × goodsShare / 100`, services part the rest. The estimate
  splits the same way.
- A negative `usual` or `entered` is used as is, but an estimate is never negative.
- *(My calls.)* `usual` is always the sum of the 3 closed months before the current one ÷ 3, months without an entry
  counting 0: an account that started last month is projected at a third until it has history. The annual roll
  always divides by 12, even with less history.

### What replaces the single monthly figure

Today one number (`fixed_monthly`) feeds every month row of `build_result`, the day spreading and the break-even.
It becomes a per-month amount *(my calls)*:

- each of the 12 month rows of the Result panel carries its own month's fixed costs (all 12, as today, including
  the rows flagged `partial`); the daily spreading still starts at `COSTS_START`;
- the current month's row is pro-rated to the minute as today, the real part and the estimate alike, so « Résultat
  réel Zoho » of the running month is the real charges pro rata, not the full amounts entered;
- `charges.fixed` / `fixedMonthly` of the result response and the per-minute figure are the current month's full
  fixed costs, real plus estimate, with the estimate also given on its own.

### Spreading

Unchanged from today's `fixed_by_day`: a month's charge (real plus estimate) is spread evenly over its days; in the
current month whole days up to yesterday plus today's share count, so it grows by the minute. This holds for one-off
accounts too: an entry dated the 12th weighs on every day of its month.

The estimate travels as its own cost part (`fixedEstimated`, next to `fixed`, which stays real only), so every
consumer can show it apart.

### Break-even of the current month

`(fixed of the full month, real plus estimate, one-offs already entered included) + labour + depreciation`, then as
today. A one-off raises the break-even as soon as it is entered in Zoho; it is never guessed before.

### Goods / services filter

Today `build_revenue_series` drops all production costs under `kind == "goods"` (and under an item, brand or segment
filter) and keeps all of them under `kind == "services"`. New rule, fixed costs only:

- no filter: goods part + services part;
- `kind == "services"`: services part of the fixed costs, with labour, depreciation and printing costs as today;
- `kind == "goods"`: goods part of the fixed costs only (no labour, depreciation or printing, as today);
- item, brand or segment filter: no fixed costs, as today.

The Result panel (`GET /revenue/result`: 12 months and break-even) is global today and stays global.
*(My call: the user spoke of the revenue filter; the mock-up put the filter above the result block for illustration.)*

### Real vs projected on the page

- Current month in the Result panel: two figures side by side, « Résultat réel Zoho » and « Résultat avec
  projection » (the emphasised one), with « dont X F de charges estimées, pas encore saisies ». Closed months: one
  figure.
- Charts and table: the estimated part of the fixed costs is drawn hatched / marked « ≈ », never merged with `fixed`.
- Charges dialog summary row « Charges fixes »: real + estimated, with the estimated amount stated.

### The « Charges fixes (Zoho) » table

Columns as in the mock-up: account (code + name, ⚠ when flagged) · this month · 12 months · share % (number, 0–100)
· type (select) · goods ↔ services (one range input, both percentages shown, default 50/50, step 5) · Aito 3D's
charge of the month (estimate marked, with « dont X F estimés », « lissé sur 12 mois » or « réel »).
Footer: real entered · estimated · month total · per minute · goods part · services part.
Header: read date, « Actualiser depuis Zoho », « Enregistrer » (the whole configuration is saved at once, as the
other charge tables do). Read-only without the manage right. Accounts with a share sort first, then by code.

⚠ (warning only, the share stays editable) on codes starting with `60` (purchases, cost of goods: already in the
items' cost), `64` (staff: already in labour), `68` (depreciation charges: already in depreciation).

Listed: active class 6 accounts, plus any account that has a saved share even if it became inactive. Amounts are an
account's own total, not its children's (`total`, not `total_sub_account`).

### Data and freshness

- Configuration: one Settings JSON row (pattern of `revenue_depreciation`), `{account_id: {percent, type,
  goodsShare}}`. The old `revenue_fixed_costs` row is no longer read; its routes and UI are removed.
- Cache of Zoho amounts: per month, `{account_id: total}` plus the account list and a read date, stored like the
  depreciation asset list (no new table unless the builder finds the Settings row unfit).
- Months needed: the 12 shown plus the 11 before (annual accounts roll over 12 months), so 23 monthly calls on the
  first read.
- Closed months come from the cache. The current month is re-read when `/revenue` is opened and the last read is
  older than 15 minutes. « Actualiser depuis Zoho » re-reads all 23 months and the account list (back-dated entries).
- Zoho not configured or failing: the cache stays as it is, the UI shows its read date and the error; nothing is
  zeroed. Never log the upstream message (it can carry credentials), as `refresh_depreciation` does.
- The cache stamp of the revenue responses must move when the configuration or the cached amounts change
  (`store.py` stamp and the `/result` stamp list both name `revenue_fixed_costs` today).
- Rights: reading as the other charges; saving and refreshing under `_MANAGE_CHARGES`.

## Approaches considered

- **A. Three types (monthly, annual, one-off) — chosen.** Closed months equal Zoho, a late rent is projected in the
  current month, an annual insurance is diluted. Costs one more choice per account and the projection logic.
- **B. Two types (recurring = always last 12 months ÷ 12, one-off).** Simpler, no projection needed; rejected by the
  user and by me: the month shown never matches the month's account, and a rent rise takes a year to show, against
  the real-time aim.
- **Alert only, no projection.** Faithful to the franc, but the headline can stay green wrongly, the very thing to
  avoid.
- **Zoho recurring expenses as the projection source.** More exact than a mean but only covers what is declared
  recurring; not verified; left out.

The user chose: real amounts month by month; projection for the current month with the real and projected figures
kept apart; annual charges diluted; one-offs counted in the break-even once entered; charges split goods/services
and following the filter.

## Left to the builder

- Module and route names, the exact JSON shapes, whether the cache is one Settings row or a table.
- How the page triggers the 15-minute re-read of the current month (the page must not block on Zoho to render).
- Hatching in the charts (recharts) and the exact wording; i18n in every gated locale.
- Reusing a house slider if one exists, else a native range input with an accessible name per account.
- Sweeping other readers of the old fixed-cost list (tests, fixtures, the MCP revenue tools, `docs/revenue.md`).

## Known limits

- A usual charge entered after its month has closed leaves that closed month too good until it is entered: closed
  months are never projected (user's decision).
- A share changed today rewrites the past months shown.
- Zoho posts by entry date: a rent dated in the wrong month lands in the wrong month here too.

## Tests

- Pure functions: charge per type, the estimate (none when entered ≥ usual, partial entry, no history), the 12-month
  roll, the goods/services split, duplicate account codes.
- Series: the three filter cases; `fixed` stays real and `fixedEstimated` carries the estimate.
- Routes with Zoho stubbed: read, save validation (percent and goodsShare 0–100, known type), refresh failure keeps
  the cache.
- Frontend: the table (share 0 hides type and slider, totals follow edits, ⚠ rows), the two result figures.
