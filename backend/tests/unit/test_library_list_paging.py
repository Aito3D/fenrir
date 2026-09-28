"""Server-side sort, search and filters on GET /library/files (File Manager paging)."""

from datetime import datetime

import pytest
from httpx import AsyncClient

from backend.app.models.library import LibraryFile, LibraryFileTag, LibraryTag
from backend.app.models.user import User


@pytest.fixture
async def file_factory(db_session):
    """LibraryFile rows with sensible defaults; kwargs override any column."""
    counter = [0]

    async def _create(**kwargs):
        counter[0] += 1
        n = counter[0]
        row = LibraryFile(
            **{
                "filename": f"part{n}.3mf",
                "file_path": f"library/files/part{n}.3mf",
                "file_type": "3mf",
                "file_size": 100,
                **kwargs,
            }
        )
        db_session.add(row)
        await db_session.commit()
        await db_session.refresh(row)
        return row

    return _create


async def _ids(client: AsyncClient, query: str) -> list[int]:
    response = await client.get(f"/api/v1/library/files?include_root=false{query}")
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()]


class TestSort:
    async def test_no_sort_param_keeps_filename_order(self, async_client, file_factory):
        b = await file_factory(filename="b.3mf", file_metadata={"print_name": "A first"})
        a = await file_factory(filename="a.3mf", file_metadata={"print_name": "Z last"})
        assert await _ids(async_client, "") == [a.id, b.id]

    async def test_sort_name_prefers_print_name_over_filename(self, async_client, file_factory):
        b = await file_factory(filename="b.3mf", file_metadata={"print_name": "A first"})
        a = await file_factory(filename="a.3mf", file_metadata={"print_name": "Z last"})
        c = await file_factory(filename="m.3mf", file_metadata=None)
        assert await _ids(async_client, "&sort=name") == [b.id, c.id, a.id]
        assert await _ids(async_client, "&sort=name&direction=desc") == [a.id, c.id, b.id]

    async def test_sort_name_treats_empty_print_name_as_missing(self, async_client, file_factory):
        # The browser comparator was `print_name || filename`: "" fell back to the filename.
        z = await file_factory(filename="z.3mf", file_metadata={"print_name": ""})
        m = await file_factory(filename="m.3mf", file_metadata={"print_name": ""})
        assert await _ids(async_client, "&sort=name") == [m.id, z.id]

    async def test_sort_name_is_case_insensitive(self, async_client, file_factory):
        upper = await file_factory(filename="Bravo.3mf")
        lower = await file_factory(filename="alpha.3mf")
        assert await _ids(async_client, "&sort=name") == [lower.id, upper.id]

    async def test_sort_date_uses_fs_modified_then_created(self, async_client, file_factory):
        old = await file_factory(created_at=datetime(2024, 1, 1), fs_modified_at=None)
        new = await file_factory(created_at=datetime(2020, 1, 1), fs_modified_at=datetime(2025, 6, 1))
        assert await _ids(async_client, "&sort=date") == [old.id, new.id]
        assert await _ids(async_client, "&sort=date&direction=desc") == [new.id, old.id]

    async def test_sort_size_type_prints(self, async_client, file_factory):
        small = await file_factory(file_size=1, file_type="stl", print_count=5)
        big = await file_factory(file_size=9, file_type="3mf", print_count=0)
        assert await _ids(async_client, "&sort=size") == [small.id, big.id]
        assert await _ids(async_client, "&sort=type") == [big.id, small.id]
        assert await _ids(async_client, "&sort=prints&direction=desc") == [small.id, big.id]

    async def test_pages_never_overlap_or_skip_on_tied_keys(self, async_client, file_factory):
        rows = [await file_factory(file_size=7) for _ in range(5)]
        page1 = await _ids(async_client, "&sort=size&limit=2&offset=0")
        page2 = await _ids(async_client, "&sort=size&limit=2&offset=2")
        page3 = await _ids(async_client, "&sort=size&limit=2&offset=4")
        assert page1 + page2 + page3 == [r.id for r in rows]

    async def test_invalid_sort_is_rejected(self, async_client):
        response = await async_client.get("/api/v1/library/files?sort=colour")
        assert response.status_code == 422

    async def test_default_page_size_is_100(self, async_client, file_factory):
        for _ in range(101):
            await file_factory()
        response = await async_client.get("/api/v1/library/files?include_root=false")
        assert len(response.json()) == 100
        assert response.headers["X-Total-Count"] == "101"


