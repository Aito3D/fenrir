"""Aito task ↔ project link service (spec §1.6, §4)."""

import asyncio
import io
import logging
from functools import partial

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import delete, func, select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.library import LibraryFile, LibraryTag
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.models.user import User
from backend.app.services import aito_project_links as links, project_files
from backend.app.services.aito_events import KINDS
from backend.app.services.project_files import add_revision, create_item
from backend.app.services.project_filing import section_for_filename
from backend.app.services.project_tags import project_tag_refs
from backend.tests.project_fixtures import (
    make_order,
    make_project,
    make_task,
    projects_root_fixture,
    threemf_bytes,
    upload,
)

root = projects_root_fixture(autouse=True)
_project = partial(make_project, name="Support")
_order = make_order
_task = make_task


async def _revision(db, project, item=None, *, section="impression", name="Support"):
    if item is None:
        item = await create_item(db, project, section=section, name=name, user_id=None)
        await db.commit()
    rev, _ = await add_revision(
        db,
        project,
        item,
        [UploadFile(filename="p.3mf", file=io.BytesIO(threemf_bytes()))],
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
    task = await _task(db_session, order, linked_project_id=project.id)

    await links.link_task(db_session, task, None, actor=None)

    assert task.linked_project_id is None
    [event] = await _events(db_session, "task.project_unlinked")
    assert event.actor_class == "system"
    assert event.detail == {"project_id": project.id, "code": project.code, "name": "Support"}


@pytest.mark.asyncio
async def test_link_to_same_project_is_a_noop(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)

    await links.link_task(db_session, task, project.id, actor="Paul")

    assert await _events(db_session) == []


@pytest.mark.asyncio
async def test_relink_clears_deliveries(db_session):
    project = await _project(db_session)
    other = await _project(db_session, name="Autre")
    _item, rev = await _revision(db_session, project)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
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
    task = await _task(db_session, order, linked_project_id=first.id)

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
    await _task(db_session, order_a, title="a", linked_project_id=older_client.id)
    order_b = await _order(db_session, client_id="C1")
    await _task(db_session, order_b, title="b", linked_project_id=newer_client.id)
    order_c = await _order(db_session, client_id="C2")
    await _task(db_session, order_c, title="c", linked_project_id=other_client.id)
    order_t = await _order(db_session, client_id="C1")
    await _task(db_session, order_t, title="t", linked_project_id=template.id)

    order = await _order(db_session, client_id="C1")
    task = await _task(db_session, order, title="Support guidon", linked_project_id=current.id)

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
    await _task(db_session, order_a, title="x", linked_project_id=project.id)
    await _task(db_session, order_a, title="y", linked_project_id=project.id)
    order = await _order(db_session, client_id="C1")
    task = await _task(db_session, order, title="Support guidon")

    suggestions = await links.suggest_projects(db_session, task)

    assert [(s.id, s.reason) for s in suggestions] == [(project.id, "same_client")]


@pytest.mark.asyncio
async def test_similar_title_ties_sort_by_project_id_and_ignore_case(db_session):
    # Pin: equal ratios keep ascending project id; the compare is case-folded.
    first = await _project(db_session, name="SUPPORT GUIDON")
    second = await _project(db_session, name="support guidon")
    order = await _order(db_session, client_id="C9")
    task = await _task(db_session, order, title="  Support Guidon ")

    suggestions = await links.suggest_projects(db_session, task)

    assert [(s.id, s.reason) for s in suggestions] == [(first.id, "similar_title"), (second.id, "similar_title")]


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
    task = await _task(db_session, order, linked_project_id=project.id)

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
    task = await _task(db_session, order, linked_project_id=project.id)

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
async def test_deliveries_share_lock_the_added_revisions_after_the_flush(db_session, monkeypatch):
    """T-291: on PostgreSQL the added revisions are locked FOR SHARE before the re-check."""
    project = await _project(db_session)
    _item, r1 = await _revision(db_session, project, name="Support")
    _mesh, m1 = await _revision(db_session, project, section="scan", name="Mesh brut")
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    calls = []

    async def lock(db, revision_ids, *, share=False):
        pending = await db.execute(select(AitoTaskDelivery.revision_id).where(AitoTaskDelivery.task_id == task.id))
        calls.append((sorted(revision_ids), share, sorted(pending.scalars())))
        return None

    monkeypatch.setattr(links, "lock_revision_rows", lock)
    await links.set_deliveries(db_session, task, [r1.id], actor="Paul")
    # the delivery row is already flushed when the lock is taken
    assert calls == [([r1.id], True, [r1.id])]
    await links.set_deliveries(db_session, task, [m1.id], actor="Paul")  # one added, one removed
    assert calls[1] == ([m1.id], True, [m1.id])
    await links.set_deliveries(db_session, task, [], actor="Paul")  # nothing added: no lock
    await links.set_deliveries(db_session, task, [], actor="Paul")  # unchanged: no lock
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_deliveries_refuse_a_revision_deleted_after_validation(db_session, monkeypatch):
    project = await _project(db_session)
    _item, r1 = await _revision(db_session, project, name="Support")
    _mesh, m1 = await _revision(db_session, project, section="scan", name="Mesh brut")
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    gone_id = m1.id
    real = links._revision_bundles
    calls = []

    async def racing(db, revision_ids):
        bundles = await real(db, revision_ids)
        if not calls:  # delete_revision commits between the validation and the insert
            calls.append(list(revision_ids))
            await db.execute(delete(ProjectRevision).where(ProjectRevision.id == gone_id))
            await db.commit()
        return bundles

    monkeypatch.setattr(links, "_revision_bundles", racing)
    with pytest.raises(links.LinkError) as exc:
        await links.set_deliveries(db_session, task, [r1.id, gone_id], actor="Paul")
    assert calls == [[r1.id, gone_id]]
    assert (exc.value.status_code, exc.value.detail) == (409, f"Revisions deleted meanwhile: {gone_id}")
    await db_session.rollback()  # the route rolls back on LinkError
    assert (await db_session.execute(select(AitoTaskDelivery))).first() is None
    assert await _events(db_session, "task.deliveries_changed") == []


@pytest.mark.asyncio
async def test_deliveries_unchanged_records_nothing(db_session):
    project = await _project(db_session)
    _item, r1 = await _revision(db_session, project)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)

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
    linked = await _task(db_session, order, title="Lié", linked_project_id=project.id)
    unlinked = await _task(db_session, order, title="Libre")
    other_order = await _order(db_session)
    await _task(db_session, other_order, linked_project_id=project.id)
    db_session.add(AitoTaskDelivery(task_id=linked.id, revision_id=s1.id))
    await db_session.flush()

    result = await links.order_links(db_session, order.id)

    assert result.order_id == order.id
    by_task = {t.task_id: t for t in result.tasks}
    assert set(by_task) == {linked.id, unlinked.id}
    assert by_task[unlinked.id].task_title == "Libre"
    assert by_task[linked.id].task_title == "Lié"
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
    task = await _task(db_session, order, linked_project_id=project.id)

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
    await _task(db_session, order, linked_project_id=p1.id)
    await _task(db_session, order, linked_project_id=p1.id)
    await _task(db_session, order, linked_project_id=p2.id)
    await _task(db_session, order)
    lone = await _order(db_session)
    await _task(db_session, lone, linked_project_id=p2.id)
    deleted = await _order(db_session, status="deleted")
    await _task(db_session, deleted, linked_project_id=p1.id)
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
    t1 = await _task(db_session, first, title="T1", linked_project_id=project.id)
    second = await _order(db_session, description="Seconde")
    second.board_column = "done"
    t2 = await _task(db_session, second, title="T2", linked_project_id=project.id)
    deleted = await _order(db_session, status="deleted")
    await _task(db_session, deleted, linked_project_id=project.id)
    other = await _project(db_session, name="Autre")
    await _task(db_session, first, title="ailleurs", linked_project_id=other.id)
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


