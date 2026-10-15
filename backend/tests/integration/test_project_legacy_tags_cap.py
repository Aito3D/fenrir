"""A legacy comma-separated ``tags`` string may create at most 20 NEW catalogue tags (T-333).

Past that it is refused with the 422 body ``new_tag_names`` gets past its own cap of 20, before any
tag or project row is written. Names already in the catalogue do not count.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.models.library import LibraryTag
from backend.app.models.project import Project


def _names(count: int, prefix: str = "t") -> list[str]:
    return [f"{prefix}{i}" for i in range(count)]


async def _count(db, model) -> int:
    return (await db.execute(select(func.count()).select_from(model))).scalar_one()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_twenty_new_names_are_created(async_client: AsyncClient, db_session):
    response = await async_client.post("/api/v1/projects/", json={"name": "P", "tags": ",".join(_names(20))})
    assert response.status_code == 200, response.text
    assert len(response.json()["tag_list"]) == 20
    assert await _count(db_session, LibraryTag) == 20


@pytest.mark.asyncio
@pytest.mark.integration
async def test_twenty_one_new_names_are_refused_like_new_tag_names_and_nothing_is_created(
    async_client: AsyncClient, db_session
):
    names = _names(21)
    legacy = await async_client.post("/api/v1/projects/", json={"name": "P", "tags": ",".join(names)})
    modern = await async_client.post("/api/v1/projects/", json={"name": "P", "new_tag_names": names})
    assert modern.status_code == legacy.status_code == 422
    (modern_error,) = modern.json()["detail"]
    (legacy_error,) = legacy.json()["detail"]
    assert legacy_error["msg"] == modern_error["msg"] == "List should have at most 20 items after validation, not 21"
    assert legacy_error["type"] == modern_error["type"] == "too_long"
    assert legacy_error["ctx"] == modern_error["ctx"]
    assert legacy_error["input"] == names
    assert await _count(db_session, LibraryTag) == 0
    assert await _count(db_session, Project) == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_existing_names_do_not_count_toward_the_cap(async_client: AsyncClient, db_session):
    existing = _names(5, "old")
    db_session.add_all(LibraryTag(name=n, name_key=n) for n in existing)
    await db_session.commit()
    response = await async_client.post("/api/v1/projects/", json={"name": "P", "tags": ",".join(existing + _names(20))})
    assert response.status_code == 200, response.text
    assert len(response.json()["tag_list"]) == 25
    assert await _count(db_session, LibraryTag) == 25


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_with_too_many_new_names_is_refused_and_keeps_the_tags(async_client: AsyncClient, db_session):
    created = (await async_client.post("/api/v1/projects/", json={"name": "P", "tags": "keep"})).json()
    response = await async_client.patch(f"/api/v1/projects/{created['id']}", json={"tags": ",".join(_names(21))})
    assert response.status_code == 422
    assert await _count(db_session, LibraryTag) == 1
    again = (await async_client.get(f"/api/v1/projects/{created['id']}")).json()
    assert [t["name"] for t in again["tag_list"]] == ["keep"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_with_too_many_new_names_is_refused_whole(async_client: AsyncClient, db_session):
    response = await async_client.post("/api/v1/projects/import", json={"name": "Imp", "tags": ",".join(_names(21))})
    assert response.status_code == 422
    assert await _count(db_session, LibraryTag) == 0
    assert await _count(db_session, Project) == 0
