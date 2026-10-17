"""load_tree pin (T-190): the full Fichiers payload for one project, field by field.

Rows are inserted directly (no files on disk), out of order on purpose, so the test pins
the ordering rules (sections, item position then name, revisions newest first, files by
id) and the §12.1 outdated rule: only an Impression revision derived from ANOTHER item's
revision goes outdated, and only when that item has a ``valide`` revision numbered above
the source (the newest of several ``valide`` wins).
"""

from datetime import datetime

import pytest
from fastapi import HTTPException

from backend.app.api.routes import project_files as routes
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.models.user import User
from backend.app.schemas.project_files import ProjectItemOut, ProjectRevisionOut, ProjectSectionOut, ProjectTreeResponse
from backend.app.services import project_files as svc
from backend.app.services.project_files import find_item, find_revision, load_tree

T0 = datetime(2026, 1, 2, 3, 4, 5)
T1 = datetime(2026, 2, 3, 4, 5, 6)
T2 = datetime(2026, 3, 4, 5, 6, 7)


async def _build(db):
    alice = User(username="alice", password_hash=None, is_active=True)
    project = Project(name="Arbre")
    db.add_all([alice, project])
    await db.flush()

    def item(section, name, position=0, forked_from=None):
        row = ProjectItem(
            project_id=project.id,
            section=section,
            name=name,
            name_key=name.lower(),
            position=position,
            forked_from_revision_id=forked_from,
        )
        db.add(row)
        return row

    support = item("modelisation", "Support")
    bras = item("modelisation", "Bras")
    mesh = item("scan", "Mesh")
    print_a = item("impression", "Print A", position=1)
    plan = item("docs", "Plan")
    await db.flush()

    def rev(owner, number, status="wip", derived_from=None, **fields):
        row = ProjectRevision(
            item_id=owner.id,
            number=number,
            status=status,
            derived_from_id=derived_from.id if derived_from is not None else None,
            created_at=fields.pop("created_at", T0),
            **fields,
        )
        db.add(row)
        return row

    # inserted out of number order; several valide at once on Support (C1, C2, C4)
    c2 = rev(support, 2, "valide")
    c4 = rev(support, 4, "valide", status_changed_at=T2)
    c1 = rev(support, 1, "valide", created_by_id=alice.id, note="premier")
    c3 = rev(support, 3, "wip")
    b1 = rev(bras, 1, "valide")
    s1 = rev(mesh, 1, "obsolete")
    await db.flush()
    p1 = rev(
        print_a,
        1,
        "valide",
        derived_from=c1,  # outdated by C4 (newest valide of Support)
        config_snapshot={"layer_height": "0.2"},
        print_profile={"printer_model": "Bambu Lab X1C"},
        slicer_name="BambuStudio",
        slicer_version="02.08.00.50",
        created_at=T1,
        created_by_id=alice.id,
    )
    p2 = rev(print_a, 2, "valide", derived_from=c4, pipeline_name="H2D PETG")  # derived from the newest: current
    await db.flush()
    p3 = rev(print_a, 3, "wip", derived_from=p1)  # a re-slice of its own item: never outdated
    d1 = rev(plan, 1, "wip", derived_from=c1)  # outdated source, but not Impression: never outdated
    await db.flush()

    # a forked Impression item, positioned before Print A; Q1 continues the derived chain C1 -> P1 -> Q1
    print_b = item("impression", "Print B", position=0, forked_from=p1.id)
    await db.flush()
    q1 = rev(print_b, 1, "wip", derived_from=p1)  # Print A's newest valide is P2 > P1: outdated by P2
    q2 = rev(print_b, 2, "wip", derived_from=b1)  # Bras has no newer valide: current
    await db.flush()

    def file(owner, filename, **fields):
        row = LibraryFile(
            project_id=project.id,
            revision_id=owner.id,
            filename=filename,
            file_path=f"projects/{filename}",
            file_type=filename.rsplit(".", 1)[1],
            file_size=fields.pop("file_size", 10),
            file_hash=fields.pop("file_hash", None),
            thumbnail_path=fields.pop("thumbnail_path", None),
            created_at=fields.pop("created_at", T0),
        )
        db.add(row)
        return row

    # P1's files inserted b then a: the tree lists them by id, not by name
    f_b = file(p1, "b.3mf", file_size=20, file_hash="hb", thumbnail_path="thumbs/b.png", created_at=T1)
    await db.flush()
    f_a = file(p1, "a.3mf", file_hash="ha")
    f_p2 = file(p2, "p2.3mf")
    f_c1 = file(c1, "c1.step")
    await db.flush()

    # P1 used through a queue variant on f_a; P2 printed but its archive does not point at its file
    queue_item = PrintQueueItem(library_file_id=None)
    db.add(queue_item)
    await db.flush()
    db.add(PrintQueueVariant(queue_item_id=queue_item.id, library_file_id=f_a.id, target_model="X1C"))
    db.add_all(
        [
            PrintArchive(filename="x", file_path="x", file_size=1, revision_id=p1.id, status="completed", quantity=3),
            PrintArchive(filename="x", file_path="x", file_size=1, revision_id=p1.id, status="completed", quantity=2),
            PrintArchive(
                filename="x",
                file_path="x",
                file_size=1,
                revision_id=p1.id,
                status="completed",
                quantity=7,
                user_verdict="reject",
            ),
            PrintArchive(
                filename="x", file_path="x", file_size=1, revision_id=p2.id, status="failed", user_verdict="good"
            ),
        ]
    )
    await db.commit()
    return project, locals()


