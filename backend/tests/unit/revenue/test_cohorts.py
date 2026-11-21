from backend.app.services.revenue.cohorts import build_cohorts

TODAY = "2026-11-20"


def cohorts(purchases, segments=None, names=None):
    return build_cohorts(purchases, segments or {}, names or {}, TODAY)


def cohort(out, month):
    return next(c for c in out["cohorts"] if c["month"] == month)


def test_retention_is_the_share_of_a_cohort_buying_again_each_later_month():
    p = [("a", "2026-08-10", 100), ("a", "2026-09-12", 50), ("a", "2026-11-02", 30), ("b", "2026-08-20", 200)]
    c = cohort(cohorts(p), "2026-08")
    assert c["size"] == 2
    assert c["retention"][:3] == [50.0, 0.0, 50.0]
    # December has not happened yet.
    assert c["retention"][3:] == [None] * 9
    assert c["revenuePerCustomer"] == 190


def test_the_last_twelve_cohort_months_oldest_first_even_when_empty():
    out = cohorts([("old", "2025-06-01", 10), ("a", "2026-01-15", 10)])
    assert [c["month"] for c in out["cohorts"]] == [
        "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
        "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11",
    ]  # fmt: skip
    assert cohort(out, "2026-02") == {"month": "2026-02", "size": 0, "retention": [None] * 12, "revenuePerCustomer": 0}


def test_a_day_that_nets_to_a_refund_is_not_a_purchase():
    p = [("a", "2026-07-05", -40), ("a", "2026-08-10", 100), ("a", "2026-09-01", 60), ("a", "2026-09-01", -60)]
    out = cohorts(p)
    assert cohort(out, "2026-07")["size"] == 0
    assert cohort(out, "2026-08")["retention"][0] == 0.0


def test_twelve_month_value_by_segment_ignores_customers_younger_than_a_year():
    p = [
        ("pro1", "2025-06-10", 300), ("pro1", "2025-12-01", 200), ("pro1", "2026-07-01", 900),
        ("pro2", "2025-01-05", 100),
        ("young", "2026-03-01", 5000),
    ]  # fmt: skip
    out = cohorts(p, {"pro1": "pro", "pro2": "pro", "young": "pro"})
    assert out["ltv"] == [{"segment": "pro", "customers": 2, "ltv12": 300}]


def test_a_customer_gone_quiet_for_longer_than_usual_is_at_risk():
    p = [
        *[("late", d, 100) for d in ("2026-07-23", "2026-08-22", "2026-09-21")],
        *[("fine", d, 100) for d in ("2026-08-12", "2026-09-11", "2026-10-11")],
        *[("two", d, 100) for d in ("2026-01-01", "2026-02-01")],
    ]
    assert cohorts(p, names={"late": "Late SARL"})["atRisk"] == [
        {"customerName": "Late SARL", "lastDay": "2026-09-21", "usualGapDays": 30, "daysSince": 60, "revenue12m": 300}
    ]


def test_several_lines_on_one_day_are_one_purchase():
    p = [("a", "2026-01-10", 100), ("a", "2026-01-10", 100), ("a", "2026-01-10", 100)]
    assert cohorts(p)["atRisk"] == []


def test_at_risk_is_ranked_by_twelve_month_revenue_and_capped_at_twenty():
    p = [(f"c{n:02d}", d, 100 + n) for n in range(25) for d in ("2026-03-01", "2026-04-01", "2026-05-01")]
    rows = cohorts(p)["atRisk"]
    assert len(rows) == 20
    assert rows[0]["customerName"] == "c24" and rows[0]["revenue12m"] == 372
