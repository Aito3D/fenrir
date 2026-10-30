"""Project files service: streaming uploads, copies, thumbnails and the stale-part sweep (split from test_project_files_service.py)."""

import asyncio
import io
import zipfile
from pathlib import Path

import pytest
from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem, PrintQueueVariant
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_storage
from backend.app.services.project_files import (
    ProjectFilesError,
    add_revision,
    create_item,
    delete_item,
    delete_revision,
    fork_revision,
    load_tree,
    remove_file_from_revision,
    rename_item,
    revision_is_used,
    update_revision,
)
from backend.tests.project_fixtures import (
    legacy_uploads_fixture,
    make_project as _project,
    projects_root_fixture,
    threemf_bytes,
    upload,
)
from backend.tests.unit.project_files_service_helpers import (
    _commit_raises_integrity,
    _fork_source_with_thumbnail,
    _rev,
    _revision_rows,
)

root = projects_root_fixture()
legacy_uploads = legacy_uploads_fixture(autouse=True)


@pytest.mark.asyncio
async def test_commit_failure_leaves_no_files_thumbnails_or_rows(db_session, root, monkeypatch, tmp_path):
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    project = await _project(db_session)
    item = await create_item(db_session, project, section="impression", name="Support", user_id=None)
    storage_dir, item_id = project.storage_dir, item.id
    await db_session.commit()

    real_commit = db_session.commit
    calls = {"n": 0}

    async def failing_commit():
        calls["n"] += 1
        if calls["n"] == 1:
            assert list(thumbs.iterdir()), "the call should have written a thumbnail before the commit"
            raise OSError("commit failed")
        return await real_commit()

    monkeypatch.setattr(db_session, "commit", failing_commit)
    # a 3MF with a real thumbnail so the thumbnails dir gets a file
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "X"}')
        zf.writestr("3D/3dmodel.model", "<model></model>")
        zf.writestr("Metadata/plate_1.png", b"\x89PNG fake")
    with pytest.raises(OSError):
        await add_revision(
            db_session,
            project,
            item,
            [upload("plate.3mf", buffer.getvalue())],
            note=None,
            derived_from_id=None,
            user_id=None,
        )
    folder = root / storage_dir / "Impression" / "Support" / "R1"
    assert not folder.exists() or list(folder.iterdir()) == []
    assert list(thumbs.iterdir()) == []
    assert (await db_session.execute(select(ProjectRevision))).scalars().all() == []
    assert (
        await db_session.execute(select(ProjectItem.last_revision_number).where(ProjectItem.id == item_id))
    ).scalar_one() == 0

    item = (await db_session.execute(select(ProjectItem).where(ProjectItem.id == item_id))).scalar_one()
    project = (await db_session.execute(select(Project).where(Project.id == item.project_id))).scalar_one()
    rev, _ = await add_revision(
        db_session,
        project,
        item,
        [upload("plate.3mf", threemf_bytes())],
        note=" n ",
        derived_from_id=None,
        user_id=None,
    )
    assert (rev.number, rev.note) == (1, "n")
    names = [p.name for p in (root / storage_dir / "Impression" / "Support" / "R1").iterdir()]
    assert names == ["plate.3mf"]


@pytest.mark.asyncio
async def test_fork_gives_the_copy_its_own_thumbnail(db_session, root, monkeypatch, tmp_path):
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"printer_model": "X"}')
        zf.writestr("3D/3dmodel.model", "<model></model>")
        zf.writestr("Metadata/plate_1.png", b"\x89PNG fake")
    project = await _project(db_session)
    item, rev = await _rev(db_session, project, section="impression", files=[upload("plate.3mf", buffer.getvalue())])
    [source] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == rev.id))).scalars().all()
    source_thumb = source.thumbnail_path
    assert source_thumb, "the 3MF upload should have produced a thumbnail"

    forked = await fork_revision(db_session, project, item, rev, "Support B", user_id=None)

    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    [copy] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == r1.id))).scalars().all()
    assert copy.thumbnail_path and copy.thumbnail_path != source_thumb
    thumb_files = sorted(thumbs.iterdir())
    assert len(thumb_files) == 2  # the source keeps its own; the copy has a separate file
    assert all(p.read_bytes() == thumb_files[0].read_bytes() for p in thumb_files)


