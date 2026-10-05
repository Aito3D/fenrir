"""Aito task ↔ project link service (spec §1.6, §4)."""

import io

import pytest
from fastapi import UploadFile
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.library import LibraryTag
from backend.app.models.project import Project
from backend.app.services import aito_project_links as links, project_storage
from backend.app.services.aito_events import KINDS
from backend.app.services.project_files import add_revision, create_item
from backend.app.services.project_tags import project_tag_refs


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)


async def _project(db, name="Support", **kwargs):
    project = Project(name=name, **kwargs)
    db.add(project)
    await db.flush()
    return project


async def _order(db, *, client_id="C1", status="active", description="Commande"):
    order = AitoProject(
        description=description,
        board_column="devis",
        status=status,
        client_id=client_id,
        client_name="ACME",
    )
    db.add(order)
    await db.flush()
    return order


async def _task(db, order, *, title="Support", linked=None):
    task = AitoTask(project_id=order.id, title=title, linked_project_id=linked)
    db.add(task)
    await db.flush()
    return task


async def _revision(db, project, item=None, *, section="impression", name="Support"):
    if item is None:
        item = await create_item(db, project, section=section, name=name, user_id=None)
        await db.commit()
    rev, _ = await add_revision(
        db,
        project,
        item,
        [UploadFile(filename="p.3mf", file=io.BytesIO(b"x"))],
        note=None,
        derived_from_id=None,
        user_id=None,
    )
    return item, rev


async def _events(db, kind=None):
    query = select(AitoEvent).order_by(AitoEvent.id)
    if kind:
        query = query.where(AitoEvent.kind == kind)
    return list((await db.execute(query)).scalars())


def test_event_kinds_registered_as_story():
    for kind in (
        "task.project_linked",
        "task.project_unlinked",
        "task.deliveries_changed",
        "project.revision_added",
        "project.revision_status_changed",
        "project.files_dropped",
    ):
        assert KINDS[kind] == "story"


# --- link_task -------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_does_not_mark_quote_pending(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    order.quote_sync_state = "idle"
    version_before = order.version
    task = await _task(db_session, order)

    await links.link_task(db_session, task, project.id, actor="Paul")

    assert task.linked_project_id == project.id
    assert order.quote_sync_state == "idle"
    assert order.version == version_before
    [event] = await _events(db_session, "task.project_linked")
    assert event.project_id == order.id
    assert event.subject_type == "task"
    assert event.subject_id == task.id
    assert event.subject_label == "Support"
    assert event.actor_class == "user"
    assert event.actor_name == "Paul"
    assert event.detail == {"project_id": project.id, "code": project.code, "name": "Support"}


@pytest.mark.asyncio
async def test_unlink_records_event(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)

    await links.link_task(db_session, task, None, actor=None)

    assert task.linked_project_id is None
    [event] = await _events(db_session, "task.project_unlinked")
    assert event.actor_class == "system"
    assert event.detail == {"project_id": project.id, "code": project.code, "name": "Support"}


@pytest.mark.asyncio
async def test_link_to_same_project_is_a_noop(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)

    await links.link_task(db_session, task, project.id, actor="Paul")

    assert await _events(db_session) == []


@pytest.mark.asyncio
async def test_relink_clears_deliveries(db_session):
    project = await _project(db_session)
    other = await _project(db_session, name="Autre")
    _item, rev = await _revision(db_session, project)
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)
    db_session.add(AitoTaskDelivery(task_id=task.id, revision_id=rev.id))
    await db_session.flush()

    await links.link_task(db_session, task, other.id, actor="Paul")
    assert (await db_session.execute(select(AitoTaskDelivery))).first() is None

    db_session.add(AitoTaskDelivery(task_id=task.id, revision_id=rev.id))
    await db_session.flush()
    await links.link_task(db_session, task, None, actor="Paul")
    assert (await db_session.execute(select(AitoTaskDelivery))).first() is None


@pytest.mark.asyncio
async def test_link_to_template_is_400(db_session):
    template = await _project(db_session, name="Modele", is_template=True)
    order = await _order(db_session)
    task = await _task(db_session, order)
    with pytest.raises(links.LinkError) as exc:
        await links.link_task(db_session, task, template.id, actor="Paul")
    assert exc.value.status_code == 400
    assert task.linked_project_id is None


