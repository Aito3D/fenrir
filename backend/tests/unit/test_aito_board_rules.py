"""The Aito board rule engine: a project's column is derived, never dropped."""

import pytest

from backend.app.services.aito_board_rules import evaluate, summarise


class _Task:
    """Stand-in for AitoTask, carrying only what the rules read."""

    def __init__(self, **kwargs):
        for service in ("scan", "modelisation", "impression", "usinage"):
            setattr(self, f"{service}_cost", kwargs.get(f"{service}_cost"))
            setattr(self, f"{service}_done", kwargs.get(f"{service}_done", False))


@pytest.mark.parametrize(
    ("quote_status", "stored", "pending", "expected"),
    [
        # Rule 1: declined goes to Done and stays there.
        ("declined", "devis", {"scan"}, ("done", "declined")),
        ("declined", "print", set(), ("done", "declined")),
        # Rule 2: the quote has left the shop — the answer is the client's.
        ("sent", "devis", set(), ("waiting", "waiting")),
        ("viewed", "devis", {"impression"}, ("waiting", "waiting")),
        ("expired", "devis", {"impression"}, ("waiting", "waiting")),
        # Waiting outranks the steps: work is not authorised until acceptance,
        # so ticking a step on a card out with the client moves nothing.
        ("sent", "print", {"impression"}, ("waiting", "waiting")),
        # Rule 3: still being written, or no Zoho quote at all.
        (None, "devis", {"scan"}, ("devis", "quote")),
        ("draft", "devis", {"scan"}, ("devis", "quote")),
        # Rule 4: the first stage, in board order, holding unticked work.
        ("accepted", "devis", {"scan", "modelisation", "impression"}, ("scan", "steps")),
        ("accepted", "scan", {"modelisation", "usinage"}, ("model", "steps")),
        ("accepted", "model", {"impression"}, ("print", "steps")),
        # usinage shares the print column with impression.
        ("accepted", "model", {"usinage"}, ("print", "steps")),
        # Accepting after some steps were already ticked lands correctly, not
        # back at Scan.
        ("accepted", "waiting", {"impression"}, ("print", "steps")),
        # Rule 5: nothing left to do.
        ("accepted", "print", set(), ("finish", None)),
        ("accepted", "devis", set(), ("finish", None)),
    ],
)
def test_evaluate_rules(quote_status, stored, pending, expected):
    assert evaluate(quote_status, stored, pending) == expected


def test_rule_five_believes_a_stored_done_but_nothing_else():
    """The ONLY place the stored column is trusted, and what makes the manual
    Finish <-> Done drag possible inside a derived model."""
    assert evaluate("accepted", "done", set()) == ("done", None)
    assert evaluate("accepted", "finish", set()) == ("finish", None)
    # A stale stored column from any other stage is ignored, not believed.
    assert evaluate("accepted", "scan", set()) == ("finish", None)


def test_unticking_pulls_a_card_back_out_of_done():
    """Rule 4 runs before rule 5, so re-opening any step evicts the card from
    Done rather than leaving it parked there."""
    assert evaluate("accepted", "done", {"impression"}) == ("print", "steps")


def test_pending_is_enabled_and_unticked_only():
    tasks = [
        _Task(scan_cost=1200.0, scan_done=True, modelisation_cost=900.0),
        _Task(impression_cost=2400.0, impression_done=True),
    ]
    assert summarise(tasks).pending == ("modelisation",)


def test_a_zero_cost_step_is_a_real_step():
    """0 means quoted free, not absent: it still holds the card."""
    assert summarise([_Task(modelisation_cost=0.0)]).pending == ("modelisation",)


def test_a_null_cost_is_not_a_step_even_when_its_flag_is_set():
    """Defensive: a stale done flag on an absent service must not resurrect it,
    and must not be reported as pending either."""
    assert summarise([_Task(scan_cost=None, scan_done=True)]).pending == ()


def test_no_tasks_means_nothing_pending():
    assert summarise([]).pending == ()