def test_remove_empty_keeps_non_empty_folders(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    full = tmp_path / "full"
    full.mkdir()
    (full / "keep.txt").write_bytes(b"x")
    project_files._remove_empty(full, empty, tmp_path / "missing")
    assert not empty.exists()
    assert (full / "keep.txt").read_bytes() == b"x"


def test_copy_hashing_survives_a_copystat_failure(tmp_path, monkeypatch):
    import hashlib

    src = tmp_path / "src.bin"
    src.write_bytes(b"payload")
    dest = project_storage.claim_unique_file_path(tmp_path, "dest.bin")

    def refuse(*_args, **_kwargs):
        raise OSError("no timestamps here")

    monkeypatch.setattr(project_files, "_copystat", refuse)
    assert project_files._copy_hashing(src, dest) == (7, hashlib.sha256(b"payload").hexdigest())
    assert dest.read_bytes() == b"payload"


@pytest.mark.asyncio
async def test_stream_files_removes_the_claimed_name_when_the_rename_fails(tmp_path, monkeypatch):
    folder = tmp_path / "R1"
    folder.mkdir()

    def refuse(*_args, **_kwargs):
        raise OSError("rename refused")

    monkeypatch.setattr(project_files, "_replace", refuse)
    with pytest.raises(OSError, match="rename refused"):
        await project_files._stream_files(folder, [upload("a.step", b"geo")])
    assert list(folder.iterdir()) == []  # neither the claimed placeholder nor the .part survives


@pytest.mark.asyncio
async def test_stream_files_keeps_the_rename_error_when_removing_the_claimed_name_fails(tmp_path, monkeypatch, caplog):
    folder = tmp_path / "R1"
    folder.mkdir()
    real_unlink = project_files._unlink

    def refuse_replace(*_args, **_kwargs):
        raise ValueError("rename refused")

    def unlink(path, **kwargs):
        if path.name == "a.step":
            raise OSError("claimed name busy")
        return real_unlink(path, **kwargs)

    monkeypatch.setattr(project_files, "_replace", refuse_replace)
    monkeypatch.setattr(project_files, "_unlink", unlink)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(ValueError, match="rename refused"):
        await project_files._stream_files(folder, [upload("a.step", b"geo")])
    assert any("Could not remove" in r.getMessage() and "a.step" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_stream_files_keeps_the_upload_error_and_cleans_earlier_files_when_the_part_cannot_go(
    tmp_path, monkeypatch, caplog
):
    folder = tmp_path / "R1"
    folder.mkdir()
    real_stream = project_files._stream_upload_to_path
    real_unlink = project_files._unlink
    calls = 0

    async def stream(upload_file, part, limit):
        nonlocal calls
        calls += 1
        if calls == 2:
            part.write_bytes(b"half")
            raise RuntimeError("upload broke")
        return await real_stream(upload_file, part, limit)

    def unlink(path, **kwargs):
        if path.name.endswith(".part"):
            raise OSError("part busy")
        return real_unlink(path, **kwargs)

    monkeypatch.setattr(project_files, "_stream_upload_to_path", stream)
    monkeypatch.setattr(project_files, "_unlink", unlink)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    with pytest.raises(RuntimeError, match="upload broke"):
        await project_files._stream_files(folder, [upload("a.step", b"one"), upload("b.step", b"two")])
    assert not (folder / "a.step").exists()  # the earlier file was still cleaned up
    assert any("Could not remove" in r.getMessage() and ".part" in r.getMessage() for r in caplog.records)


_STALE_PART = ".0123456789abcdef0123456789abcdef.part"


def _aged(path, seconds):
    import os
    import time

    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp), follow_symlinks=False)


def test_sweep_removes_a_stale_part_and_keeps_everything_else(tmp_path):
    day = project_files.PART_GRACE_SECONDS
    stale = tmp_path / _STALE_PART
    stale.write_bytes(b"half")
    _aged(stale, day + 60)
    fresh = tmp_path / ".fedcba9876543210fedcba9876543210.part"
    fresh.write_bytes(b"in flight")
    _aged(fresh, day - 3600)
    user_file = tmp_path / ".notes.part"  # not a uuid name: could be an upload's own filename
    user_file.write_bytes(b"mine")
    _aged(user_file, day * 5)
    real = tmp_path / "plate.3mf"
    real.write_bytes(b"3mf")
    _aged(real, day * 5)
    link = tmp_path / ".aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.part"
    link.symlink_to(real)
    _aged(link, day * 5)
    folder_like = tmp_path / ".bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.part"
    folder_like.mkdir()
    _aged(folder_like, day * 5)

    project_files._sweep_stale_parts(tmp_path)

    assert not stale.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        [fresh.name, user_file.name, real.name, link.name, folder_like.name]
    )
    assert real.read_bytes() == b"3mf"