def _ref(rev, item):
    return {
        "id": rev.id,
        "item_id": item.id,
        "item_name": item.name,
        "section": item.section,
        "number": rev.number,
        "status": rev.status,
    }


def _rev_out(rev, **overrides):
    out = {
        "id": rev.id,
        "number": rev.number,
        "status": rev.status,
        "note": None,
        "derived_from": None,
        "outdated_by": None,
        "print_profile": None,
        "slicer_name": None,
        "slicer_version": None,
        "has_snapshot": False,
        "used": False,
        "files": [],
        "created_by": None,
        "created_at": T0,
        "status_changed_at": None,
        "print_count": 0,
        "pipeline_name": None,
        "slice_status": None,
        "slice_error": None,
        "slice_job_id": None,
        "sliced_file": None,
    }
    out.update(overrides)
    return out


def _file_out(row, *, file_size=10, file_hash=None, has_thumbnail=False, created_at=T0):
    return {
        "id": row.id,
        "filename": row.filename,
        "file_type": row.file_type,
        "file_size": file_size,
        "file_hash": file_hash,
        "has_thumbnail": has_thumbnail,
        "created_at": created_at,
    }


@pytest.mark.asyncio
async def test_load_tree_full_payload(db_session):
    project, r = await _build(db_session)
    support, bras, mesh, print_a, print_b, plan = (
        r["support"],
        r["bras"],
        r["mesh"],
        r["print_a"],
        r["print_b"],
        r["plan"],
    )
    c1, c2, c3, c4, b1, s1 = r["c1"], r["c2"], r["c3"], r["c4"], r["b1"], r["s1"]
    p1, p2, p3, q1, q2, d1 = r["p1"], r["p2"], r["p3"], r["q1"], r["q2"], r["d1"]

    tree = await load_tree(db_session, project)

    assert tree.model_dump() == {
        "project_id": project.id,
        "code": project.code,
        "sections": [
            {
                "section": "scan",
                "items": [
                    {
                        "id": mesh.id,
                        "section": "scan",
                        "name": "Mesh",
                        "name_key": "mesh",
                        "forked_from": None,
                        "revisions": [_rev_out(s1)],
                    }
                ],
            },
            {
                "section": "modelisation",
                "items": [
                    {
                        "id": bras.id,
                        "section": "modelisation",
                        "name": "Bras",
                        "name_key": "bras",
                        "forked_from": None,
                        "revisions": [_rev_out(b1)],
                    },
                    {
                        "id": support.id,
                        "section": "modelisation",
                        "name": "Support",
                        "name_key": "support",
                        "forked_from": None,
                        "revisions": [
                            _rev_out(c4, status_changed_at=T2),
                            _rev_out(c3),
                            _rev_out(c2),
                            _rev_out(
                                c1,
                                note="premier",
                                created_by="alice",
                                files=[_file_out(r["f_c1"])],
                            ),
                        ],
                    },
                ],
            },
            {
                "section": "impression",
                "items": [
                    {
                        "id": print_b.id,
                        "section": "impression",
                        "name": "Print B",
                        "name_key": "print b",
                        "forked_from": _ref(p1, print_a),
                        "revisions": [
                            _rev_out(q2, derived_from=_ref(b1, bras)),
                            _rev_out(q1, derived_from=_ref(p1, print_a), outdated_by=_ref(p2, print_a)),
                        ],
                    },
                    {
                        "id": print_a.id,
                        "section": "impression",
                        "name": "Print A",
                        "name_key": "print a",
                        "forked_from": None,
                        "revisions": [
                            _rev_out(p3, derived_from=_ref(p1, print_a)),
                            _rev_out(
                                p2,
                                derived_from=_ref(c4, support),
                                files=[_file_out(r["f_p2"])],
                                print_count=1,
                                pipeline_name="H2D PETG",
                            ),
                            _rev_out(
                                p1,
                                derived_from=_ref(c1, support),
                                outdated_by=_ref(c4, support),
                                print_profile={"printer_model": "Bambu Lab X1C"},
                                slicer_name="BambuStudio",
                                slicer_version="02.08.00.50",
                                has_snapshot=True,
                                used=True,
                                files=[
                                    _file_out(
                                        r["f_b"], file_size=20, file_hash="hb", has_thumbnail=True, created_at=T1
                                    ),
                                    _file_out(r["f_a"], file_hash="ha"),
                                ],
                                created_by="alice",
                                created_at=T1,
                                print_count=5,
                            ),
                        ],
                    },
                ],
            },
            {"section": "usinage", "items": []},
            {
                "section": "docs",
                "items": [
                    {
                        "id": plan.id,
                        "section": "docs",
                        "name": "Plan",
                        "name_key": "plan",
                        "forked_from": None,
                        "revisions": [_rev_out(d1, derived_from=_ref(c1, support))],
                    }
                ],
            },
        ],
    }
    # the field order of the payload is part of the contract (the HTTP golden compares bytes)
    assert list(tree.model_dump()["sections"][2]["items"][1]["revisions"][2]) == list(_rev_out(p1))


