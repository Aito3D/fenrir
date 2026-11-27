"""Python twin of loki's revenue-fixtures.ts: the one bucket builder shared by the revenue suites."""

from typing import Any


def bucket(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "key": "2026-10",
        "label": "oct. 2026",
        "start": "2026-10-01",
        "end": "2026-10-31",
        "ht": 0,
        "ttc": 0,
        "goods": 0,
        "services": 0,
        "byNature": {},
        "byBrand": {},
        "goodsTtc": 0,
        "servicesTtc": 0,
        "byNatureTtc": {},
        "byBrandTtc": {},
        "bySegment": {},
        "bySegmentTtc": {},
        "cost": 0,
        "costedHt": 0,
        "marginSplit": {"nature": {}, "brand": {}, "segment": {}, "kind": {}},
        "costParts": {"items": 0},
        "fixedGoods": 0,
        "projection": None,
        "projectionMethod": None,
        "quantity": 0,
        "evolution": {"ht": None, "ttc": None},
        "yearAgo": None,
        "previousTotal": None,
        "elapsedDays": None,
        "cumulative": {"ht": 0, "ttc": 0},
        "partial": False,
        "missingDays": 0,
        "ttcApprox": False,
    }
    return {**base, **over}
