"""Fixed costs read from Zoho's class 6 accounts: what one month charges to 3D printing.

The books are shared with other activities, so the operator gives each account a share (`percent`), a type and a
goods/services split (`goodsShare`). Accounts are keyed by Zoho's account id: its codes are not unique.
"""

from dataclasses import dataclass

TYPES = ("monthly", "annual", "one_off")
USUAL_MONTHS = 3

Config = dict[str, dict]  # account id -> {"percent", "type", "goodsShare"}
Months = dict[str, dict[str, float]]  # "YYYY-MM" -> account id -> the account's total of that month

# Accounts the page already counts elsewhere: a share there would charge them twice.
_FLAGS = (("60", "purchases"), ("64", "staff"), ("68", "depreciation"))


@dataclass(frozen=True)
class Charge:
    """`real` is entered in the books; `est` is a usual charge the running month still misses."""

    real_goods: float = 0.0
    real_services: float = 0.0
    est_goods: float = 0.0
    est_services: float = 0.0

    @property
    def real(self) -> float:
        return self.real_goods + self.real_services

    @property
    def estimated(self) -> float:
        return self.est_goods + self.est_services

    @property
    def goods(self) -> float:
        return self.real_goods + self.est_goods

    @property
    def services(self) -> float:
        return self.real_services + self.est_services

    @property
    def total(self) -> float:
        return self.real + self.estimated

    def __add__(self, other: "Charge") -> "Charge":
        return Charge(
            self.real_goods + other.real_goods,
            self.real_services + other.real_services,
            self.est_goods + other.est_goods,
            self.est_services + other.est_services,
        )


def months_before(month: str, n: int) -> list[str]:
    """The `n` months before `month`, oldest first."""
    index = int(month[:4]) * 12 + int(month[5:7]) - 1
    return [f"{i // 12:04d}-{i % 12 + 1:02d}" for i in range(index - n, index)]


def _entered(months: Months, account_id: str, month: str) -> float:
    return months.get(month, {}).get(account_id, 0.0)


def usual(months: Months, account_id: str, month: str) -> float:
    """Mean of the three months before; a month without an entry counts 0."""
    return sum(_entered(months, account_id, m) for m in months_before(month, USUAL_MONTHS)) / USUAL_MONTHS


def rolling_year(months: Months, account_id: str, month: str) -> float:
    """Sum of the twelve months ending with `month`."""
    return sum(_entered(months, account_id, m) for m in [*months_before(month, 11), month])


def account_charge(cfg: dict, months: Months, account_id: str, month: str, current: bool) -> Charge:
    """Only the running month (`current`) projects, and only a monthly account."""
    share = cfg.get("percent", 0) / 100
    kind = cfg.get("type")
    if share <= 0 or kind not in TYPES:
        return Charge()
    entered = _entered(months, account_id, month)
    estimated = 0.0
    if kind == "annual":
        real = rolling_year(months, account_id, month) / 12
    else:
        real = entered
        if kind == "monthly" and current:
            estimated = max(0.0, usual(months, account_id, month) - entered)
    goods = cfg.get("goodsShare", 50) / 100
    real, estimated = real * share, estimated * share
    return Charge(real * goods, real * (1 - goods), estimated * goods, estimated * (1 - goods))


def month_charge(config: Config, months: Months, month: str, current: bool) -> Charge:
    total = Charge()
    for account_id, cfg in config.items():
        total += account_charge(cfg, months, account_id, month, current)
    return total


def flag(code: str) -> str | None:
    return next((name for prefix, name in _FLAGS if code.startswith(prefix)), None)


def _is_class6(code: object) -> bool:
    return isinstance(code, str) and code.startswith("6")


def class6_totals(report: dict) -> dict[str, float]:
    """Each class 6 account's own total in a Books profit-and-loss report, by account id.

    The report is a tree of sections; expense accounts sit under both « Coût des marchandises vendues » and
    « Dépenses d'exploitation ». `total` is the account's own figure (`total_sub_account` adds its children).
    """
    totals: dict[str, float] = {}

    def walk(rows: object) -> None:
        for row in rows if isinstance(rows, list) else []:
            total = row.get("total")
            if row.get("account_id") and _is_class6(row.get("account_code")) and isinstance(total, (int, float)):
                if total:
                    totals[str(row["account_id"])] = total
            walk(row.get("account_transactions"))

    walk(report.get("profit_and_loss"))
    return totals


def class6_accounts(rows: list[dict]) -> list[dict]:
    """The chart of accounts' expense accounts (code starting with 6) as the cache stores them."""
    return [
        {
            "id": str(r["account_id"]),
            "code": r["account_code"],
            "name": r.get("account_name") or "",
            "active": bool(r.get("is_active")),
        }
        for r in rows
        if r.get("account_id") and _is_class6(r.get("account_code"))
    ]


DEFAULT_SHARE = {"percent": 0, "type": "monthly", "goodsShare": 50}


def view(config: Config, cache: dict, month: str) -> dict:
    """What the table shows: active accounts and any account with a share, those with a share first."""
    months = cache["months"]
    rows = [
        {
            **a,
            "flag": flag(a["code"]),
            "month": _entered(months, a["id"], month),
            "year": rolling_year(months, a["id"], month),
            "usual": usual(months, a["id"], month),
            **DEFAULT_SHARE,
            **config.get(a["id"], {}),
        }
        for a in cache["accounts"]
        if a["active"] or a["id"] in config
    ]
    rows.sort(key=lambda r: (r["percent"] <= 0, r["code"], r["name"]))
    # The date shown is the last time Zoho answered at all, a page-opening re-read included.
    return {"month": month, "readAt": cache["currentReadAt"] or cache["readAt"], "accounts": rows}


def _months_from(first: str, last: str) -> list[str]:
    span = (int(last[:4]) - int(first[:4])) * 12 + int(last[5:7]) - int(first[5:7])
    return [*months_before(last, span), last]


def months_to_read(today: str, costs_start: str) -> list[str]:
    """Every month a full refresh asks Zoho for, oldest first: the 12 the result shows and the 11 before (accounts
    spread over a rolling year), and back to 11 months before the day costs are spread from."""
    month = today[:7]
    # shortcut: one Zoho call per month since costs_start, cache the closed years apart if a refresh gets slow
    return _months_from(min(months_before(month, 22)[0], months_before(costs_start[:7], 11)[0]), month)


def charges_by_month(config: Config, cache: dict, today: str) -> dict[str, Charge]:
    """Each cached month's charge, up to today's month; only today's month projects."""
    months = cache["months"]
    if not months or not config:
        return {}
    month = today[:7]
    return {m: month_charge(config, months, m, m == month) for m in _months_from(min(months), month)}
