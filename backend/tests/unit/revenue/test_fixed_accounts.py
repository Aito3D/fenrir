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


def _row(account_id, code, total, **extra):
    return {"account_id": account_id, "account_code": code, "name": code, "total": total, **extra}


def test_class6_totals_walks_every_section_and_keys_by_id():
    from backend.app.services.revenue.fixed_accounts import class6_totals

    report = {
        "profit_and_loss": [
            {
                "name": "Profit brut",
                "total": 1,
                "account_transactions": [
                    {"name": "Produits", "account_transactions": [_row("s1", "70610000", 1247739)]},
                    {"name": "Coût des marchandises vendues", "account_transactions": [_row("c1", "60810000", 50878)]},
                ],
            },
            {
                "name": "Bénéfice d'exploitation",
                "account_transactions": [
                    {
                        "name": "Dépenses d'exploitation",
                        "account_transactions": [
                            _row("a", "60431000", -17857),
                            _row("b", "60431000", 599325),
                            _row("p", "61", 10, total_sub_account=50, account_transactions=[_row("k", "61320000", 40)]),
                            _row("z", "62700000", 0),
                            _row("", "62", 5),
                            _row("n", "63", "n/a"),
                        ],
                    }
                ],
            },
        ]
    }
    assert class6_totals(report) == {"c1": 50878, "a": -17857, "b": 599325, "p": 10, "k": 40}
    assert class6_totals({}) == {}


def test_class6_accounts_keeps_expense_codes_only():
    from backend.app.services.revenue.fixed_accounts import class6_accounts

    rows = [
        {"account_id": 7, "account_code": "61320000", "account_name": "Location", "is_active": True},
        {"account_id": "8", "account_code": "70610000", "account_name": "Ventes", "is_active": True},
        {"account_id": "9", "account_code": "625", "account_name": "Déplacements", "is_active": False},
        {"account_id": "10", "account_name": "Sans code", "is_active": True},
        {"account_code": "62", "account_name": "Sans id"},
    ]
    assert class6_accounts(rows) == [
        {"id": "7", "code": "61320000", "name": "Location", "active": True},
        {"id": "9", "code": "625", "name": "Déplacements", "active": False},
    ]


def test_view_lists_active_accounts_and_those_with_a_share_first():
    from backend.app.services.revenue.fixed_accounts import view

    cache = {
        "accounts": [
            {"id": "edf", "code": "60612000", "name": "Electricite", "active": True},
            {"id": "rent", "code": "61320000", "name": "Location", "active": True},
            {"id": "old", "code": "62", "name": "Ancien", "active": False},
            {"id": "gone", "code": "63", "name": "Parti", "active": False},
        ],
        "months": M,
        "readAt": "2026-11-27T10:00:00+00:00",
        "currentReadAt": "2026-11-27T10:00:00+00:00",
    }
    out = view({"rent": RENT, "old": PC}, cache, "2026-11")
    assert (out["month"], out["readAt"]) == ("2026-11", "2026-11-27T10:00:00+00:00")
    assert [a["id"] for a in out["accounts"]] == ["rent", "old", "edf"]
    assert out["accounts"][0] == {
        "id": "rent",
        "code": "61320000",
        "name": "Location",
        "active": True,
        "flag": None,
        "month": 0,
        "year": 480000,
        "usual": 160000,
        "percent": 50,
        "type": "monthly",
        "goodsShare": 40,
    }
    edf = out["accounts"][2]
    assert (edf["flag"], edf["month"], edf["percent"], edf["type"], edf["goodsShare"]) == (
        "purchases",
        24000,
        0,
        "monthly",
        50,
    )
