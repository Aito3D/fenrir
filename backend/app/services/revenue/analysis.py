"""The revenue page's analysis rules: Pareto (ABC) split, margin by brand / nature and dormant items."""

from backend.app.services.revenue.dates import add_days
from backend.app.services.revenue.series import NO_BRAND, NO_NATURE, js_round

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


PVM_ROWS = 10


def price_volume_mix(cur: list[dict], prev: list[dict], shown: int = PVM_ROWS) -> dict:
    """Why revenue moved between two periods, from the per-item breakdowns (quantity, HT).

    Items sold with a quantity in both periods split their change into volume `(q1 − q0) × p0` and price
    `(p1 − p0) × q1`; the volume part is then cut in two: what the change in total units is worth at the old average
    price (`volume`) and the rest, units moving between cheap and dear items (`mix`). Anything else (sold in one period
    only, or a line without quantity such as a credit note) is `new` or `lost`. The six figures sum to the change.
    """
    before = {r["itemId"]: r for r in prev}
    after = {r["itemId"]: r for r in cur}
    volume_items = price = new = lost = 0.0
    q0_all = q1_all = r0_all = 0.0
    items = []
    for item_id, row in {**before, **after}.items():
        a, b = after.get(item_id), before.get(item_id)
        name = row["name"]
        if a and b and a["quantity"] > 0 and b["quantity"] > 0:
            p0 = b["ht"] / b["quantity"]
            vol = (a["quantity"] - b["quantity"]) * p0
            pri = a["ht"] - a["quantity"] * p0
            volume_items += vol
            price += pri
            q0_all += b["quantity"]
            q1_all += a["quantity"]
            r0_all += b["ht"]
            items.append({"name": name, "effect": vol + pri, "volume": vol, "price": pri, "kind": "both"})
            continue
        if a:
            new += a["ht"]
            items.append({"name": name, "effect": a["ht"], "volume": 0, "price": 0, "kind": "new"})
        if b:
            lost -= b["ht"]
            items.append({"name": name, "effect": -b["ht"], "volume": 0, "price": 0, "kind": "lost"})
    volume = (q1_all - q0_all) * r0_all / q0_all if q0_all else 0.0
    out: dict = {
        "previous": js_round(sum(r["ht"] for r in prev)),
        "current": js_round(sum(r["ht"] for r in cur)),
        "volume": js_round(volume),
        "price": js_round(price),
        "new": js_round(new),
        "lost": js_round(lost),
    }
    # Mix takes the rounding remainder so the bridge always closes.
    out["mix"] = out["current"] - out["previous"] - out["volume"] - out["price"] - out["new"] - out["lost"]
    ranked = sorted((i for i in items if i["effect"]), key=lambda i: (-abs(i["effect"]), i["name"].casefold()))
    out["items"] = [{**i, **{k: js_round(i[k]) for k in ("effect", "volume", "price")}} for i in ranked[:shown]]
    return out
