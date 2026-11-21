"""Order book aggregation from Aito cards."""

from datetime import datetime
from types import SimpleNamespace

from backend.app.services.revenue import pipeline

NOW = datetime(2026, 11, 20, 12, 0)


def card(status, column="print", total=100.0, invoiced=False, retainer=None, sent=None):
    return SimpleNamespace(
        board_column=column,
        quote_status=status,
        quote_invoiced=invoiced,
        quote_total=total,
        retainer_paid_total=retainer,
        quote_sent_at=sent,
    )


def test_accepted_not_invoiced_sums_by_column_and_counts_missing_totals():
    out = pipeline.build_pipeline(
        [
            card("accepted", "print", 1000.4, retainer=300),
            card("accepted", "model", 500),
            card("accepted", "print", None),
            card("accepted", "done", 900, invoiced=True),  # invoiced: already turnover
            card("declined", "devis", 700),
        ],
        NOW,
    )
    assert out["accepted"] == {
        "count": 3,
        "total": 1500,
        "retainerPaid": 300,
        "missingTotal": 1,
        "byColumn": [{"column": "model", "count": 1, "total": 500}, {"column": "print", "count": 2, "total": 1000}],
    }


def test_awaiting_counts_sent_and_viewed_with_oldest_age():
    out = pipeline.build_pipeline(
        [
            card("sent", "devis", 200, sent=datetime(2026, 11, 10, 13, 0)),
            card("viewed", "devis", None, sent=datetime(2026, 11, 1, 12, 0)),
            card("sent", "devis", 50),
            card("draft", "devis", 999),
        ],
        NOW,
    )
    assert out["awaiting"] == {"count": 3, "total": 250, "oldestDays": 19}


def test_empty_board():
    out = pipeline.build_pipeline([], NOW)
    assert out["accepted"]["count"] == 0 and out["accepted"]["byColumn"] == []
    assert out["awaiting"] == {"count": 0, "total": 0, "oldestDays": None}


def quote(status, total=100.0, sent_days=10, accepted_after=None, deleted=False, before_trash=None):
    from datetime import timedelta

    sent = NOW - timedelta(days=sent_days)
    return SimpleNamespace(
        status="deleted" if deleted else "active",
        quote_status=status,
        quote_status_before_trash=before_trash,
        quote_total=total,
        quote_sent_at=sent,
        quote_accepted_at=None if accepted_after is None else sent + timedelta(days=accepted_after),
    )


def test_funnel_counts_each_outcome_and_converts_over_decided_quotes():
    cards = [
        quote("accepted", 10_000),
        quote("accepted", 20_000),
        quote("accepted", 30_000),
        quote("declined", 40_000),
        quote("expired", None),
        quote("sent", 5_000),
        quote("draft", 999),
    ]
    f = pipeline.build_funnel(cards, NOW)
    assert f["sent"] == {"count": 6, "total": 105_000}
    assert f["accepted"] == {"count": 3, "total": 60_000}
    assert f["declined"] == {"count": 1, "total": 40_000}
    assert f["expired"] == {"count": 1, "total": 0}
    assert f["awaiting"] == {"count": 1, "total": 5_000}
    assert f["missingTotal"] == 1
    assert f["conversion"] == {"count": 60.0, "value": 60.0, "decided": 5}


def test_funnel_counts_a_trashed_card_as_declined_whatever_it_was_before():
    # Trashing a card declines its quote in Books; the status before the trash only serves a restore.
    f = pipeline.build_funnel([quote("declined", 700, deleted=True, before_trash="accepted")], NOW)
    assert f["declined"] == {"count": 1, "total": 700}
    assert f["accepted"]["count"] == 0


def test_funnel_counts_an_invoiced_quote_as_accepted_and_a_viewed_one_as_awaiting():
    f = pipeline.build_funnel([quote("invoiced", 300), quote("viewed", 200)], NOW)
    assert (f["accepted"]["count"], f["awaiting"]["count"]) == (1, 1)


def test_funnel_leaves_out_quotes_sent_more_than_a_year_ago_or_never_sent():
    never = quote("accepted", 100)
    never.quote_sent_at = None
    f = pipeline.build_funnel(
        [quote("accepted", 100, sent_days=366), never, quote("accepted", 100, sent_days=365)], NOW
    )
    assert f["sent"]["count"] == 1


def test_funnel_median_days_to_accept():
    cards = [quote("accepted", 100, accepted_after=d) for d in (2, 4, 9)] + [quote("accepted", 100)]
    assert pipeline.build_funnel(cards, NOW)["medianDaysToAccept"] == 4
    assert pipeline.build_funnel([quote("declined", 100)], NOW)["medianDaysToAccept"] is None


def test_funnel_bands_by_quote_amount():
    cards = [quote("accepted", 9_999), quote("declined", 10_000), quote("accepted", 10_000), quote("accepted", 50_000)]
    assert pipeline.build_funnel(cards, NOW)["bands"] == [
        {"band": "small", "decided": 1, "accepted": 1, "conversion": 100.0},
        {"band": "medium", "decided": 2, "accepted": 1, "conversion": 50.0},
        {"band": "large", "decided": 1, "accepted": 1, "conversion": 100.0},
    ]


def test_funnel_without_any_quote():
    f = pipeline.build_funnel([], NOW)
    assert f["sent"] == {"count": 0, "total": 0}
    assert f["conversion"] == {"count": None, "value": None, "decided": 0}
    assert f["medianDaysToAccept"] is None
    assert [b["conversion"] for b in f["bands"]] == [None, None, None]
