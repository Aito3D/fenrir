import pytest
from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError

from backend.app.models.library import LibraryTag, prune_empty_library_tags
from backend.app.models.project import Project
from backend.app.schemas.project import ProjectTagRef
from backend.app.services.openrouter import parse_tag_lines
from backend.app.services.project_tags import (
    UnknownTagError,
    _is_tag_name_conflict,
    apply_project_tag_input,
    get_or_create_tags,
    project_tag_refs,
    rank_tag_suggestions,
    refresh_tag_mirrors,
    set_project_tags,
    sync_project_tags_from_string,
    tag_name_key,
)


async def _project(db, name="P", tags=None):
    project = Project(name=name, tags=tags)
    db.add(project)
    await db.flush()
    return project


@pytest.mark.asyncio
async def test_get_or_create_reuses_case_insensitively(db_session):
    db_session.add(LibraryTag(name="Drone", name_key="drone"))
    await db_session.flush()
    tags = await get_or_create_tags(db_session, [" drone ", "Pièce, auto", "pièce  auto"])
    assert [t.name for t in tags] == ["Drone", "Pièce  auto"]
    assert len((await db_session.execute(select(LibraryTag))).scalars().all()) == 2


@pytest.mark.asyncio
async def test_set_project_tags_replaces_rows_and_mirror(db_session):
    project = await _project(db_session)
    a, b = await get_or_create_tags(db_session, ["zèbre", "Abeille"])
    await set_project_tags(db_session, project, [a.id, b.id, a.id])
    assert project.tags == "Abeille, zèbre"
    await set_project_tags(db_session, project, [b.id])
    refs = await project_tag_refs(db_session, [project.id])
    assert [r.name for r in refs[project.id]] == ["Abeille"]
    assert project.tags == "Abeille"


@pytest.mark.asyncio
async def test_set_project_tags_rejects_unknown_ids(db_session):
    project = await _project(db_session)
    with pytest.raises(UnknownTagError) as err:
        await set_project_tags(db_session, project, [999])
    assert err.value.tag_ids == [999]


@pytest.mark.asyncio
async def test_apply_input_creates_new_names(db_session):
    project = await _project(db_session)
    (existing,) = await get_or_create_tags(db_session, ["drone"])
    await apply_project_tag_input(db_session, project, tag_ids=[existing.id], new_tag_names=["support"])
    assert project.tags == "drone, support"


@pytest.mark.asyncio
async def test_sync_from_legacy_string(db_session):
    project = await _project(db_session, tags="b, A,a")
    await sync_project_tags_from_string(db_session, project)
    assert project.tags == "A, b"


@pytest.mark.asyncio
async def test_prune_keeps_project_only_tags(db_session):
    project = await _project(db_session)
    (kept,) = await get_or_create_tags(db_session, ["projet-seul"])
    await get_or_create_tags(db_session, ["orphelin"])
    await set_project_tags(db_session, project, [kept.id])
    await prune_empty_library_tags(db_session)
    names = (await db_session.execute(select(LibraryTag.name))).scalars().all()
    assert "projet-seul" in names
    assert "orphelin" not in names


def test_parse_tag_lines_strips_bullets_and_quotes():
    assert parse_tag_lines('- drone\n2. "Pièce auto"\n• support, fixation\n\n') == [
        "drone",
        "Pièce auto",
        "support",
        "fixation",
    ]


def test_rank_puts_existing_first_caps_new_at_two_and_total_at_five():
    catalogue = {"drone": ProjectTagRef(id=1, name="Drone"), "fpv": ProjectTagRef(id=2, name="FPV")}
    ranked = rank_tag_suggestions(["neuf1", "drone", "neuf2", "neuf3", "FPV", "drone"], catalogue, exclude_ids=set())
    assert [(s.name, s.tag_id) for s in ranked] == [("Drone", 1), ("FPV", 2), ("neuf1", None), ("neuf2", None)]


def test_rank_skips_tags_the_project_already_has():
    catalogue = {"drone": ProjectTagRef(id=1, name="Drone")}
    assert rank_tag_suggestions(["drone"], catalogue, exclude_ids={1}) == []


def test_parse_tag_lines_keeps_leading_digits_of_real_tags():
    assert parse_tag_lines("3D\n- 3MF\n1) impression 3D") == ["3D", "3MF", "impression 3D"]


