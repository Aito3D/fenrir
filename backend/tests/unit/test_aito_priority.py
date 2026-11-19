from backend.app.models.calculator import CalculatorDefaults
from backend.app.services.aito_priority import priority_surcharge

D = CalculatorDefaults(priority_pct=15.0, priority_min_fee=500.0, urgent_pct=35.0, urgent_min_fee=1500.0)


def test_min_fee_wins_on_small_base():
    assert priority_surcharge("priority", 1400, D) == 500


def test_urgent_min_fee():
    assert priority_surcharge("urgent", 2031, D) == 1500


def test_percentage_wins_on_large_base():
    assert priority_surcharge("priority", 20000, D) == 3000
    assert priority_surcharge("urgent", 20000, D) == 7000


def test_normal_is_zero():
    assert priority_surcharge("normal", 20000, D) == 0
