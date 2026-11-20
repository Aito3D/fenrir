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
