"""Priority surcharge for job prices (Python mirror of prioritySurcharge in frontend/src/utils/pricing.ts)."""

from backend.app.models.calculator import CalculatorDefaults

PRIORITY_LEVELS = ("normal", "priority", "urgent")


def priority_surcharge(level: str, base: float, defaults: CalculatorDefaults) -> float:
    """max(base * pct / 100, min fee) for priority/urgent; 0 for normal or unknown. Caller rounds."""
    if level == "priority":
        return max(base * defaults.priority_pct / 100, defaults.priority_min_fee)
    if level == "urgent":
        return max(base * defaults.urgent_pct / 100, defaults.urgent_min_fee)
    return 0.0
