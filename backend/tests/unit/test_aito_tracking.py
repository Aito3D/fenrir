"""Tracking token: minting, link building, and the two response fields."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.settings import Settings
from backend.app.services.aito_tracking import (
    build_tracking_url,
    ensure_tracking_token,
    mint_token,
    tracking_url,
    tracking_url_for,
)


async def _create(client, **overrides):
    payload = {"description": "Job", "client_id": "zA", "client_name": "ACME", "client_phone": "+689 87 00 00 01"}
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _project(db_session, pid: int) -> AitoProject:
    return (await db_session.execute(select(AitoProject).where(AitoProject.id == pid))).scalar_one()


async def _set_external_url(db_session, value: str):
    db_session.add(Settings(key="external_url", value=value))
    await db_session.commit()


def test_mint_token_is_43_urlsafe_chars_and_unique():
    a, b = mint_token(), mint_token()
    assert len(a) == 43 and a != b
    assert all(c.isalnum() or c in "-_" for c in a)


def test_tracking_url_for_needs_both_halves():
    assert tracking_url_for("", "abc") is None
    assert tracking_url_for("https://x.pf", None) is None
    assert tracking_url_for("https://x.pf", "abc") == "https://x.pf/track/abc"


@pytest.mark.asyncio
async def test_ensure_mints_once_and_is_stable(async_client, db_session):
    pid = await _create(async_client)
    project = await _project(db_session, pid)
    assert project.tracking_token is None
    first = await ensure_tracking_token(db_session, project)
    second = await ensure_tracking_token(db_session, project)
    await db_session.commit()
    assert first == second == (await _project(db_session, pid)).tracking_token
    other = await _project(db_session, await _create(async_client, description="other"))
    assert await ensure_tracking_token(db_session, other) != first


@pytest.mark.asyncio
async def test_tracking_url_follows_external_url_without_minting(async_client, db_session):
    pid = await _create(async_client)
    project = await _project(db_session, pid)
    assert await tracking_url(db_session, project) is None
    assert project.tracking_token is None  # a read never mints
    await _set_external_url(db_session, "https://aito.example/")
    assert await tracking_url(db_session, project) is None  # still no token
    url = await build_tracking_url(db_session, project)
    assert url == f"https://aito.example/track/{project.tracking_token}"
    assert await tracking_url(db_session, project) == url


@pytest.mark.asyncio
async def test_build_mints_even_when_external_url_is_empty(async_client, db_session):
    project = await _project(db_session, await _create(async_client))
    assert await build_tracking_url(db_session, project) is None
    assert project.tracking_token is not None


@pytest.mark.asyncio
async def test_project_responses_carry_tracking_fields(async_client, db_session):
    pid = await _create(async_client)
    body = (await async_client.get("/api/v1/aito/")).json()[0]
    assert body["tracking_url"] is None and body["tracking_configured"] is False
    await _set_external_url(db_session, "https://aito.example")
    project = await _project(db_session, pid)
    await ensure_tracking_token(db_session, project)
    await db_session.commit()
    body = (await async_client.get("/api/v1/aito/")).json()[0]
    assert body["tracking_configured"] is True
    assert body["tracking_url"] == f"https://aito.example/track/{project.tracking_token}"
