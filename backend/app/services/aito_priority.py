"""Priority surcharge for job prices (Python mirror of prioritySurcharge in frontend/src/utils/pricing.ts)."""

from backend.app.models.calculator import CalculatorDefaults

PRIORITY_LEVELS = ("normal", "priority", "urgent")


def priority_terms(level: str, defaults: CalculatorDefaults) -> tuple[float, float]:
    """(pct, min fee) for a level; (0, 0) for normal or unknown."""
    if level == "priority":
        return defaults.priority_pct, defaults.priority_min_fee
    if level == "urgent":
        return defaults.urgent_pct, defaults.urgent_min_fee
    return 0.0, 0.0


def priority_surcharge(level: str, base: float, defaults: CalculatorDefaults) -> float:
    """max(base * pct / 100, min fee) for priority/urgent; 0 for normal or unknown. Caller rounds."""
    if level not in ("priority", "urgent"):
        return 0.0
    pct, min_fee = priority_terms(level, defaults)
    return max(base * pct / 100, min_fee)


def base_before_surcharge(total: float, pct: float, min_fee: float) -> float:
    """The base whose base + surcharge is ``total``: the inverse of
    ``priority_surcharge``, taking the branch that surcharge itself would."""
    base = total / (1 + pct / 100)
    return base if base * pct / 100 >= min_fee else total - min_fee
