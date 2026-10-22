"""T-425: a revision file swapped for a symlink that leaves ``base_dir`` reads as refused, never as a 500.

``revision_file_path`` used to let ``to_absolute_path``'s ``ValueError`` escape for a stored relative path
whose link resolves outside the data dir. It now returns ``None`` like every other refusal, so download, zip,
the slicer link and the queue/scheduler paths treat the file as missing or refused.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import project_files, project_slice
from backend.tests.integration.test_project_slice import roots  # noqa: F401  # fixture
from backend.tests.integration.test_project_slice_queue import _item, _upload


@pytest.fixture
def outside_secret(tmp_path_factory):
    """A file outside ``base_dir`` (the test's ``tmp_path``), standing in for ``.jwt_secret``."""
    secret = tmp_path_factory.mktemp("outside") / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    return secret


async def _escaped_revision(client: AsyncClient, db_session, roots, outside_secret):  # noqa: F811
    rev = await _upload(client)
    source = await db_session.get(LibraryFile, rev["files"][0]["id"])
    assert not source.file_path.startswith("/")  # stored relative to base_dir: the case that used to raise
    path = roots / source.file_path
    path.unlink()
    path.symlink_to(outside_secret)
    return rev, source


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_file_path_is_none_for_a_link_leaving_base_dir(
    async_client: AsyncClient,
    db_session,
    roots,
    outside_secret,  # noqa: F811
):
    _rev, source = await _escaped_revision(async_client, db_session, roots, outside_secret)
    assert project_files.revision_file_path(source.file_path) is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_download_zip_and_slicer_link_answer_404_not_500(
    async_client: AsyncClient,
    db_session,
    roots,
    outside_secret,  # noqa: F811
):
    rev, source = await _escaped_revision(async_client, db_session, roots, outside_secret)
    url = f"/api/v1/projects/revisions/{rev['id']}/download"

    one = await async_client.get(url, params={"file_id": source.id})
    assert one.status_code == 404 and one.json()["detail"] == "File not found"
    zipped = await async_client.get(url)
    assert zipped.status_code == 404 and zipped.json()["detail"] == "No file available on disk"

    token = (await async_client.post(f"/api/v1/library/files/{source.id}/slicer-token")).json()["token"]
    slicer = await async_client.get(f"/api/v1/library/files/{source.id}/dl/{token}/{source.filename}")
    assert slicer.status_code == 404 and slicer.json() == {"detail": "File not found"}
    for tail in ("download", "gcode"):
        other = await async_client.get(f"/api/v1/library/files/{source.id}/{tail}")
        assert other.status_code == 404 and other.json() == {"detail": "File not found"}, tail
    assert b"top-secret" not in slicer.content + zipped.content + one.content


@pytest.mark.asyncio
@pytest.mark.integration
async def test_slice_start_answers_no_source_not_500(
    async_client: AsyncClient,
    db_session,
    roots,
    outside_secret,  # noqa: F811
):
    rev, _source = await _escaped_revision(async_client, db_session, roots, outside_secret)
    response = await async_client.post(f"/api/v1/projects/revisions/{rev['id']}/slice")
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "This revision has no source .3mf to slice"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queueing_the_link_is_refused_with_400(
    async_client: AsyncClient,
    db_session,
    roots,
    outside_secret,  # noqa: F811
):
    _rev, source = await _escaped_revision(async_client, db_session, roots, outside_secret)
    response = await async_client.post("/api/v1/queue/", json={"library_file_id": source.id})
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == "This .3mf holds no Bambu Studio project to slice, so it cannot be printed."


@pytest.mark.asyncio
@pytest.mark.integration
async def test_dispatch_guard_lets_a_link_through_instead_of_raising(
    async_client: AsyncClient,
    db_session,
    roots,
    outside_secret,
    printer_factory,  # noqa: F811
):
    """``hold_unsliced_dispatch`` (first step of the scheduler's ``_start_print``) used to raise ValueError
    for an item already queued on a file that was swapped for a link leaving base_dir; it now answers
    ``False`` (not a project source) and the dispatch path's own file checks decide."""
    _rev, source = await _escaped_revision(async_client, db_session, roots, outside_secret)
    source_id = source.id
    printer = await printer_factory()
    item = PrintQueueItem(printer_id=printer.id, library_file_id=source_id, status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    loaded = await _item(db_session, item.id)

    held = await project_slice.hold_unsliced_dispatch(db_session, loaded, await db_session.get(LibraryFile, source_id))

    assert held is False
    assert (await _item(db_session, loaded.id)).status == "pending"