class TestFilters:
    async def test_search_matches_filename_print_name_and_tag(self, async_client, file_factory, db_session):
        by_name = await file_factory(filename="Benchy_boat.3mf")
        by_print = await file_factory(filename="x.3mf", file_metadata={"print_name": "Little BENCHY"})
        tag = LibraryTag(name="benchy-tag", name_key="benchy-tag")
        db_session.add(tag)
        await db_session.commit()
        by_tag = await file_factory(filename="y.3mf")
        db_session.add(LibraryFileTag(file_id=by_tag.id, tag_id=tag.id))
        await db_session.commit()
        await file_factory(filename="cube.3mf")

        assert sorted(await _ids(async_client, "&search=benchy")) == sorted([by_name.id, by_print.id, by_tag.id])

    async def test_search_escapes_like_wildcards(self, async_client, file_factory):
        literal = await file_factory(filename="100%_done.3mf")
        await file_factory(filename="100X_done.3mf")
        await file_factory(filename="100XXdone.3mf")
        assert await _ids(async_client, "&search=100%25_done") == [literal.id]

    async def test_blank_search_is_ignored(self, async_client, file_factory):
        a = await file_factory()
        b = await file_factory()
        assert await _ids(async_client, "&search=%20%20") == [a.id, b.id]

    async def test_file_type_is_exact(self, async_client, file_factory):
        sliced = await file_factory(file_type="gcode.3mf")
        await file_factory(file_type="3mf")
        assert await _ids(async_client, "&file_type=gcode.3mf") == [sliced.id]

    async def test_created_by_is_a_username_substring(self, async_client, file_factory, db_session):
        paul = User(username="paul.theis", password_hash="x", role="user")
        marie = User(username="marie", password_hash="x", role="user")
        db_session.add_all([paul, marie])
        await db_session.commit()
        mine = await file_factory(created_by_id=paul.id)
        await file_factory(created_by_id=marie.id)
        await file_factory(created_by_id=None)
        assert await _ids(async_client, "&created_by=THEIS") == [mine.id]

    async def test_filters_compose_with_folder_scope_and_total(self, async_client, file_factory, db_session):
        from backend.app.models.library import LibraryFolder

        folder = LibraryFolder(name="Clients")
        db_session.add(folder)
        await db_session.commit()
        inside = await file_factory(folder_id=folder.id, filename="clip.stl", file_type="stl")
        await file_factory(folder_id=folder.id, filename="clip.3mf", file_type="3mf")
        await file_factory(folder_id=None, filename="clip.stl", file_type="stl")

        response = await async_client.get(
            f"/api/v1/library/files?folder_id={folder.id}&search=clip&file_type=stl&limit=1"
        )
        assert [row["id"] for row in response.json()] == [inside.id]
        assert response.headers["X-Total-Count"] == "1"

    async def test_filters_compose_with_tag_filter(self, async_client, file_factory, db_session):
        tag = LibraryTag(name="toy", name_key="toy")
        db_session.add(tag)
        await db_session.commit()
        stl = await file_factory(file_type="stl")
        threemf = await file_factory(file_type="3mf")
        db_session.add_all(
            [LibraryFileTag(file_id=stl.id, tag_id=tag.id), LibraryFileTag(file_id=threemf.id, tag_id=tag.id)]
        )
        await db_session.commit()
        assert await _ids(async_client, f"&tag_ids={tag.id}&file_type=stl") == [stl.id]


class TestFileTypes:
    async def test_lists_distinct_sorted_types_for_the_scope(self, async_client, file_factory, db_session):
        from backend.app.models.library import LibraryFolder

        folder = LibraryFolder(name="Clients")
        db_session.add(folder)
        await db_session.commit()
        await file_factory(folder_id=folder.id, file_type="stl")
        await file_factory(folder_id=folder.id, file_type="3mf")
        await file_factory(folder_id=folder.id, file_type="stl")
        await file_factory(folder_id=None, file_type="pdf")

        scoped = await async_client.get(f"/api/v1/library/files/file-types?folder_id={folder.id}")
        assert scoped.status_code == 200
        assert scoped.json() == ["3mf", "stl"]

        everything = await async_client.get("/api/v1/library/files/file-types?include_root=false")
        assert everything.json() == ["3mf", "pdf", "stl"]

    async def test_excludes_trashed_files(self, async_client, file_factory):
        await file_factory(file_type="step", deleted_at=datetime(2025, 1, 1))
        await file_factory(file_type="3mf")
        response = await async_client.get("/api/v1/library/files/file-types?include_root=false")
        assert response.json() == ["3mf"]

    async def test_internal_and_external_are_mutually_exclusive(self, async_client):
        response = await async_client.get("/api/v1/library/files/file-types?internal_only=true&external_only=true")
        assert response.status_code == 400