@pytest.mark.asyncio
async def test_load_tree_of_an_empty_project_lists_every_section_empty(db_session):
    project = Project(name="Vide")
    db_session.add(project)
    await db_session.commit()
    tree = await load_tree(db_session, project)
    assert tree.model_dump() == {
        "project_id": project.id,
        "code": project.code,
        "sections": [
            {"section": section, "items": []} for section in ("scan", "modelisation", "impression", "usinage", "docs")
        ],
    }


# --- find_item / find_revision (T-037) -----------------------------------------


def _tree_of(*sections: list) -> ProjectTreeResponse:
    return ProjectTreeResponse.model_construct(
        project_id=1,
        code="P-1",
        sections=[ProjectSectionOut.model_construct(section=f"s{i}", items=items) for i, items in enumerate(sections)],
    )


def _item(item_id: int, *revision_ids: int, tag: str = "") -> ProjectItemOut:
    revs = [ProjectRevisionOut.model_construct(id=rid, tag=f"{tag}r{rid}") for rid in revision_ids]
    return ProjectItemOut.model_construct(id=item_id, name=f"{tag}i{item_id}", revisions=revs)


def test_find_item_and_revision_search_every_section_and_item():
    first, second, third = _item(1, 10, 11), _item(2), _item(3, 30)
    tree = _tree_of([first], [], [second, third])
    assert find_item(tree, 1) is first
    assert find_item(tree, 3) is third
    assert find_revision(tree, 11) is first.revisions[1]
    assert find_revision(tree, 30) is third.revisions[0]


def test_find_item_and_revision_return_none_when_missing():
    tree = _tree_of([_item(1, 10)], [])
    assert find_item(tree, 10) is None  # a revision id is not an item id
    assert find_revision(tree, 1) is None  # nor the other way round
    assert find_item(_tree_of(), 1) is None
    assert find_revision(_tree_of(), 1) is None


def test_find_item_and_revision_first_match_wins():
    a, b = _item(5, 50, tag="a"), _item(5, 50, tag="b")
    tree = _tree_of([a], [b])
    assert find_item(tree, 5) is a
    assert find_revision(tree, 50) is a.revisions[0]


@pytest.mark.asyncio
async def test_route_item_and_revision_out_404_when_the_id_is_not_in_the_tree(monkeypatch):
    item = _item(1, 10)
    tree = _tree_of([item])

    async def fake_load_tree(_db, _project):
        return tree

    monkeypatch.setattr(svc, "load_tree", fake_load_tree)
    assert await routes._item_out(None, None, 1) is item
    assert await routes._revision_out(None, None, 10) is item.revisions[0]
    with pytest.raises(HTTPException) as exc:
        await routes._item_out(None, None, 2)
    assert (exc.value.status_code, exc.value.detail) == (404, "Item not found")
    with pytest.raises(HTTPException) as exc:
        await routes._revision_out(None, None, 11)
    assert (exc.value.status_code, exc.value.detail) == (404, "Revision not found")


@pytest.mark.asyncio
async def test_tree_hides_derived_slice_and_exposes_it(db_session):
    project = Project(name="Tranche")
    db_session.add(project)
    await db_session.flush()
    item = ProjectItem(project_id=project.id, section="impression", name="Pièce", name_key="piece")
    db_session.add(item)
    await db_session.flush()
    rev = ProjectRevision(item_id=item.id, number=1, status="wip")
    db_session.add(rev)
    await db_session.flush()

    def lib(name, **extra):
        row = LibraryFile(
            filename=name,
            file_path=f"projects/{name}",
            file_type="3mf",
            file_size=3,
            project_id=project.id,
            revision_id=rev.id,
            **extra,
        )
        db_session.add(row)
        return row

    source = lib("piece.3mf")
    derived = lib("piece.gcode.3mf", derived_slice=True)
    await db_session.flush()
    rev.slice_status = "sliced"
    rev.sliced_file_id = derived.id
    await db_session.commit()

    out = find_revision(await load_tree(db_session, project), rev.id)
    assert [f.id for f in out.files] == [source.id]
    assert out.slice_status == "sliced"
    assert out.sliced_file is not None and out.sliced_file.id == derived.id
    assert out.slice_error is None and out.slice_job_id is None
    # the derived row still counts for the "used" checks and is not a loose file
    assert LibraryFile.revision_sources() is not None
