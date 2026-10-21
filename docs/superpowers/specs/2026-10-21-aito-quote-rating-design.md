# Aito client quote rating — design

2026-10-21. A second rating beside the payment rating
(`2026-09-22-aito-client-rating-design.md`) in the new-card drawer's Client
section.

## Why

Some clients ask for many quotes and accept few. The shop wants to see that
before it spends time on the next quote, and give its attention to clients who
say yes readily. The payment rating answers "will they pay"; this one answers
"will they say yes".

## Rule

Source: every Zoho Books estimate for the customer
(`zoho_service.list_customer_estimates`, paged, newest first), within the same
24-month window as the payment rating (by estimate date; undated rows are kept).

| Books status | Counts as |
|---|---|
| `accepted`, `invoiced`, `partially_invoiced` | yes |
| `declined` | no |
| `expired` | no (a quote left unanswered cost the same time) |
| `sent`, `viewed` | pending: shown in the tooltip, not scored |
| `draft`, `void`, anything else | ignored |

Score = smoothed acceptance rate `(yes + 3) / (yes + no + 6)`: every customer
starts as if they had 3 yes and 3 no, so a thin record stays near 50 % and a
long one dominates. This is what makes "2 asked, 2 declined" milder than
"20 asked, 18 declined".

| Tier | Score |
|---|---|
| good | ≥ 0.60 (two straight yes) |
| medium | 0.35 – 0.60 |
| bad | < 0.35 (three straight no, or a long mostly-no record) |
| new | nothing decided yet |

Examples: 0/2 → 0.375 medium; 2/20 → 0.19 bad; 0/4 → 0.30 bad; 1/6 → 0.33 bad;
3/3 → 0.67 good; 6/10 → 0.56 medium; 7/10 → 0.63 good.

## Shape

- `GET /api/v1/aito/clients/{id}/quote-rating` (`aito:read`), its own rate-limit
  bucket on the payment rating's budget, same id-shape check.
- `services/aito_quote_rating.py`: pure `rate_quotes` + cached
  `read_client_quote_rating` (table `aito_client_quote_ratings`, 1 h TTL,
  `refresh` ignored under 60 s). Never raises: Books down → stale row or
  `unavailable`. The walk-in default contact is always `new`. An empty history
  is answered `new` and not cached, so an unknown id leaves no row.
- Frontend: `useClientQuoteRating` + `ClientQuoteRatingPill` (document glyph in
  place of the payment pill's dot, same tier colours/words), rendered after the
  payment pill in `ClientSection`'s combobox trailing slot. Tooltip:
  "Bad — 2 of 20 quotes accepted · 3 never answered · 1 awaiting an answer ·
  checked 5m ago". i18n `aito.quoteRating.*` in all 15 locales.

## Not done

- The panel masthead (ring) shows only the payment rating.
- The thresholds and prior are constants in the service; not a setting.