@pytest.mark.asyncio
async def test_orders_for_project_delivery_ref_is_project_files_revision_ref(db_session):
    project = await _project(db_session)
    item, rev = await _revision(db_session, project)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    db_session.add(AitoTaskDelivery(task_id=task.id, revision_id=rev.id))
    await db_session.flush()

    response = await links.orders_for_project(db_session, project.id)

    [ref] = response.orders[0].deliveries
    assert ref == project_files.revision_ref(rev, item)
    assert (ref.id, ref.item_id, ref.item_name, ref.section, ref.number, ref.status) == (
        rev.id,
        item.id,
        item.name,
        item.section,
        rev.number,
        rev.status,
    )


# --- record_on_linked_orders -----------------------------------------------


@pytest.mark.asyncio
async def test_record_on_linked_orders_one_event_per_order(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    await _task(db_session, order, linked_project_id=project.id)
    await _task(db_session, order, linked_project_id=project.id)
    second = await _order(db_session)
    await _task(db_session, second, linked_project_id=project.id)
    deleted = await _order(db_session, status="deleted")
    await _task(db_session, deleted, linked_project_id=project.id)
    unrelated = await _order(db_session)
    await _task(db_session, unrelated)

    order_ids = await links.record_on_linked_orders(
        db_session,
        project.id,
        "project.revision_added",
        actor="Paul",
        subject_label="Support R2",
        detail={"section": "impression"},
    )

    assert order_ids == sorted([order.id, second.id])
    events = await _events(db_session, "project.revision_added")
    assert sorted(e.project_id for e in events) == sorted([order.id, second.id])
    assert all(e.subject_label == "Support R2" for e in events)
    # subject_type "project" means the ORDER on this timeline, so the PDM
    # project travels in the detail instead.
    assert all(e.subject_type is None and e.subject_id is None for e in events)
    assert all(e.detail == {"project_id": project.id, "code": project.code, "section": "impression"} for e in events)


@pytest.mark.asyncio
async def test_record_on_linked_orders_skips_excluded_orders(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    await _task(db_session, order, linked_project_id=project.id)
    second = await _order(db_session)
    await _task(db_session, second, linked_project_id=project.id)

    order_ids = await links.record_on_linked_orders(
        db_session,
        project.id,
        "project.revision_added",
        actor=None,
        subject_label="Support R1",
        detail=None,
        exclude_order_ids={order.id},
    )

    assert order_ids == [second.id]
    assert [e.project_id for e in await _events(db_session, "project.revision_added")] == [second.id]


async def _fan_out_as(db_session, monkeypatch, actor_user_id):
    """record_and_broadcast on a project linked to one order, as ``actor_user_id``
    (the passed ``actor`` is a decoy the lookup must replace); returns
    (order ids written to, the order's events, the broadcast actors)."""
    project = await _project(db_session)
    order = await _order(db_session)
    await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    order_id = order.id
    broadcast_actors = []

    async def capture(payload):
        broadcast_actors.append(payload["actor"])

    monkeypatch.setattr(links.ws_manager, "broadcast_aito", capture)
    order_ids = await links.record_and_broadcast(
        db_session,
        project.id,
        "project.revision_added",
        subject_label="Support R1",
        actor="decoy",
        actor_user_id=actor_user_id,
    )
    assert order_ids == [order_id]
    return await _events(db_session, "project.revision_added"), broadcast_actors


@pytest.mark.asyncio
async def test_record_and_broadcast_names_the_actor_user(db_session, monkeypatch):
    user = User(username="paul")
    db_session.add(user)
    await db_session.commit()

    events, broadcast_actors = await _fan_out_as(db_session, monkeypatch, user.id)

    assert [(e.actor_class, e.actor_name) for e in events] == [("user", "paul")]
    assert broadcast_actors == ["paul"]


@pytest.mark.asyncio
async def test_record_and_broadcast_with_an_unknown_actor_user_still_records_as_system(db_session, monkeypatch):
    events, broadcast_actors = await _fan_out_as(db_session, monkeypatch, 987654)

    assert [(e.actor_class, e.actor_name, e.subject_label) for e in events] == [("system", None, "Support R1")]
    assert broadcast_actors == [None]


# --- file drops ------------------------------------------------------------


_upload = partial(upload, data=threemf_bytes())


@pytest.mark.parametrize(
    "name,section",
    [
        ("a.ply", "scan"),
        ("a.obj", "scan"),
        ("a.e57", "scan"),
        ("a.xyz", "scan"),
        ("a.pts", "scan"),
        ("a.step", "modelisation"),
        ("a.stp", "modelisation"),
        ("a.iges", "modelisation"),
        ("a.igs", "modelisation"),
        ("a.f3d", "modelisation"),
        ("a.stl", "modelisation"),
        ("a.sldprt", "modelisation"),
        ("a.3mf", "impression"),
        ("a.gcode", "impression"),
        ("a.bgcode", "impression"),
        ("a.gcode.3mf", "impression"),
        ("A.GCODE.3MF", "impression"),
        ("a.nc", "usinage"),
        ("a.tap", "usinage"),
        ("a.dxf", "usinage"),
        ("a.pdf", "docs"),
        ("noext", "docs"),
    ],
)
def test_section_for_filename(name, section):
    assert section_for_filename(name) == section


@pytest.mark.parametrize(
    "name,expected",
    [
        ("plate.gcode.3mf", "plate"),
        ("Plate.GCODE.3MF", "Plate"),
        ("scan.ply", "scan"),
        ("a.b.stl", "a.b"),
        ("noext", "noext"),
        (".hidden", ".hidden"),
    ],
)
def test_item_name_for_filename(name, expected):
    assert links.item_name_for_filename(name) == expected


@pytest.mark.asyncio
async def test_drop_files_routes_by_name_to_existing_or_new_items(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    item, _rev = await _revision(db_session, project, section="impression", name="Plate")
    await db_session.commit()

    response = await links.drop_files_on_task(
        db_session, task, [_upload("Plate.3mf"), _upload("bracket.3mf")], user_id=None, actor="Paul"
    )

    # every drop lands in Impression, one source .3mf per revision
    assert {r.section for r in response.results} == {"impression"}
    by_name = {r.filename: r for r in response.results}
    assert by_name["Plate.3mf"].item_id == item.id and by_name["Plate.3mf"].revision_number == 2
    assert by_name["bracket.3mf"].item_id != item.id
    assert by_name["bracket.3mf"].revision_number == 1

    events = await _events(db_session, "project.files_dropped")
    assert len(events) == 1
    assert events[0].project_id == order.id
    assert events[0].detail["project_id"] == project.id
    assert len(events[0].detail["results"]) == 2


@pytest.mark.asyncio
async def test_drop_of_two_files_for_one_item_is_refused_whole(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    with pytest.raises(links.LinkError) as err:
        await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("A.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert (err.value.status_code, err.value.detail) == (
        400,
        "A revision holds one .3mf. Upload each part as its own item.",
    )
    assert await _events(db_session, "project.files_dropped") == []
    assert (await db_session.execute(select(ProjectItem))).first() is None


@pytest.mark.asyncio
async def test_drop_refuses_a_sliced_file_name(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    with pytest.raises(links.LinkError) as err:
        await links.drop_files_on_task(db_session, task, [_upload("a.gcode.3mf")], user_id=None, actor=None)

    assert err.value.status_code == 400 and err.value.detail.startswith("Only Bambu Studio project files")


@pytest.mark.asyncio
async def test_drop_files_requires_a_linked_task(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    with pytest.raises(links.LinkError) as err:
        await links.drop_files_on_task(db_session, task, [_upload("a.stl")], user_id=None, actor=None)
    assert err.value.status_code == 409
    assert await _events(db_session, "project.files_dropped") == []


# --- error and cleanup branches ----------------------------------------------


@pytest.mark.asyncio
async def test_removing_a_delivery_whose_revision_vanished_labels_it_by_id(db_session):
    project = await _project(db_session)
    _item, r1 = await _revision(db_session, project)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await links.set_deliveries(db_session, task, [r1.id], actor="Paul")
    rid = r1.id
    await db_session.execute(delete(ProjectRevision).where(ProjectRevision.id == rid))
    await db_session.flush()

    assert await links.set_deliveries(db_session, task, [], actor="Paul") == []

    assert (await db_session.execute(select(AitoTaskDelivery))).first() is None
    last = (await _events(db_session, "task.deliveries_changed"))[-1]
    assert last.detail == {"added": [], "removed": [f"#{rid}"]}


@pytest.mark.asyncio
async def test_broadcast_failure_is_logged_and_the_rest_still_sent(monkeypatch, caplog):
    sent = []

    async def flaky(payload):
        sent.append(payload["project_id"])
        if payload["project_id"] == 1:
            raise RuntimeError("socket gone")

    monkeypatch.setattr(links.ws_manager, "broadcast_aito", flaky)
    with caplog.at_level(logging.WARNING, logger=links.__name__):
        await links.broadcast_orders_changed([1, 2, 1], "Paul")
    assert sent == [1, 2]  # each order once, the failure does not stop the next
    assert "aito_changed broadcast failed for order 1" in caplog.text


@pytest.mark.asyncio
async def test_drop_without_files_is_400(db_session):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    with pytest.raises(links.LinkError) as err:
        await links.drop_files_on_task(db_session, task, [], user_id=None, actor=None)
    assert (err.value.status_code, err.value.detail) == (400, "No files to drop")
    assert await _events(db_session, "project.files_dropped") == []


@pytest.mark.asyncio
async def test_drop_on_a_link_to_a_deleted_project_is_409(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=987654)
    with pytest.raises(links.LinkError) as err:
        await links.drop_files_on_task(db_session, task, [_upload("a.3mf")], user_id=None, actor=None)
    assert (err.value.status_code, err.value.detail) == (409, "Task is not linked to a project")
    assert await _events(db_session, "project.files_dropped") == []


@pytest.mark.asyncio
async def test_drop_survives_a_failed_revision_fan_out(db_session, monkeypatch, caplog):
    project = await _project(db_session)
    order = await _order(db_session)
    other = await _order(db_session, description="Autre")
    task = await _task(db_session, order, linked_project_id=project.id)
    await _task(db_session, other, linked_project_id=project.id)
    await db_session.commit()
    project_id, order_id = project.id, order.id
    broadcasts = []

    async def failing_record(*_args, **_kwargs):
        raise RuntimeError("events table locked")

    async def record_broadcast(order_ids, _actor):
        broadcasts.append(list(order_ids))

    monkeypatch.setattr(links, "record_on_linked_orders", failing_record)
    monkeypatch.setattr(links, "broadcast_orders_changed", record_broadcast)
    with caplog.at_level(logging.WARNING, logger=links.__name__):
        response = await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert [(r.filename, r.revision_number) for r in response.results] == [("a.3mf", 1), ("b.3mf", 1)]
    assert f"project.revision_added fan-out failed for project {project_id}" in caplog.text
    assert await _events(db_session, "project.revision_added") == []
    [dropped] = await _events(db_session, "project.files_dropped")
    assert dropped.project_id == order_id and len(dropped.detail["results"]) == 2
    assert broadcasts == [[]]  # the failed fan-outs notified no other order
    revisions = (await db_session.execute(select(ProjectRevision.number))).scalars().all()
    assert sorted(revisions) == [1, 1]  # both groups stored despite the failed fan-outs


@pytest.mark.asyncio
async def test_drop_stops_when_the_project_vanishes_mid_drop(db_session, monkeypatch):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    project_id, code, order_id = project.id, project.code, order.id

    async def delete_project(db, *_args, **_kwargs):
        await db.delete(await db.get(Project, project_id))  # deleted by someone else after the first group
        await db.commit()
        return []

    monkeypatch.setattr(links, "_fan_out_revision", delete_project)
    response = await links.drop_files_on_task(
        db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
    )

    # T-286: a partial result, the not-stored group named with the error that stopped the drop
    assert [r.filename for r in response.results] == ["a.3mf"]
    assert [e.model_dump() for e in response.errors] == [
        {"filenames": ["b.3mf"], "status_code": 409, "detail": "Task is not linked to a project"}
    ]
    [dropped] = await _events(db_session, "project.files_dropped")
    assert dropped.project_id == order_id
    assert (dropped.detail["project_id"], dropped.detail["code"]) == (project_id, code)
    assert [r["filename"] for r in dropped.detail["results"]] == ["a.3mf"]


@pytest.mark.asyncio
async def test_drop_still_returns_when_its_own_event_fails(db_session, monkeypatch, caplog):
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    order_id = order.id

    async def failing_record_drop(*_args, **_kwargs):
        raise RuntimeError("events table locked")

    monkeypatch.setattr(links, "_record_drop", failing_record_drop)
    with caplog.at_level(logging.WARNING, logger=links.__name__):
        response = await links.drop_files_on_task(db_session, task, [_upload("a.3mf")], user_id=None, actor="Paul")

    assert [(r.filename, r.revision_number) for r in response.results] == [("a.3mf", 1)]
    assert f"project.files_dropped event failed for order {order_id}" in caplog.text
    assert await _events(db_session, "project.files_dropped") == []
    assert (await db_session.execute(select(ProjectRevision.number))).scalars().all() == [1]


@pytest.mark.asyncio
async def test_drop_failing_on_a_later_group_returns_the_stored_part(db_session, monkeypatch):
    """T-286: a ``ProjectFilesError`` on the second group no longer propagates once a group is stored."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    real = links.project_files.add_revision
    calls = {"n": 0}

    async def second_fails(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise links.project_files.ProjectFilesError(409, "boom")
        return await real(*args, **kwargs)

    monkeypatch.setattr(links.project_files, "add_revision", second_fails)
    response = await links.drop_files_on_task(
        db_session, task, [_upload("a.3mf"), _upload("b.3mf"), _upload("c.3mf")], user_id=None, actor="Paul"
    )

    # T-286: the stored group plus one error naming the failed group and the one after it (never tried)
    assert [(r.filename, r.revision_number) for r in response.results] == [("a.3mf", 1)]
    assert [e.model_dump() for e in response.errors] == [
        {"filenames": ["b.3mf", "c.3mf"], "status_code": 409, "detail": "boom"}
    ]
    assert calls["n"] == 2  # the drop still stops at the failed group
    [dropped] = await _events(db_session, "project.files_dropped")
    assert [r["filename"] for r in dropped.detail["results"]] == ["a.3mf"]
    assert not hasattr(links.project_files.ProjectFilesError, "stored_count")  # set on the instance only


@pytest.mark.asyncio
async def test_drop_failing_on_the_first_group_still_raises_with_nothing_stored(db_session, monkeypatch):
    """T-286: no group stored → the error propagates exactly as before, ``stored_count`` 0, no event."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    async def always_fails(*_args, **_kwargs):
        raise links.project_files.ProjectFilesError(409, "boom")

    monkeypatch.setattr(links.project_files, "add_revision", always_fails)
    with pytest.raises(links.project_files.ProjectFilesError) as err:
        await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert (err.value.status_code, err.value.detail) == (409, "boom")
    assert err.value.stored_count == 0
    assert await _events(db_session, "project.files_dropped") == []


@pytest.mark.asyncio
async def test_drop_with_an_unexpected_error_on_a_later_group_returns_a_fixed_500_entry(
    db_session, monkeypatch, caplog
):
    """T-286: a non-HTTP exception after a stored group is logged and reported without its text."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    order_id = order.id

    real = links.project_files.add_revision
    calls = {"n": 0}

    async def second_fails(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(28, "No space left on device")
        return await real(*args, **kwargs)

    monkeypatch.setattr(links.project_files, "add_revision", second_fails)
    with caplog.at_level(logging.ERROR, logger=links.__name__):
        response = await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert [r.filename for r in response.results] == ["a.3mf"]
    assert [e.model_dump() for e in response.errors] == [
        {"filenames": ["b.3mf"], "status_code": 500, "detail": "unexpected error while storing the files"}
    ]
    assert f"File drop on order {order_id} failed after storing some files" in caplog.text
    assert "No space left on device" in caplog.text  # the traceback is logged, not returned


@pytest.mark.asyncio
async def test_drop_reports_an_http_exception_on_a_later_group_with_its_status(db_session, monkeypatch):
    """T-286: the 413 an oversize upload raises (an HTTPException) keeps its status and detail."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    real = links.project_files.add_revision
    calls = {"n": 0}

    async def second_too_large(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise HTTPException(status_code=413, detail="Upload exceeds the maximum size of 10 bytes")
        return await real(*args, **kwargs)

    monkeypatch.setattr(links.project_files, "add_revision", second_too_large)
    response = await links.drop_files_on_task(
        db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
    )

    assert [e.model_dump() for e in response.errors] == [
        {"filenames": ["b.3mf"], "status_code": 413, "detail": "Upload exceeds the maximum size of 10 bytes"}
    ]


@pytest.mark.asyncio
async def test_drop_cancelled_after_a_stored_group_still_raises_with_the_stored_count(db_session, monkeypatch):
    """T-286: a cancellation is never turned into a response; it carries ``stored_count`` for the route."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    real = links.project_files.add_revision
    calls = {"n": 0}

    async def second_cancelled(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise asyncio.CancelledError
        return await real(*args, **kwargs)

    monkeypatch.setattr(links.project_files, "add_revision", second_cancelled)
    with pytest.raises(asyncio.CancelledError) as err:
        await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert err.value.stored_count == 1
    [dropped] = await _events(db_session, "project.files_dropped")
    assert [r["filename"] for r in dropped.detail["results"]] == ["a.3mf"]


def test_revision_added_payload_label_and_detail_key_order():
    label, detail = links.revision_added_payload(
        item_name="Support", revision_number=3, section="impression", item_id=4, revision_id=11
    )
    assert label == "Support R3"
    assert list(detail.items()) == [("section", "impression"), ("item_id", 4), ("revision_id", 11)]


@pytest.mark.asyncio
async def test_drop_fans_out_the_revision_added_payload(db_session, monkeypatch):
    """A dropped group's fan-out gets section/item_id/revision_id (in order) and ``"<item> R<n>"``."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    project_id, order_id = project.id, order.id
    calls = []

    async def capture(_db, pid, detail, label, *, dropping_order_id, actor):
        calls.append((pid, list(detail.items()), label, dropping_order_id, actor))
        return []

    monkeypatch.setattr(links, "_fan_out_revision", capture)
    await links.drop_files_on_task(db_session, task, [_upload("a.3mf")], user_id=None, actor="Paul")

    item_id, revision_id = (
        await db_session.execute(
            select(ProjectItem.id, ProjectRevision.id).join(ProjectRevision, ProjectRevision.item_id == ProjectItem.id)
        )
    ).one()
    assert calls == [
        (
            project_id,
            [("section", "impression"), ("item_id", item_id), ("revision_id", revision_id)],
            "a R1",
            order_id,
            "Paul",
        )
    ]


@pytest.mark.asyncio
async def test_drop_creates_the_item_first_then_streams_with_no_pending_writes(db_session, monkeypatch):
    """The drop path commits the new item BEFORE streaming (``add_revision`` rolls the whole
    session back on failure); at stream time the item row exists, no revision or file row
    does, and nothing is pending in the session."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()
    real = project_files._stream_files
    seen = {}

    async def spy(folder, uploads):
        seen["new"] = list(db_session.new)
        seen["dirty"] = list(db_session.dirty)
        seen["deleted"] = list(db_session.deleted)
        seen["items"] = (await db_session.execute(select(func.count(ProjectItem.id)))).scalar_one()
        seen["revisions"] = (await db_session.execute(select(func.count(ProjectRevision.id)))).scalar_one()
        seen["files"] = (await db_session.execute(select(func.count(LibraryFile.id)))).scalar_one()
        return await real(folder, uploads)

    monkeypatch.setattr(project_files, "_stream_files", spy)
    response = await links.drop_files_on_task(db_session, task, [_upload("bracket.3mf")], user_id=None, actor="Paul")
    assert seen == {"new": [], "dirty": [], "deleted": [], "items": 1, "revisions": 0, "files": 0}
    assert [r.revision_number for r in response.results] == [1]


@pytest.mark.asyncio
async def test_drop_cancelled_while_recording_still_carries_the_stored_count(db_session, monkeypatch):
    """T-258: a cancellation inside the ``finally`` (recording the drop) also carries ``stored_count`` for the route."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    async def cancelled_record_drop(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(links, "_record_drop", cancelled_record_drop)
    with pytest.raises(asyncio.CancelledError) as err:
        await links.drop_files_on_task(db_session, task, [_upload("a.3mf")], user_id=None, actor="Paul")

    assert err.value.stored_count == 1
    assert (await db_session.execute(select(ProjectRevision.number))).scalars().all() == [1]


@pytest.mark.asyncio
async def test_drop_cancelled_while_recording_nothing_stored_carries_zero(db_session, monkeypatch):
    """T-258: an exception leaving the ``finally`` before any group was stored carries ``stored_count`` 0."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    async def fails(*_args, **_kwargs):
        raise links.project_files.ProjectFilesError(409, "boom")

    async def cancelled_broadcast(*_args, **_kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(links.project_files, "add_revision", fails)
    monkeypatch.setattr(links, "broadcast_orders_changed", cancelled_broadcast)
    with pytest.raises(asyncio.CancelledError) as err:
        await links.drop_files_on_task(db_session, task, [_upload("a.3mf")], user_id=None, actor="Paul")

    assert err.value.stored_count == 0


@pytest.mark.asyncio
async def test_drop_with_a_blank_sanitised_name_raises_before_storing(db_session, monkeypatch):
    """T-259: the blank-name check runs before the store loop, so the valid group ahead of it is never stored."""
    project = await _project(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project.id)
    await db_session.commit()

    async def never(*_args, **_kwargs):
        raise AssertionError("nothing may be stored")

    monkeypatch.setattr(links, "find_or_create_item", never)
    with pytest.raises(links.LinkError) as err:
        await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("dir/???.3mf")], user_id=None, actor="Paul"
        )

    assert (err.value.status_code, err.value.detail) == (400, "Item name must not be blank; refused: ???.3mf")
    assert await _events(db_session, "project.files_dropped") == []


# --- T-326: a failing rollback in the drop's finally ---------------------------


async def _drop_with_two_other_orders(db):
    """A task linked to a project that two other orders also link; returns (task, order id, other order ids)."""
    project = await _project(db)
    order = await _order(db)
    others = [await _order(db, description="Autre A"), await _order(db, description="Autre B")]
    task = await _task(db, order, linked_project_id=project.id)
    for other in others:
        await _task(db, other, linked_project_id=project.id)
    await db.commit()
    return task, order.id, [o.id for o in others]


def _record_drop_and_its_rollback_fail(db, monkeypatch) -> None:
    """``_record_drop`` raises, then the rollback after it raises once too (a broken connection)."""

    async def failing_record_drop(*_args, **_kwargs):
        raise RuntimeError("events table locked")

    real_rollback = db.rollback
    calls = {"n": 0}

    async def rollback():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("connection is closed")
        await real_rollback()

    monkeypatch.setattr(links, "_record_drop", failing_record_drop)
    monkeypatch.setattr(db, "rollback", rollback)


def _capture_broadcasts(monkeypatch, failing: set[int] = frozenset()) -> list[int]:
    sent: list[int] = []

    async def broadcast(payload):
        sent.append(payload["project_id"])
        if payload["project_id"] in failing:
            raise RuntimeError("socket gone")

    monkeypatch.setattr(links.ws_manager, "broadcast_aito", broadcast)
    return sent


@pytest.mark.asyncio
async def test_drop_cancelled_with_a_failing_rollback_keeps_the_cancellation_and_still_broadcasts(
    db_session, monkeypatch, caplog
):
    """T-326: the original in-flight error surfaces (with ``stored_count``), the rollback error is only
    logged, and the other linked orders still get their broadcast."""
    task, order_id, others = await _drop_with_two_other_orders(db_session)
    real = links.project_files.add_revision
    calls = {"n": 0}

    async def second_cancelled(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise asyncio.CancelledError
        return await real(*args, **kwargs)

    monkeypatch.setattr(links.project_files, "add_revision", second_cancelled)
    _record_drop_and_its_rollback_fail(db_session, monkeypatch)
    sent = _capture_broadcasts(monkeypatch)
    with caplog.at_level(logging.WARNING, logger=links.__name__), pytest.raises(asyncio.CancelledError) as err:
        await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert err.value.stored_count == 1
    assert sent == others
    assert f"Rollback after the failed files_dropped event failed for order {order_id}" in caplog.text
    assert "connection is closed" in caplog.text


@pytest.mark.asyncio
async def test_drop_with_a_failing_rollback_after_a_later_group_fails_still_returns_the_stored_part(
    db_session, monkeypatch, caplog
):
    """T-326: a later group's 409 is still reported in ``errors`` (no 500 from the rollback) and the
    other linked orders still get their broadcast."""
    task, order_id, others = await _drop_with_two_other_orders(db_session)
    real = links.project_files.add_revision
    calls = {"n": 0}

    async def second_fails(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise links.project_files.ProjectFilesError(409, "boom")
        return await real(*args, **kwargs)

    monkeypatch.setattr(links.project_files, "add_revision", second_fails)
    _record_drop_and_its_rollback_fail(db_session, monkeypatch)
    sent = _capture_broadcasts(monkeypatch)
    with caplog.at_level(logging.WARNING, logger=links.__name__):
        response = await links.drop_files_on_task(
            db_session, task, [_upload("a.3mf"), _upload("b.3mf")], user_id=None, actor="Paul"
        )

    assert [r.filename for r in response.results] == ["a.3mf"]
    assert [e.model_dump() for e in response.errors] == [{"filenames": ["b.3mf"], "status_code": 409, "detail": "boom"}]
    assert sent == others
    assert f"Rollback after the failed files_dropped event failed for order {order_id}" in caplog.text


@pytest.mark.asyncio
async def test_drop_broadcast_failing_for_one_order_still_reaches_the_others(db_session, monkeypatch, caplog):
    """T-326: one other order's broadcast failing is logged; the next one is still sent."""
    task, _order_id, others = await _drop_with_two_other_orders(db_session)
    sent = _capture_broadcasts(monkeypatch, failing={others[0]})
    with caplog.at_level(logging.WARNING, logger=links.__name__):
        response = await links.drop_files_on_task(db_session, task, [_upload("a.3mf")], user_id=None, actor="Paul")

    assert [r.filename for r in response.results] == ["a.3mf"]
    assert sent == others
    assert f"aito_changed broadcast failed for order {others[0]}" in caplog.text