@pytest.mark.asyncio
async def test_move_between_projects_records_previous(db_session):
    first = await _project(db_session)
    second = await _project(db_session, name="Autre")
    order = await _order(db_session)
    task = await _task(db_session, order, linked=first.id)

    await links.link_task(db_session, task, second.id, actor="Paul")

    [event] = await _events(db_session, "task.project_linked")
    assert event.detail == {
        "project_id": second.id,
        "code": second.code,
        "name": "Autre",
        "previous_project_id": first.id,
        "previous_code": first.code,
    }


@pytest.mark.asyncio
async def test_link_to_missing_project_is_404(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    with pytest.raises(links.LinkError) as exc:
        await links.link_task(db_session, task, 99999, actor="Paul")
    assert exc.value.status_code == 404
    assert task.linked_project_id is None


# --- create_project_for_task -----------------------------------------------


@pytest.mark.asyncio
async def test_create_project_for_task(db_session):
    tag = LibraryTag(name="Moto", name_key="moto")
    db_session.add(tag)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await db_session.flush()

    project = await links.create_project_for_task(
        db_session,
        task,
        name="Support guidon",
        description="Pour ACME",
        tag_ids=[tag.id],
        new_tag_names=["Alu"],
        actor="Paul",
    )

    assert project.id is not None
    assert project.code and project.code.startswith("P-")
    assert project.description == "Pour ACME"
    assert task.linked_project_id == project.id
    refs = (await project_tag_refs(db_session, [project.id]))[project.id]
    assert sorted(ref.name for ref in refs) == ["Alu", "Moto"]
    assert len(await _events(db_session, "task.project_linked")) == 1


@pytest.mark.asyncio
async def test_create_project_unknown_tag_is_400(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    with pytest.raises(links.LinkError) as exc:
        await links.create_project_for_task(
            db_session, task, name="X", description=None, tag_ids=[424242], new_tag_names=[], actor=None
        )
    assert exc.value.status_code == 400


# --- suggest_projects ------------------------------------------------------


@pytest.mark.asyncio
async def test_suggestions_same_client_then_similar_title(db_session):
    older_client = await _project(db_session, name="Boîtier capteur")
    newer_client = await _project(db_session, name="Plaque moteur")
    similar_best = await _project(db_session, name="Support guidon")
    similar_ok = await _project(db_session, name="Support de guidon moto")
    _unrelated = await _project(db_session, name="Zzz qqq")
    template = await _project(db_session, name="Support guidon modèle", is_template=True)
    current = await _project(db_session, name="Support guidon v2")
    other_client = await _project(db_session, name="Vase")

    order_a = await _order(db_session, client_id="C1")
    await _task(db_session, order_a, title="a", linked=older_client.id)
    order_b = await _order(db_session, client_id="C1")
    await _task(db_session, order_b, title="b", linked=newer_client.id)
    order_c = await _order(db_session, client_id="C2")
    await _task(db_session, order_c, title="c", linked=other_client.id)
    order_t = await _order(db_session, client_id="C1")
    await _task(db_session, order_t, title="t", linked=template.id)

    order = await _order(db_session, client_id="C1")
    task = await _task(db_session, order, title="Support guidon", linked=current.id)

    suggestions = await links.suggest_projects(db_session, task)

    assert [(s.id, s.reason) for s in suggestions] == [
        (newer_client.id, "same_client"),
        (older_client.id, "same_client"),
        (similar_best.id, "similar_title"),
        (similar_ok.id, "similar_title"),
    ]
    assert suggestions[0].code == newer_client.code

    capped = await links.suggest_projects(db_session, task, limit=3)
    assert [s.id for s in capped] == [newer_client.id, older_client.id, similar_best.id]


@pytest.mark.asyncio
async def test_suggestions_deduplicate_same_client_and_title(db_session):
    project = await _project(db_session, name="Support guidon")
    order_a = await _order(db_session, client_id="C1")
    await _task(db_session, order_a, title="x", linked=project.id)
    await _task(db_session, order_a, title="y", linked=project.id)
    order = await _order(db_session, client_id="C1")
    task = await _task(db_session, order, title="Support guidon")

    suggestions = await links.suggest_projects(db_session, task)

    assert [(s.id, s.reason) for s in suggestions] == [(project.id, "same_client")]


# --- set_deliveries ---------------------------------------------------------


@pytest.mark.asyncio
async def test_deliveries_require_link(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    with pytest.raises(links.LinkError) as exc:
        await links.set_deliveries(db_session, task, [1], actor="Paul")
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_deliveries_must_belong_to_linked_project(db_session):
    project = await _project(db_session)
    other = await _project(db_session, name="Autre")
    _item, own = await _revision(db_session, project)
    _item2, foreign = await _revision(db_session, other)
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)

    with pytest.raises(links.LinkError) as exc:
        await links.set_deliveries(db_session, task, [own.id, foreign.id, 987654], actor="Paul")

    assert exc.value.status_code == 400
    assert str(foreign.id) in exc.value.detail
    assert "987654" in exc.value.detail
    assert str(own.id) not in exc.value.detail.split(":")[-1].split(", ")
    assert (await db_session.execute(select(AitoTaskDelivery))).first() is None


@pytest.mark.asyncio
async def test_deliveries_replace_rows_and_record_labels(db_session):
    project = await _project(db_session)
    item, r1 = await _revision(db_session, project, name="Support")
    _item, r2 = await _revision(db_session, project, item)
    _mesh, m1 = await _revision(db_session, project, section="scan", name="Mesh brut")
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)

    result = await links.set_deliveries(db_session, task, [r1.id, m1.id, r1.id], actor="Paul")
    assert sorted(result) == sorted([r1.id, m1.id])
    [first] = await _events(db_session, "task.deliveries_changed")
    assert sorted(first.detail["added"]) == ["Mesh brut R1", "Support R1"]
    assert first.detail["removed"] == []
    assert first.subject_id == task.id
    assert first.project_id == order.id

    result = await links.set_deliveries(db_session, task, [r2.id, m1.id], actor="Paul")
    assert sorted(result) == sorted([r2.id, m1.id])
    rows = (await db_session.execute(select(AitoTaskDelivery.revision_id))).scalars().all()
    assert sorted(rows) == sorted([r2.id, m1.id])
    second = (await _events(db_session, "task.deliveries_changed"))[-1]
    assert second.detail == {"added": ["Support R2"], "removed": ["Support R1"]}


@pytest.mark.asyncio
async def test_deliveries_unchanged_records_nothing(db_session):
    project = await _project(db_session)
    _item, r1 = await _revision(db_session, project)
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)

    await links.set_deliveries(db_session, task, [r1.id], actor="Paul")
    await links.set_deliveries(db_session, task, [r1.id], actor="Paul")

    assert len(await _events(db_session, "task.deliveries_changed")) == 1


