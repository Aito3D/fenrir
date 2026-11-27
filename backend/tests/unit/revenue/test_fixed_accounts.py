"""A month's fixed charge from Zoho's account totals and the shares the operator set."""

import pytest

from backend.app.services.revenue.fixed_accounts import (
    Charge,
    account_charge,
    flag,
    month_charge,
    months_before,
    rolling_year,
    usual,
)

M = {
    "2026-08": {"rent": 160000, "edf": 60000},
    "2026-09": {"rent": 160000, "edf": 72000},
    "2026-10": {"rent": 160000, "edf": 84000},
    "2026-11": {"edf": 24000, "pc": 238341},
}
RENT = {"percent": 50, "type": "monthly", "goodsShare": 40}
EDF = {"percent": 100, "type": "monthly", "goodsShare": 100}
PC = {"percent": 100, "type": "one_off", "goodsShare": 100}


def test_months_before_crosses_the_year():
    assert months_before("2027-02", 3) == ["2026-11", "2026-12", "2027-01"]


def test_monthly_closed_month_is_real():
    assert account_charge(RENT, M, "rent", "2026-10", False) == Charge(32000, 48000, 0, 0)


def test_monthly_current_projects_missing():
    c = account_charge(RENT, M, "rent", "2026-11", True)
    assert (c.real, c.est_goods, c.est_services) == (0, 32000, 48000)
    assert (c.estimated, c.goods, c.services, c.total) == (80000, 32000, 48000, 80000)


def test_monthly_partial_entry():
    c = account_charge(EDF, M, "edf", "2026-11", True)
    assert (c.real, c.estimated) == (24000, 48000)


def test_no_estimate_when_entered_above_usual():
    months = {**M, "2026-11": {"edf": 90000}}
    c = account_charge(EDF, months, "edf", "2026-11", True)
    assert (c.real, c.estimated) == (90000, 0)


def test_closed_month_never_projected():
    assert account_charge(RENT, M, "rent", "2026-11", False) == Charge()


def test_annual_rolls_twelve_months():
    months = {"2026-03": {"ins": 216000}}
    cfg = {"percent": 30, "type": "annual", "goodsShare": 50}
    for current in (False, True):
        c = account_charge(cfg, months, "ins", "2026-11", current)
        assert c.real == pytest.approx(5400)
        assert (c.real_goods, c.estimated) == (pytest.approx(2700), 0)
    assert rolling_year(months, "ins", "2027-02") == 216000
    assert account_charge(cfg, months, "ins", "2027-03", False) == Charge()


def test_one_off_never_projected():
    c = account_charge(PC, M, "pc", "2026-11", True)
    assert (c.real, c.estimated) == (238341, 0)
    assert account_charge(PC, M, "rent", "2026-11", True) == Charge()


def test_usual_counts_empty_months_as_zero():
    assert usual({"2026-10": {"new": 90000}}, "new", "2026-11") == 30000


def test_negative_usual_never_estimates():
    months = {m: {"x": -100} for m in ("2026-08", "2026-09", "2026-10")}
    assert account_charge(EDF, months, "x", "2026-11", True) == Charge()


def test_share_zero_or_missing_charges_nothing():
    assert account_charge({**RENT, "percent": 0}, M, "rent", "2026-10", False) == Charge()
    assert account_charge({**RENT, "type": "weekly"}, M, "rent", "2026-10", False) == Charge()
    assert month_charge({}, M, "2026-10", False) == Charge()


def test_month_charge_sums_accounts():
    c = month_charge({"rent": RENT, "edf": EDF}, M, "2026-11", True)
    assert (c.real, c.estimated, c.goods, c.services) == (24000, 128000, 104000, 48000)


def test_duplicate_codes_are_distinct_accounts():
    # Zoho's codes are not unique: the id is the key.
    months = {"2026-10": {"id-a": 100, "id-b": 1000}}
    c = month_charge({"id-a": EDF, "id-b": EDF}, months, "2026-10", False)
    assert c.real == 1100
    assert month_charge({"id-a": EDF}, months, "2026-10", False).real == 100


def test_flag():
    assert flag("60810000") == "purchases"
    assert flag("641100") == "staff"
    assert flag("68110000") == "depreciation"
    assert flag("61320000") is None
