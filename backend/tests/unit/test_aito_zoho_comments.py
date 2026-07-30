"""Mapping Books' history into ours, without duplicating it or losing it.

Two rules do the work. Classification is best-effort: a comment we cannot
recognise is stored verbatim rather than dropped, because Books can add
statuses and the patterns are English-dependent -- and, as the live probe in
Task 7 Step 1 confirmed, this organisation's Books account writes its history
in French, not English, so the pattern table has to cover both. And nothing
we caused comes back in as if the client had done it.

The live probe also confirmed the organisation's timestamps are French
Polynesia local time (UTC-10), not UTC, so every timestamp test below checks
the stored ``occurred_at`` is the UTC-converted value, not the raw local one.
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_zoho_comments import (
    COMMENT_REFRESH_INTERVAL,
    map_comment,
    mirror_comments,
    should_pull_comments,
)


def test_a_recognised_status_becomes_a_client_story_event():
    mapped = map_comment({"description": "Estimate viewed by the customer", "comment_type": "system"})
    assert mapped["kind"] == "quote.viewed"
    assert mapped["actor_class"] == "client"


def test_an_unrecognised_comment_is_kept_verbatim():
    """Books can add statuses, and these patterns are English-dependent. The
    mirror must degrade to showing the text, never to dropping the row."""
    mapped = map_comment({"description": "Something new Books invented", "comment_type": "system"})
    assert mapped["kind"] == "zoho.comment"
    assert mapped["detail"]["text"] == "Something new Books invented"


# The three assertions below use the ACTUAL comment text pulled from the live
# organisation in Task 7 Step 1 (not invented fixtures), because this org's
# Books account is configured in French and the brief's English-only patterns
# would silently never fire against it -- every real accepted/viewed/sent
# comment would fall through to zoho.comment and never reach story depth.
def test_a_real_french_acceptance_comment_becomes_a_client_story_event():
    mapped = map_comment({"description": "Devis accepté à l'aide du lien public", "comment_type": "system"})
    assert mapped["kind"] == "quote.accepted"
    assert mapped["actor_class"] == "client"


def test_a_real_french_view_comment_becomes_a_client_story_event():
    mapped = map_comment({"description": "Le client a consulté le devis dans l'e-mail.", "comment_type": "system"})
    assert mapped["kind"] == "quote.viewed"
    assert mapped["actor_class"] == "client"


def test_a_real_french_sent_comment_becomes_a_client_story_event():
    mapped = map_comment(
        {"description": "Devis envoyé par e-mail à nelson.robiquet@gmail.com", "comment_type": "system"}
    )
    assert mapped["kind"] == "quote.sent"
    assert mapped["actor_class"] == "client"


def test_a_field_named_expiration_is_not_mistaken_for_the_quote_expiring():
    """Real Books workflow comment: a field literally named 'set expiration'
    being updated by a workflow. An open stem match on 'expir' would wrongly
    fire quote.expired here; only the closed inflected forms of the verb
    (expired/expiré/expirée) should match."""
    mapped = map_comment(
        {
            "description": (
                "La mise à jour du champ set expiration est exécutée avec succès "
                "par le workflow Salesperson default devis"
            ),
            "comment_type": "system",
        }
    )
    assert mapped["kind"] == "zoho.comment"


@pytest.mark.asyncio
async def test_the_same_comment_is_never_mirrored_twice(db_session):
    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-1")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    comments = [
        {
            "comment_id": "c-1",
            "description": "Estimate viewed by the customer",
            "comment_type": "system",
            "date": "2026-07-28",
            "time": "17:20",
        }
    ]
    assert await mirror_comments(db_session, project, comments) == 1
    assert await mirror_comments(db_session, project, comments) == 0


@pytest.mark.asyncio
async def test_our_own_status_push_does_not_come_back_as_the_clients(db_session):
    """We mark a quote sent; Books writes its own comment for that change. Left
    alone the mirror would import it and the timeline would show the quote
    being sent twice.

    The comment's local time (01:02) is deliberately not the same clock digits
    as ``ours`` (11:00 UTC): the organisation is UTC-10, so a comment Books
    wrote about the same instant as ``ours`` reads 01:02 on Books' local clock,
    which converts back to 11:02 UTC -- two minutes after our own push, well
    inside the echo window.
    """
    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-1")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    ours = datetime(2026, 7, 28, 11, 0)
    db_session.add(
        AitoEvent(project_id=project.id, occurred_at=ours, kind="quote.sent", actor_class="user", actor_name="paul")
    )
    await db_session.commit()

    written = await mirror_comments(
        db_session,
        project,
        [
            {
                "comment_id": "c-2",
                "description": "Estimate status changed from Draft to Sent",
                "comment_type": "system",
                "date": "2026-07-28",
                "time": "01:02",
            }
        ],
    )
    assert written == 0

    rows = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == project.id))).scalars().all()
    assert len(rows) == 1
    assert rows[0].actor_name == "paul"


@pytest.mark.asyncio
async def test_an_echo_outside_the_window_is_still_mirrored(db_session):
    """The suppression is a ten-minute window, not a blanket rule -- a genuine
    later status change must not be swallowed by an old one of ours."""
    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-1")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    db_session.add(
        AitoEvent(
            project_id=project.id,
            occurred_at=datetime(2026, 7, 28, 11, 0) - timedelta(hours=3),
            kind="quote.sent",
            actor_class="user",
        )
    )
    await db_session.commit()

    written = await mirror_comments(
        db_session,
        project,
        [
            {
                "comment_id": "c-3",
                "description": "Estimate status changed from Draft to Sent",
                "comment_type": "system",
                "date": "2026-07-28",
                "time": "01:02",
            }
        ],
    )
    assert written == 1


@pytest.mark.asyncio
async def test_comment_timestamps_convert_from_org_local_time_to_utc_by_default(db_session):
    """Books returns organisation-local timestamps (confirmed UTC-10, French
    Polynesia, via the live probe in Task 7 Step 1) while every other
    datetime in aito_events is UTC. Left unconverted, this would silently
    misreport by ten hours the exact fact this feature exists to establish:
    when the client actually opened the quote."""
    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-1")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    written = await mirror_comments(
        db_session,
        project,
        [
            {
                "comment_id": "c-tz-default",
                "description": "Devis accepté à l'aide du lien public",
                "comment_type": "system",
                "date": "2026-07-28",
                "time": "11:47 AM",
            }
        ],
    )
    assert written == 1

    row = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == project.id))).scalar_one()
    # Org-local 11:47 AM at UTC-10 -> UTC 21:47 the same day.
    assert row.occurred_at == datetime(2026, 7, 28, 21, 47)


@pytest.mark.asyncio
async def test_comment_utc_offset_is_read_from_settings_not_hardcoded(db_session):
    """A different organisation could be on a different clock; the offset
    must come from configuration, not a bare constant in the mapper."""
    await set_setting(db_session, "zoho_comment_utc_offset_hours", "1")  # e.g. Paris, UTC+1

    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-1")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    await mirror_comments(
        db_session,
        project,
        [
            {
                "comment_id": "c-tz-configured",
                "description": "Devis envoyé par e-mail à x@example.com",
                "comment_type": "system",
                "date": "2026-07-28",
                "time": "09:00",
            }
        ],
    )

    row = (await db_session.execute(select(AitoEvent).where(AitoEvent.project_id == project.id))).scalar_one()
    # Org-local 09:00 at UTC+1 -> UTC 08:00 the same day.
    assert row.occurred_at == datetime(2026, 7, 28, 8, 0)


# --- should_pull_comments: the quota gate ------------------------------------
#
# Pure function, no DB or HTTP: an AitoProject built in memory (never added to
# a session) and a plain estimate dict are enough to exercise every branch.
# Books allows only 1,000-10,000 calls/day for the whole organisation, and
# this is the sole thing standing between the poller and a second call per
# project per tick, so every branch earns its own test rather than trusting
# the sweep-level tests elsewhere to happen to cover it.


def test_unchanged_watermark_and_a_recent_check_saves_the_call():
    """The common case this gate exists for: nothing new to pull, and the
    4-hour floor has not elapsed either, so no call is spent."""
    now = datetime(2026, 7, 28, 12, 0)
    project = AitoProject(
        description="Trophy",
        board_column="devis",
        quote_id="EST-1",
        zoho_comments_watermark="2026-07-28T09:00:00-1000",
        zoho_comments_checked_at=now - timedelta(minutes=5),
    )
    estimate = {"last_modified_time": "2026-07-28T09:00:00-1000"}
    assert should_pull_comments(project, estimate, now) is False


def test_a_changed_watermark_always_pulls():
    """Every event that matters moves last_modified_time, so a mismatch is
    news worth the call regardless of how recently comments were checked."""
    now = datetime(2026, 7, 28, 12, 0)
    project = AitoProject(
        description="Trophy",
        board_column="devis",
        quote_id="EST-1",
        zoho_comments_watermark="2026-07-28T09:00:00-1000",
        zoho_comments_checked_at=now - timedelta(minutes=1),
    )
    estimate = {"last_modified_time": "2026-07-28T10:30:00-1000"}
    assert should_pull_comments(project, estimate, now) is True


def test_never_pulled_before_always_pulls():
    """zoho_comments_checked_at is None: this project has never had its
    comments read, so the gate cannot yet rely on the 4-hour floor."""
    now = datetime(2026, 7, 28, 12, 0)
    project = AitoProject(
        description="Trophy",
        board_column="devis",
        quote_id="EST-1",
        zoho_comments_watermark=None,
        zoho_comments_checked_at=None,
    )
    estimate = {"last_modified_time": "2026-07-28T09:00:00-1000"}
    assert should_pull_comments(project, estimate, now) is True


def test_unchanged_watermark_past_the_four_hour_floor_still_pulls():
    """A human typing a comment in Books directly never moves
    last_modified_time, so the watermark alone would starve that comment
    forever. COMMENT_REFRESH_INTERVAL is the floor that still catches it."""
    now = datetime(2026, 7, 28, 12, 0)
    project = AitoProject(
        description="Trophy",
        board_column="devis",
        quote_id="EST-1",
        zoho_comments_watermark="2026-07-28T09:00:00-1000",
        zoho_comments_checked_at=now - COMMENT_REFRESH_INTERVAL - timedelta(minutes=1),
    )
    estimate = {"last_modified_time": "2026-07-28T09:00:00-1000"}
    assert should_pull_comments(project, estimate, now) is True