# --- order_links --------------------------------------------------------------


@pytest.mark.asyncio
async def test_order_links_sections_and_deliveries(db_session):
    project = await _project(db_session)
    support, s1 = await _revision(db_session, project, name="Support")
    _support, s2 = await _revision(db_session, project, support)
    impression_names = ["Pied", "Capot", "Clip"]
    for name in impression_names:
        await _revision(db_session, project, name=name)
    _mesh, m1 = await _revision(db_session, project, section="scan", name="Mesh brut")
    await create_item(db_session, project, section="docs", name="Vide", user_id=None)
    await db_session.commit()

    order = await _order(db_session)
    linked = await _task(db_session, order, title="Lié", linked=project.id)
    unlinked = await _task(db_session, order, title="Libre")
    other_order = await _order(db_session)
    await _task(db_session, other_order, linked=project.id)
    db_session.add(AitoTaskDelivery(task_id=linked.id, revision_id=s1.id))
    await db_session.flush()

    result = await links.order_links(db_session, order.id)

    assert result.order_id == order.id
    by_task = {t.task_id: t for t in result.tasks}
    assert set(by_task) == {linked.id, unlinked.id}
    assert by_task[unlinked.id].project is None
    assert by_task[unlinked.id].sections == {}
    assert by_task[unlinked.id].deliveries == []

    entry = by_task[linked.id]
    assert entry.project.id == project.id
    assert entry.project.code == project.code
    assert entry.deliveries == [s1.id]
    assert set(entry.sections) == {"impression", "scan"}
    impression = entry.sections["impression"]
    assert len(impression) == 3
    # Newest activity first: Clip, Capot, Pied were added after Support R2.
    assert [s.item_name for s in impression] == ["Clip", "Capot", "Pied"]
    assert entry.sections["scan"][0].item_name == "Mesh brut"
    assert entry.sections["scan"][0].number == m1.number


