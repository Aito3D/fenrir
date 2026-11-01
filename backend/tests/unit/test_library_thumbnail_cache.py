"""Library thumbnails are cacheable per client (#perf).

The Projects and File Manager lists render a thumbnail per row and every
visit refetched all of them: the route sent no ``Cache-Control``. A day of
private caching plus the validators FileResponse already emits turns a
repeat visit's thumbnails into cache hits and 304s.
"""

from __future__ import annotations

import pytest

from backend.app.models.library import LibraryFile

pytestmark = pytest.mark.asyncio

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
async def thumbnailed_file(db_session, tmp_path):
    thumb = tmp_path / "part.png"
    thumb.write_bytes(PNG)
    row = LibraryFile(
        filename="part.3mf",
        file_path="library/files/part.3mf",
        file_type="3mf",
        file_size=100,
        thumbnail_path=str(thumb),
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    return row


async def test_thumbnail_is_privately_cacheable_for_a_day(async_client, thumbnailed_file):
    response = await async_client.get(f"/api/v1/library/files/{thumbnailed_file.id}/thumbnail")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, max-age=86400"
    assert response.headers.get("etag")
    assert response.content == PNG


async def test_thumbnail_revalidates_with_etag(async_client, thumbnailed_file):
    first = await async_client.get(f"/api/v1/library/files/{thumbnailed_file.id}/thumbnail")
    etag = first.headers["etag"]
    second = await async_client.get(
        f"/api/v1/library/files/{thumbnailed_file.id}/thumbnail", headers={"If-None-Match": etag}
    )
    assert second.status_code == 304
    assert second.headers["cache-control"] == "private, max-age=86400"
