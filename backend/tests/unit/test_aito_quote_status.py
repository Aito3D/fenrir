"""adopt_quote_status: the one place a quote-status adoption stamps
quote_accepted_at. Pure attribute logic, so no DB fixture is needed —
an unsaved AitoProject row is enough."""

from datetime import datetime

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services.aito_quote_status import (
    accept_quote,
    adopt_quote_status,
    apply_quote_decision,
    push_quote_status,
)
from backend.app.services.zoho import ZohoUpstreamError, zoho_service


def _project(**overrides) -> AitoProject:
    fields = {"description": "Support GoPro", "board_column": "devis", "position": 0}
    fields.update(overrides)
    return AitoProject(**fields)


def test_transition_into_accepted_stamps():
    project = _project(quote_status="sent")
    adopt_quote_status(project, "accepted")
    assert project.quote_status == "accepted"
    assert isinstance(project.quote_accepted_at, datetime)


def test_already_accepted_does_not_restamp():
    old = datetime(2020, 3, 15, 8, 30, 0)
    project = _project(quote_status="accepted", quote_accepted_at=old)
    adopt_quote_status(project, "accepted")
    assert project.quote_accepted_at == old


def test_leaving_accepted_preserves_the_stamp():
    old = datetime(2020, 3, 15, 8, 30, 0)
    project = _project(quote_status="accepted", quote_accepted_at=old)
    adopt_quote_status(project, "declined")
    assert project.quote_status == "declined"
    assert project.quote_accepted_at == old


def test_reaccepting_after_a_decline_overwrites():
    old = datetime(2020, 3, 15, 8, 30, 0)
    project = _project(quote_status="declined", quote_accepted_at=old)
    adopt_quote_status(project, "accepted")
    assert project.quote_accepted_at is not None
    assert project.quote_accepted_at > old


def test_non_accept_statuses_never_stamp():
    project = _project(quote_status=None)
    adopt_quote_status(project, "viewed")
    assert project.quote_status == "viewed"
    assert project.quote_accepted_at is None


def test_none_to_accepted_stamps():
    project = _project(quote_status=None)
    adopt_quote_status(project, "accepted")
    assert project.quote_status == "accepted"
    assert isinstance(project.quote_accepted_at, datetime)


def test_entering_an_away_status_stamps_sent_at_once():
    project = _project(quote_status=None)
    adopt_quote_status(project, "sent")
    assert isinstance(project.quote_sent_at, datetime)
    first = project.quote_sent_at
    adopt_quote_status(project, "viewed")
    adopt_quote_status(project, "sent")  # a re-send never restarts the clock
    assert project.quote_sent_at == first


def test_unaccepting_keeps_the_sent_stamp():
    old = datetime(2026, 2, 2, 14, 15, 0)
    project = _project(quote_status="accepted", quote_sent_at=old)
    adopt_quote_status(project, "sent")
    assert project.quote_sent_at == old


def test_a_decided_status_adopted_directly_does_not_stamp():
    """accepted/declined straight from None (a Books-side decision we never
    saw as sent) leaves the clock unset — nothing is 'out' any more."""
    project = _project(quote_status=None)
    adopt_quote_status(project, "accepted")
    assert project.quote_sent_at is None


def test_a_status_outside_the_board_vocabulary_is_refused():
    """Books' status set is wider than the board's. 'invoiced' is the one that
    actually reached here (from the sync worker's lock path) and it means
    nothing to `aito_board_rules.evaluate`, which reads any non-'accepted'
    value as "not authorised yet" — so storing it dropped a finished card back
    into Devis and, via `_apply_rules`, overwrote the stored Finish/Done
    choice for good."""
    project = _project(quote_status="accepted")
    adopt_quote_status(project, "invoiced")
    assert project.quote_status == "accepted"


def test_refusing_an_unknown_status_does_not_clear_the_stamp():
    old = datetime(2020, 3, 15, 8, 30, 0)
    project = _project(quote_status="accepted", quote_accepted_at=old)
    adopt_quote_status(project, "partially_invoiced")
    assert project.quote_status == "accepted"
    assert project.quote_accepted_at == old