@pytest.mark.asyncio
async def test_order_links_newest_revision_per_item(db_session):
    project = await _project(db_session)
    support, _s1 = await _revision(db_session, project, name="Support")
    _support, s2 = await _revision(db_session, project, support)
    order = await _order(db_session)
    task = await _task(db_session, order, linked=project.id)

    result = await links.order_links(db_session, order.id)

    [entry] = result.tasks
    [summary] = entry.sections["impression"]
    assert summary.item_id == support.id
    assert summary.number == 2
    assert summary.status == s2.status
    assert entry.task_id == task.id


# --- codes_by_order -----------------------------------------------------------


@pytest.mark.asyncio
async def test_codes_by_order(db_session):
    p1 = await _project(db_session, name="Un")
    p2 = await _project(db_session, name="Deux")
    order = await _order(db_session)
    await _task(db_session, order, linked=p1.id)
    await _task(db_session, order, linked=p1.id)
    await _task(db_session, order, linked=p2.id)
    await _task(db_session, order)
    lone = await _order(db_session)
    await _task(db_session, lone, linked=p2.id)
    deleted = await _order(db_session, status="deleted")
    await _task(db_session, deleted, linked=p1.id)
    empty = await _order(db_session)
    await _task(db_session, empty)

    codes = await links.codes_by_order(db_session)

    assert sorted(codes[order.id]) == sorted([p1.code, p2.code])
    assert codes[lone.id] == [p2.code]
    assert deleted.id not in codes
    assert empty.id not in codes


# --- orders_for_project -----------------------------------------------------


@pytest.mark.asyncio
async def test_orders_for_project(db_session):
    project = await _project(db_session)
    _item, rev = await _revision(db_session, project)
    first = await _order(db_session, description="Première")
    t1 = await _task(db_session, first, title="T1", linked=project.id)
    second = await _order(db_session, description="Seconde")
    second.board_column = "done"
    t2 = await _task(db_session, second, title="T2", linked=project.id)
    deleted = await _order(db_session, status="deleted")
    await _task(db_session, deleted, linked=project.id)
    other = await _project(db_session, name="Autre")
    await _task(db_session, first, title="ailleurs", linked=other.id)
    db_session.add(AitoTaskDelivery(task_id=t1.id, revision_id=rev.id))
    await db_session.flush()

    response = await links.orders_for_project(db_session, project.id)

    assert [o.task_id for o in response.orders] == [t2.id, t1.id]
    newest, oldest = response.orders
    assert newest.order_id == second.id
    assert newest.order_description == "Seconde"
    assert newest.board_column == "done"
    assert newest.client_name == "ACME"
    assert newest.task_title == "T2"
    assert newest.deliveries == []
    [ref] = oldest.deliveries
    assert ref.id == rev.id
    assert ref.item_name == "Support"
    assert ref.section == "impression"
    assert ref.number == 1


# --- record_on_linked_orders -----------------------------------------------


@pytest.mark.asyncio
async def test_record_on_linked_orders_one_event_per_order(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    await _task(db_session, order, linked=project.id)
    await _task(db_session, order, linked=project.id)
    second = await _order(db_session)
    await _task(db_session, second, linked=project.id)
    deleted = await _order(db_session, status="deleted")
    await _task(db_session, deleted, linked=project.id)
    unrelated = await _order(db_session)
    await _task(db_session, unrelated)

    count = await links.record_on_linked_orders(
        db_session,
        project.id,
        "project.revision_added",
        actor="Paul",
        subject_label="Support R2",
        detail={"section": "impression"},
    )

    assert count == 2
    events = await _events(db_session, "project.revision_added")
    assert sorted(e.project_id for e in events) == sorted([order.id, second.id])
    assert all(e.subject_label == "Support R2" for e in events)
    # subject_type "project" means the ORDER on this timeline, so the PDM
    # project travels in the detail instead.
    assert all(e.subject_type is None and e.subject_id is None for e in events)
    assert all(e.detail == {"project_id": project.id, "code": project.code, "section": "impression"} for e in events)