def test_sweep_logs_and_ignores_an_unlink_failure(tmp_path, monkeypatch, caplog):
    stale = tmp_path / _STALE_PART
    stale.write_bytes(b"half")
    _aged(stale, project_files.PART_GRACE_SECONDS + 60)

    def refuse(_path, **_kwargs):
        raise PermissionError("read-only folder")

    monkeypatch.setattr(project_files, "_unlink", refuse)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    project_files._sweep_stale_parts(tmp_path)  # must not raise
    assert stale.exists()
    assert any("Could not remove" in r.getMessage() and r.exc_info for r in caplog.records)


def test_sweep_logs_and_ignores_an_unreadable_folder(tmp_path, caplog):
    caplog.set_level("WARNING", logger=project_files.logger.name)
    project_files._sweep_stale_parts(tmp_path / "missing")
    assert any("stale upload parts" in r.getMessage() and r.exc_info for r in caplog.records)


def test_sweep_logs_and_skips_a_part_it_cannot_inspect(tmp_path, monkeypatch, caplog):
    part = tmp_path / _STALE_PART
    part.write_bytes(b"half")
    _aged(part, project_files.PART_GRACE_SECONDS + 60)

    def refuse(self):
        raise OSError("stat refused")

    monkeypatch.setattr(project_files.Path, "is_file", refuse)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    project_files._sweep_stale_parts(tmp_path)
    monkeypatch.undo()
    assert part.exists()
    assert any("Could not inspect" in r.getMessage() and r.exc_info for r in caplog.records)


@pytest.mark.asyncio
async def test_stream_files_sweeps_stale_parts_before_streaming(tmp_path):
    folder = tmp_path / "R1"
    folder.mkdir()
    stale = folder / _STALE_PART
    stale.write_bytes(b"left by a dead process")
    _aged(stale, project_files.PART_GRACE_SECONDS + 60)
    fresh = folder / ".fedcba9876543210fedcba9876543210.part"
    fresh.write_bytes(b"another upload, still running")

    written = await project_files._stream_files(folder, [upload("a.step", b"geo")])

    assert [w.path.name for w in written] == ["a.step"]
    assert not stale.exists()
    assert fresh.read_bytes() == b"another upload, still running"


@pytest.mark.asyncio
async def test_thumbnail_failure_never_fails_the_upload(tmp_path, monkeypatch):
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: tmp_path)

    def explode(_path):
        raise RuntimeError("bad gcode")

    monkeypatch.setattr(project_files, "extract_gcode_thumbnail", explode)
    gcode = tmp_path / "part.gcode"
    gcode.write_bytes(b"G1 X1")
    assert await project_files._make_thumbnail(gcode) == (None, None)


def test_cleanup_written_carries_on_past_a_file_that_cannot_be_removed(tmp_path, monkeypatch, caplog):
    first, second, thumb = tmp_path / "a.step", tmp_path / "b.step", tmp_path / "b.png"
    for path in (first, second, thumb):
        path.write_bytes(b"x")
    real_unlink = project_files._unlink

    def unlink(path, **kwargs):
        if path == first:
            raise OSError("busy")
        return real_unlink(path, **kwargs)

    monkeypatch.setattr(project_files, "_unlink", unlink)
    caplog.set_level("WARNING", logger=project_files.logger.name)
    project_files._cleanup_written(
        [
            project_files._WrittenFile(path=first, size=1, digest=""),
            project_files._WrittenFile(path=second, size=1, digest="", thumbnail_abs=thumb),
        ]
    )
    assert first.exists() and not second.exists() and not thumb.exists()
    assert any(str(first) in r.getMessage() and r.exc_info for r in caplog.records)


@pytest.mark.asyncio
async def test_fork_integrity_error_removes_copied_thumbnail_and_keeps_the_source(
    db_session, root, monkeypatch, tmp_path
):
    project, item, rev, thumbs, section_dir = await _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path)
    item_id = item.id
    _commit_raises_integrity(db_session, monkeypatch, "UNIQUE constraint failed: project_items.name_key")
    with pytest.raises(ProjectFilesError) as caught:
        await fork_revision(db_session, project, item, rev, "Support B", user_id=None)
    assert caught.value.status_code == 409
    assert not (section_dir / "Support B").exists()
    assert len(list(thumbs.iterdir())) == 1  # only the source's thumbnail remains
    assert (section_dir / "Support" / "R1" / "plate.3mf").exists()
    assert (await db_session.execute(select(ProjectItem).where(ProjectItem.name == "Support B"))).first() is None
    assert (await db_session.execute(select(ProjectItem.id).where(ProjectItem.id == item_id))).scalar_one() == item_id
    assert (await _revision_rows(db_session, item_id))[1] == 1  # the source revision keeps its one file row


