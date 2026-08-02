"""adopt_quote_status: the one place a quote-status adoption stamps
quote_accepted_at. Pure attribute logic, so no DB fixture is needed —
an unsaved AitoProject row is enough."""

from datetime import datetime

from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_quote_status import adopt_quote_status


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