def test_none_is_still_adoptable():
    """None is not an unknown status — it is the legitimate "no quote status
    yet" of a hand-made card, and the guard must not swallow it."""
    project = _project(quote_status="sent")
    adopt_quote_status(project, None)
    assert project.quote_status is None


async def _persisted(db, **fields) -> AitoProject:
    base = {"description": "x", "board_column": "devis", "position": 0, "status": "active", "quote_status": "sent"}
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_apply_quote_decision_writes_locally_records_and_moves_the_card(db_session):
    p = await _persisted(db_session, quote_status_block="conflict", quote_status_remote="declined")
    await apply_quote_decision(
        db_session,
        p,
        "accepted",
        actor_class="system",
        actor_name=None,
        source="payment_link",
        detail={"amount": 12500},
    )
    assert p.quote_status == "accepted" and p.quote_accepted_at is not None
    assert p.quote_status_block is None and p.quote_status_remote is None and p.quote_status_confirmed is False
    # An accepted card with no pending work leaves Devis (board rules).
    assert p.board_column != "devis"
    ev = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "quote.accepted")
        )
    ).scalar_one()
    assert ev.actor_class == "system" and ev.detail["source"] == "payment_link" and ev.detail["amount"] == 12500


@pytest.mark.asyncio
async def test_apply_quote_decision_records_unaccepted_for_accepted_to_sent(db_session):
    p = await _persisted(db_session, quote_status="accepted")
    await apply_quote_decision(db_session, p, "sent", actor_class="user", actor_name="paul", source="user")
    kinds = {
        e.kind for e in (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == p.id))).scalars()
    }
    assert "quote.unaccepted" in kinds and "quote.sent" not in kinds


@pytest.mark.asyncio
async def test_push_quote_status_confirms_on_success_and_rolls_back_on_failure(db_session, monkeypatch):
    p = await _persisted(db_session, quote_id="EST1")

    async def ok(db, estimate_id, target, current=None):
        return None

    monkeypatch.setattr(zoho_service, "advance_estimate_status", ok)
    assert await push_quote_status(db_session, p, "accepted") is True
    assert p.quote_status_confirmed is True

    async def fail(db, estimate_id, target, current=None):
        raise ZohoUpstreamError("down")

    monkeypatch.setattr(zoho_service, "advance_estimate_status", fail)
    p2 = await _persisted(db_session, quote_id="EST2")
    assert await push_quote_status(db_session, p2, "accepted") is False


@pytest.mark.asyncio
async def test_accept_quote_is_a_no_op_when_already_accepted(db_session, monkeypatch):
    p = await _persisted(db_session, quote_status="accepted")
    calls = []

    async def spy(db, estimate_id, target, current=None):
        calls.append(target)

    monkeypatch.setattr(zoho_service, "advance_estimate_status", spy)
    assert await accept_quote(db_session, p, source="retainer") is False
    assert calls == []


@pytest.mark.asyncio
async def test_accept_quote_reopens_a_declined_quote(db_session, monkeypatch):
    p = await _persisted(db_session, quote_status="declined", quote_id="EST1", board_column="done")
    # A pending step is what makes the reopen visibly move the card: with no
    # tasks at all, "nothing left to do" trusts the stored column between
    # Finish and Done (aito_board_rules.evaluate) and a card already sitting
    # in Done from the decline would simply stay there, which would not
    # exercise the rules running at all.
    db_session.add(AitoTask(project_id=p.id, position=0, scan_cost=100.0, scan_done=False))
    await db_session.commit()

    async def ok(db, estimate_id, target, current=None):
        return None

    monkeypatch.setattr(zoho_service, "advance_estimate_status", ok)
    assert await accept_quote(db_session, p, source="payment_link", detail={"reference": "DEV-1"}) is True
    assert p.quote_status == "accepted" and p.board_column != "done"