@pytest.mark.asyncio
async def test_fork_does_not_copy_a_thumbnail_swapped_for_a_symlink(db_session, root, monkeypatch, tmp_path):
    project, item, rev, thumbs, section_dir = await _fork_source_with_thumbnail(db_session, monkeypatch, tmp_path)
    [thumb] = list(thumbs.iterdir())
    secret = tmp_path / ".jwt_secret"
    secret.write_bytes(b"top-secret")
    thumb.unlink()
    thumb.symlink_to(secret)
    forked = await fork_revision(db_session, project, item, rev, "Support B", user_id=None)
    r1 = (await db_session.execute(select(ProjectRevision).where(ProjectRevision.item_id == forked.id))).scalar_one()
    [copy] = (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == r1.id))).scalars().all()
    assert copy.filename == "plate.3mf" and copy.thumbnail_path is None
    assert list(thumbs.iterdir()) == [thumb]  # no copy of the secret landed among the thumbnails
    assert (section_dir / "Support B" / "R1" / "plate.3mf").is_file()


def test_revision_file_path_refuses_a_path_that_reaches_the_tree_through_an_outside_symlink(root, tmp_path_factory):
    real = root / "P-0001_x" / "Modélisation" / "Support" / "R1"
    real.mkdir(parents=True)
    (real / "a.step").write_bytes(b"geo")
    detour = tmp_path_factory.mktemp("outside") / "detour"
    detour.symlink_to(real, target_is_directory=True)
    assert project_files.revision_file_path(str(real / "a.step")) == (real / "a.step").resolve()
    assert project_files.revision_file_path(str(detour / "a.step")) is None
    assert project_files.revision_file_path(None) is None
    assert project_files.revision_file_path("") is None


def test_revision_file_path_walks_past_a_prefix_that_escapes_the_data_dir(monkeypatch, tmp_path):
    """A stored relative path that climbs out of the data dir and back in still resolves:
    the prefix ``..`` alone escapes (``to_absolute_path`` raises), so the walk moves on."""
    from backend.app.core.config import settings as app_settings

    base = tmp_path / "data"
    projects = base / "projects"
    folder = projects / "P-0001_x" / "R1"
    folder.mkdir(parents=True)
    (folder / "a.step").write_bytes(b"geo")
    monkeypatch.setattr(app_settings, "base_dir", base)
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    stored = "../data/projects/P-0001_x/R1/a.step"
    assert project_files.revision_file_path(stored) == (folder / "a.step").resolve()


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        (None, ""),
        ("", ""),
        ("C:\\Users\\shop\\Support.3mf", "Support.3mf"),
        ("plates/v2/Support.gcode", "Support.gcode"),
        ("mixed\\dir/Support.bgcode", "Support.bgcode"),
        ("Support.3mf", "Support.3mf"),
    ],
)
def test_upload_basename_strips_client_folders(filename, expected):
    assert project_files.upload_basename(UploadFile(file=io.BytesIO(b""), filename=filename)) == expected


@pytest.mark.asyncio
async def test_gcode_embedded_thumbnail_is_written(tmp_path, monkeypatch):
    import base64

    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: tmp_path)
    picture = b"\x89PNG\r\n\x1a\nfake-thumbnail"
    gcode = tmp_path / "part.gcode"
    encoded = base64.b64encode(picture).decode()
    gcode.write_text(f"; thumbnail begin 300x300 {len(encoded)}\n; {encoded}\n; thumbnail end\nG1 X1\n")

    thumb, metadata = await project_files._make_thumbnail(gcode)
    assert metadata is None
    assert thumb is not None and thumb.parent == tmp_path and thumb.suffix == ".png"
    assert thumb.read_bytes() == picture


@pytest.mark.asyncio
async def test_image_upload_gets_a_png_thumbnail(tmp_path, monkeypatch):
    from PIL import Image

    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    photo = tmp_path / "photo.JPG"
    Image.new("RGB", (512, 128), (200, 10, 10)).save(photo, "JPEG")

    thumb, metadata = await project_files._make_thumbnail(photo)
    assert metadata is None
    assert thumb is not None and thumb.parent == thumbs
    with Image.open(thumb) as made:
        assert (made.format, made.size) == ("PNG", (256, 64))


