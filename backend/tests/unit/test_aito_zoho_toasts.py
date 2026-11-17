"""Zoho result toasts go out after commit, once, and never for a rollback."""

import asyncio

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_zoho_toasts
from backend.app.services.aito_events import record


@pytest.fixture
def sent(monkeypatch):
    messages: list[dict] = []

    async def capture(message):
        messages.append(message)

    monkeypatch.setattr(aito_zoho_toasts.ws_manager, "broadcast_aito", capture)
    return messages


async def _settle():
    for _ in range(3):
        await asyncio.sleep(0)


async def _project(db) -> AitoProject:
    project = AitoProject(
        description="x", board_column="devis", client_name="Client de passage", quote_number="DEV26-3038"
    )
    db.add(project)
    await db.commit()
    return project


@pytest.mark.asyncio
async def test_toast_is_sent_after_commit_with_the_document_number(db_session, sent):
    project = await _project(db_session)
    await record(db_session, project.id, "quote.created", actor_class="system", detail={"quote_number": "DEV26-3038"})
    await _settle()
    assert sent == []  # nothing before the commit

    await db_session.commit()
    await _settle()
    assert len(sent) == 1
    assert sent[0]["type"] == "aito_zoho"
    assert sent[0]["kind"] == "quote.created"
    assert sent[0]["doc"] == "DEV26-3038"
    assert sent[0]["client"] == "Client de passage"

    await db_session.commit()  # drained: a later commit sends nothing again
    await _settle()
    assert len(sent) == 1


@pytest.mark.asyncio
async def test_rollback_drops_the_toast(db_session, sent):
    project = await _project(db_session)
    await record(db_session, project.id, "invoice.created", actor_class="user", detail={"invoice_number": "FA-1"})
    await db_session.rollback()
    await db_session.commit()
    await _settle()
    assert sent == []


@pytest.mark.asyncio
async def test_untoasted_kinds_and_doc_fallback(db_session, sent):
    project = await _project(db_session)
    await record(db_session, project.id, "sync.pushed", actor_class="system")
    await record(db_session, project.id, "sync.failed", actor_class="system", detail={"error": "boom"})
    await db_session.commit()
    await _settle()
    assert [m["kind"] for m in sent] == ["sync.failed"]
    assert sent[0]["doc"] == "DEV26-3038"  # no number in the detail: the card's quote
    assert sent[0]["error"] == "boom"
