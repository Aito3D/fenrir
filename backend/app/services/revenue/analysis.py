"""The revenue page's analysis rules: Pareto (ABC) split, margin by brand / nature and dormant items."""

from backend.app.services.revenue.dates import add_days
from backend.app.services.revenue.series import NO_BRAND, NO_NATURE

ABC_THRESHOLDS = {"A": 0.8, "B": 0.95}
ABC_ROWS_SHOWN = 200
DORMANT_DAYS = 90
DORMANT_LOOKBACK_DAYS = 365
DORMANT_SHOWN = 50


def abc_analysis(rows: list[dict], shown: int = ABC_ROWS_SHOWN) -> dict:
    """Items by HT; A while the share before the item is under 80 %, B under 95 %, else C. Refund-only items are left out."""
    sold = sorted((r for r in rows if r["ht"] > 0), key=lambda r: (-r["ht"], r["name"].casefold()))
    total = sum(r["ht"] for r in sold)
    classes = {c: {"count": 0, "ht": 0} for c in "ABC"}
    out = []
    before = 0
    for r in sold:
        share_before = before / total
        cls = "A" if share_before < ABC_THRESHOLDS["A"] else "B" if share_before < ABC_THRESHOLDS["B"] else "C"
        before += r["ht"]
        classes[cls]["count"] += 1
        classes[cls]["ht"] += r["ht"]
        out.append({**r, "share": r["ht"] / total, "cumShare": before / total, "cls": cls})
    return {"rows": out[:shown], "total": total, "classes": classes}


def margin_by(rows: list[dict], dim: str) -> list[dict]:
    """Gross margin per "brand" or "nature" at each line's cost, heaviest margin first."""
    fallback = NO_BRAND if dim == "brand" else NO_NATURE
    groups: dict[str, dict] = {}
    for r in rows:
        g = groups.setdefault(r[dim] if r[dim] is not None else fallback, {"ht": 0, "costedHt": 0, "cost": 0})
        g["ht"] += r["ht"]
        if r["cost"] is not None:
            # Lines frozen without a cost (item lost its cost later) stay out of the costed share.
            g["costedHt"] += r.get("costedHt", r["ht"])
            g["cost"] += r["cost"]
    out = [
        {
            "key": key,
            **g,
            "margin": g["costedHt"] - g["cost"],
            "rate": (g["costedHt"] - g["cost"]) / g["costedHt"] if g["costedHt"] > 0 else None,
            "coverage": g["costedHt"] / g["ht"] if g["ht"] > 0 else 0,
        }
        for key, g in groups.items()
    ]
    return sorted(out, key=lambda m: (-m["margin"], -m["ht"]))


def dormant_ranges(today: str) -> dict:
    return {
        "before": {"from": add_days(today, -DORMANT_LOOKBACK_DAYS), "to": add_days(today, -DORMANT_DAYS - 1)},
        "recent": {"from": add_days(today, -DORMANT_DAYS), "to": today},
    }


def dormant_items(
    before: list[dict], recent: list[dict], last_days: dict[str, str], shown: int = DORMANT_SHOWN
) -> list[dict]:
    """Items sold (HT > 0) in the lookback but not once in the recent window, best former sellers first."""
    active = {r["itemId"] for r in recent}
    former = sorted(
        (r for r in before if r["ht"] > 0 and r["itemId"] not in active), key=lambda r: (-r["ht"], r["name"].casefold())
    )
    return [
        {
            "itemId": r["itemId"],
            "name": r["name"],
            "sku": r["sku"],
            "brand": r["brand"],
            "ht": r["ht"],
            "quantity": r["quantity"],
            "lastDay": last_days.get(r["itemId"], ""),
        }
        for r in former[:shown]
    ]
