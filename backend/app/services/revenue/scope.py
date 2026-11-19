import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

from backend.app.services.revenue.config import REVENUE_BRANDS, REVENUE_NATURES

ScopeReason = Literal["decision-include", "nature", "brand", "decision-exclude", "unclassified", "unknown-item"]

ITEM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass(frozen=True)
class ScopeItem:
    item_id: str
    name: str
    sku: str = ""
    brand: str | None = None
    nature: str | None = None
    item_type: str | None = None
    tax_percentage: float | None = None
    unit_cost: float | None = None
    status: str | None = None


@dataclass(frozen=True)
class RevenueDecision:
    item_id: str
    included: bool
    decided_at: str


@dataclass(frozen=True)
class ScopeVerdict:
    included: bool
    reason: ScopeReason


def fold(s: str | None) -> str:
    decomposed = unicodedata.normalize("NFKD", (s or "").strip().casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def brand_key(brand: str | None) -> str:
    return fold(brand)


_NATURE_KEYS = frozenset(fold(n) for n in REVENUE_NATURES)
_BRAND_KEYS = frozenset(fold(b) for b in REVENUE_BRANDS)


def classify_revenue_item(item: ScopeItem | None, decision: RevenueDecision | None) -> ScopeVerdict:
    if decision:
        return ScopeVerdict(True, "decision-include") if decision.included else ScopeVerdict(False, "decision-exclude")
    if item is None:
        return ScopeVerdict(False, "unknown-item")
    if fold(item.nature) in _NATURE_KEYS:
        return ScopeVerdict(True, "nature")
    if fold(item.brand) in _BRAND_KEYS:
        return ScopeVerdict(True, "brand")
    return ScopeVerdict(False, "unclassified")


def is_service_item(item: ScopeItem | None) -> bool:
    return item is not None and item.item_type == "sales"


def matches_kind(item: ScopeItem | None, kind: str | None) -> bool:
    return kind is None or (kind == "services") == is_service_item(item)


def item_display_name(item: ScopeItem | None, fallback: str) -> str:
    return item.name if item is not None else fallback


def _positive(v: Any) -> float | None:
    ok = isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v) and v > 0
    return v if ok else None


def unit_cost_of(purchase_rate: Any, dealer_price: Any) -> float | None:
    dealer = _positive(dealer_price)
    return dealer if dealer is not None else _positive(purchase_rate)


def _by_weight(row: dict) -> tuple:
    return (-abs(row["totalHt"]), row["name"].casefold())


def build_review_list(
    totals: list[dict], items: dict[str, ScopeItem], decisions: list[RevenueDecision]
) -> dict[str, list[dict]]:
    """totals: dicts keyed itemId/name/sku/totalHt/quantity/lastDay, loki's RevenueItemTotal shape."""
    decided_ids = {d.item_id for d in decisions}
    total_by_id = {t["itemId"]: t for t in totals}

    def row(item_id: str, t: dict | None) -> dict:
        it = items.get(item_id)
        return {
            "itemId": item_id,
            "name": t["name"] if t else (it.name if it else item_id),
            "sku": t["sku"] if t else "",
            "totalHt": math.floor((t["totalHt"] if t else 0) + 0.5),
            "quantity": t["quantity"] if t else 0,
            "lastDay": t["lastDay"] if t else "",
            "brand": it.brand if it else None,
            "nature": it.nature if it else None,
        }

    unclassified = sorted(
        (
            row(t["itemId"], t)
            for t in totals
            if t["itemId"] not in decided_ids and not classify_revenue_item(items.get(t["itemId"]), None).included
        ),
        key=_by_weight,
    )
    decided = [
        {**row(d.item_id, total_by_id.get(d.item_id)), "included": d.included, "decidedAt": d.decided_at}
        for d in decisions
    ]
    return {"unclassified": unclassified, "decided": decided}