@pytest.mark.asyncio
async def test_stl_thumbnail_only_renders_a_usable_mesh(tmp_path, monkeypatch):
    thumbs = tmp_path / "thumbs"
    thumbs.mkdir()
    monkeypatch.setattr(project_files, "get_library_thumbnails_dir", lambda: thumbs)
    rendered: list[tuple[Path, Path]] = []

    def fake_render(stl_path, thumbnails_dir):
        rendered.append((stl_path, thumbnails_dir))
        out = thumbnails_dir / "mesh.png"
        out.write_bytes(b"png")
        return str(out)

    monkeypatch.setattr(project_files, "generate_stl_thumbnail", fake_render)
    tiny = tmp_path / "tiny.stl"
    tiny.write_bytes(b"x" * (project_files.MIN_USABLE_STL_BYTES - 1))
    assert await project_files._make_thumbnail(tiny) == (None, None)
    assert rendered == []

    mesh = tmp_path / "mesh.STL"
    mesh.write_bytes(b"x" * project_files.MIN_USABLE_STL_BYTES)
    assert await project_files._make_thumbnail(mesh) == (thumbs / "mesh.png", None)
    assert rendered == [(mesh, thumbs)]


def _planted_src(tmp_path):
    import os

    src = tmp_path / "src.bin"
    src.write_bytes(b"x" * 3_000_000 + b"tail")
    os.chmod(src, 0o640)
    os.utime(src, (1_600_000_000, 1_600_000_123))
    return src


def test_copy_claimed_matches_shutil_copy2(tmp_path):
    import shutil

    src = _planted_src(tmp_path)
    reference = tmp_path / "ref.bin"
    shutil.copy2(src, reference)
    dest = project_storage.claim_unique_file_path(tmp_path, "dest.bin")
    project_files._copy_claimed(src, dest)
    assert dest.read_bytes() == reference.read_bytes()
    assert dest.stat().st_mtime == reference.stat().st_mtime == 1_600_000_123
    assert dest.stat().st_mode == reference.stat().st_mode


def test_copy_hashing_matches_shutil_copy2_and_digest(tmp_path):
    import hashlib
    import shutil

    src = _planted_src(tmp_path)
    reference = tmp_path / "ref.bin"
    shutil.copy2(src, reference)
    dest = project_storage.claim_unique_file_path(tmp_path, "dest.bin")
    size, digest = project_files._copy_hashing(src, dest)
    assert (size, digest) == (src.stat().st_size, hashlib.sha256(src.read_bytes()).hexdigest())
    assert dest.read_bytes() == reference.read_bytes()
    assert dest.stat().st_mtime == reference.stat().st_mtime
    assert dest.stat().st_mode == reference.stat().st_mode


def test_copy_hashing_nofollow_refuses_a_symlinked_source_but_follows_by_default(tmp_path):
    """T-255: an external source is opened without following a symlink leaf."""
    real = tmp_path / "real.bin"
    real.write_bytes(b"payload")
    link = tmp_path / "link.bin"
    link.symlink_to(real)
    dest = project_storage.claim_unique_file_path(tmp_path, "dest.bin")
    with pytest.raises(OSError):
        project_files._copy_hashing(link, dest, nofollow=True)
    assert project_files._copy_hashing(link, dest)[0] == len(b"payload")  # default: follows, as before
    assert dest.read_bytes() == b"payload"
    other = project_storage.claim_unique_file_path(tmp_path, "other.bin")
    assert project_files._copy_hashing(real, other, nofollow=True)[0] == len(b"payload")


@pytest.mark.parametrize("copier", ["_copy_claimed", "_copy_hashing"])
def test_copy_into_a_symlink_planted_after_the_claim_is_refused(tmp_path, copier):
    src = _planted_src(tmp_path)
    victim = tmp_path / "victim.txt"
    victim.write_bytes(b"untouched")
    dest = project_storage.claim_unique_file_path(tmp_path, "dest.bin")
    dest.unlink()
    dest.symlink_to(victim)  # swapped in between the claim and the reopen
    with pytest.raises(OSError):
        getattr(project_files, copier)(src, dest)
    assert victim.read_bytes() == b"untouched"


def test_open_claimed_closes_the_descriptor_when_fdopen_fails(tmp_path, monkeypatch):
    import errno
    import os

    dest = project_storage.claim_unique_file_path(tmp_path, "dest.bin")
    opened: list[int] = []
    real_open = project_files._os_open

    def recording_open(*args, **kwargs):
        fd = real_open(*args, **kwargs)
        opened.append(fd)
        return fd

    def boom(_fd, *_args, **_kwargs):
        raise RuntimeError("fdopen failed")

    monkeypatch.setattr(project_files, "_os_open", recording_open)
    monkeypatch.setattr(project_files.os, "fdopen", boom)
    with pytest.raises(RuntimeError, match="fdopen failed"):
        project_files._open_claimed(dest)
    assert len(opened) == 1
    with pytest.raises(OSError) as closed:
        os.fstat(opened[0])
    assert closed.value.errno == errno.EBADF