def test_split_tag_string_dedupes_by_key_first_spelling_wins_in_order():
    from backend.app.services.project_tags import split_tag_string

    assert split_tag_string(" Drone ,,drone, DRONE ,  , pièce auto,Pièce Auto, zèbre,") == [
        "Drone",
        "pièce auto",
        "zèbre",
    ]
    assert split_tag_string(None) == []
    assert split_tag_string(" , ,") == []


@pytest.mark.asyncio
async def test_get_or_create_dedupes_case_whitespace_and_skips_empty(db_session):
    db_session.add(LibraryTag(name="Existing", name_key="existing"))
    await db_session.flush()
    tags = await get_or_create_tags(
        db_session, ["  ", "Nouveau", "existing ", " NOUVEAU", "", ",", "Autre", "EXISTING"]
    )
    assert [t.name for t in tags] == ["Nouveau", "Existing", "Autre"]
    assert len({id(t) for t in tags}) == 3
    assert sorted(t.name_key for t in (await db_session.execute(select(LibraryTag))).scalars().all()) == [
        "autre",
        "existing",
        "nouveau",
    ]
    assert await get_or_create_tags(db_session, ["", " , "]) == []


def test_rank_dedupes_by_key_skips_empty_and_keeps_order():
    catalogue = {"drone": ProjectTagRef(id=7, name="Drone"), "owned": ProjectTagRef(id=9, name="Owned")}
    out = rank_tag_suggestions(
        ["  ", "Neuf", "neuf ", "DRONE", "drone", "", "owned", "Autre", "Troisième"], catalogue, {9}
    )
    assert [(s.name, s.tag_id) for s in out] == [("Drone", 7), ("Neuf", None), ("Autre", None)]


@pytest.mark.asyncio
async def test_refresh_tag_mirrors_with_no_projects_is_a_noop(db_session):
    project = await _project(db_session, tags="kept")
    await refresh_tag_mirrors(db_session, [])
    assert project.tags == "kept"


def test_library_tags_name_key_delegates_to_tag_name_key():
    from backend.app.api.routes.library_tags import _name_key

    for raw in ("  Toys  ", "TOYS", "toys", "\tMiXeD Case\n"):
        assert _name_key(raw) == tag_name_key(raw)
    assert tag_name_key("  MiXeD Case ") == "mixed case"


@pytest.mark.asyncio
async def test_get_or_create_reuses_the_tag_a_concurrent_request_created_first(db_session):
    """Lost race: the row appears between the lookup and the insert; no IntegrityError, same row returned."""
    real_execute = db_session.execute
    calls = 0

    async def racing_execute(statement, *args, **kwargs):
        nonlocal calls
        result = await real_execute(statement, *args, **kwargs)
        calls += 1
        if calls == 1:  # the competitor commits right after our lookup missed
            await real_execute(insert(LibraryTag).values(name="Drone", name_key="drone"))
        return result

    db_session.execute = racing_execute
    try:
        tags = await get_or_create_tags(db_session, ["drone", "Autre"])
    finally:
        del db_session.execute
    assert [t.name for t in tags] == ["Drone", "Autre"]
    assert all(t.id is not None for t in tags)
    rows = (await db_session.execute(select(LibraryTag.name_key))).scalars().all()
    assert sorted(rows) == ["autre", "drone"]


@pytest.mark.asyncio
async def test_get_or_create_propagates_an_unrelated_integrity_error(db_session, monkeypatch):
    async def boom():
        raise IntegrityError("INSERT", {}, Exception("NOT NULL constraint failed: library_tags.name"))

    monkeypatch.setattr(db_session, "flush", boom)
    with pytest.raises(IntegrityError, match="NOT NULL"):
        await get_or_create_tags(db_session, ["x"])


@pytest.mark.asyncio
async def test_get_or_create_reraises_a_name_conflict_with_no_winner_row(db_session, monkeypatch):
    async def boom():
        raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: library_tags.name_key"))

    monkeypatch.setattr(db_session, "flush", boom)
    with pytest.raises(IntegrityError, match="library_tags.name_key"):
        await get_or_create_tags(db_session, ["x"])


def test_tag_name_conflict_matches_sqlite_and_postgres_texts():
    sqlite = IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: library_tags.name_key"))
    pg_index = IntegrityError(
        "INSERT", {}, Exception('duplicate key value violates unique constraint "ix_library_tags_name_key"')
    )
    other = IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: project_items.name_key"))
    assert _is_tag_name_conflict(sqlite)
    assert _is_tag_name_conflict(pg_index)
    assert not _is_tag_name_conflict(other)
