from backend.app.services.revenue.customers import CUSTOMER_SEGMENTS
from backend.app.services.revenue.scope import (
    ITEM_ID_RE,
    RevenueDecision,
    ScopeItem,
    _by_weight,
    brand_key,
    classify_revenue_item,
    is_service_item,
    item_display_name,
)
from backend.app.services.revenue.series import LineFilters, js_round

MAX_BRAND_LENGTH = 64
MAX_BRAND_FILTERS = 50

ITEMS_PARAM_ERROR = "items must be a comma-separated list of item ids"
BRANDS_PARAM_ERROR = (
    f"brand must be repeated names of at most {MAX_BRAND_LENGTH} characters, {MAX_BRAND_FILTERS} at most"
)
KIND_PARAM_ERROR = "kind must be goods or services"
SEGMENT_PARAM_ERROR = f"segment must be one of {', '.join(CUSTOMER_SEGMENTS)}"


class FilterError(ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def build_product_list(totals: list[dict], items: dict[str, ScopeItem], decisions: list[RevenueDecision]) -> list[dict]:
    """In-scope products (a decision wins both ways), heaviest |CA| first."""
    decision_by_id = {d.item_id: d for d in decisions}
    rows = [
        {
            "itemId": t["itemId"],
            "name": item_display_name(items.get(t["itemId"]), t["name"]),
            "sku": t["sku"],
            "brand": it.brand if (it := items.get(t["itemId"])) else None,
            "kind": "service" if is_service_item(it) else "goods",
            "totalHt": js_round(t["totalHt"]),
            "quantity": t["quantity"],
            "lastDay": t["lastDay"],
        }
        for t in totals
        if classify_revenue_item(items.get(t["itemId"]), decision_by_id.get(t["itemId"])).included
    ]
    return sorted(rows, key=_by_weight)


def parse_brands(raw: list[str]) -> frozenset[str] | None:
    keys = [k for k in map(brand_key, raw) if k]
    if not keys:
        return None
    if len(keys) > MAX_BRAND_FILTERS or any(len(k) > MAX_BRAND_LENGTH for k in keys):
        raise FilterError(BRANDS_PARAM_ERROR)
    return frozenset(keys)


def parse_item_ids(raw: str | None) -> frozenset[str] | None:
    if raw is None:
        return None
    ids = [s for s in (p.strip() for p in raw.split(",")) if s]
    if not ids:
        return None
    if not all(ITEM_ID_RE.fullmatch(i) for i in ids):
        raise FilterError(ITEMS_PARAM_ERROR)
    return frozenset(ids)


def parse_series_filters(items: str | None, brands: list[str], kind: str | None, segment: str | None) -> LineFilters:
    """Validated in loki's order: items, brands, kind, segment. An empty kind/segment is no filter."""
    item_ids = parse_item_ids(items)
    brand_set = parse_brands(brands)
    if kind and kind not in ("goods", "services"):
        raise FilterError(KIND_PARAM_ERROR)
    if segment and segment not in CUSTOMER_SEGMENTS:
        raise FilterError(SEGMENT_PARAM_ERROR)
    return LineFilters(item_ids=item_ids, brands=brand_set, kind=kind or None, segment=segment or None)
