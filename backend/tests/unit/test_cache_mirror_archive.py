"""Prints the H2 keeps on eMMC are still archived from the card's /cache mirror.

Measured on the shop's fleet (2026-10-03, firmware 01.02.00.00): with a card in
and "Store sent files on external storage" on, an H2 keeps a rolling copy of
its last eight sliced files under ``/cache/<name>``, whatever the dispatch URL
says. #2856 already probes for that copy on a ``brtc://emmc/<name>`` dispatch.
Three gaps were left, each with archives to show for it:

- A touchscreen reprint reports ``file:///userdata/project_file.gcode.3mf``.
  The probe asked for ``project_file.gcode.3mf``, while the very file sat in
  ``/cache`` under the print's own name (#6536, #6537 on H2C01/H2C03).
- The probe runs ~2 s after print start. On an H2S that is before the mirror
  copy lands, and nothing looked again unless someone opened the card (#6522,
  #6523; #6526 only recovered because the cover endpoint ran).
- A probe hit was never content-checked, although ``/cache`` and ``/`` keep
  stale same-name files (a 2025 ``Defence eleph`` sits next to this week's).
"""

from __future__ import annotations

import hashlib
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.main import (
    _active_prints,
    _expected_print_creators,
    _expected_print_registered_at,
    _expected_prints,
    _print_ams_mappings,
    _timelapse_baselines,
)
from backend.app.models.archive import PrintArchive
from backend.app.models.printer import Printer
from backend.app.services.print_storage import (
    REASON_INTERNAL_HISTORY,
    REASON_INTERNAL_STORAGE,
    is_placeholder_print_file,
    probe_filenames,
)

REPRINT_URL = "file:///userdata/project_file.gcode.3mf"
SUBTASK = "Kia cache_plate_2"
REAL_NAME = f"{SUBTASK}.gcode.3mf"
DISPATCH = "/data/Metadata/plate_2.gcode"


@pytest.fixture(autouse=True)
def _clear_dicts():
    dicts = (
        _expected_prints,
        _expected_print_registered_at,
        _expected_print_creators,
        _print_ams_mappings,
        _active_prints,
        _timelapse_baselines,
    )
    for d in dicts:
        d.clear()
    yield
    for d in dicts:
        d.clear()


class TestPlaceholderName:
    @pytest.mark.parametrize("name", ["project_file.gcode.3mf", "project_file.3mf", "Project_File.gcode.3mf"])
    def test_the_reprint_placeholder(self, name):
        assert is_placeholder_print_file(name) is True

    @pytest.mark.parametrize("name", [REAL_NAME, "project_file_v2.gcode.3mf", "my project_file.3mf", None, ""])
    def test_a_real_name(self, name):
        assert is_placeholder_print_file(name) is False


class TestProbeFilenames:
    CANDIDATES = [REAL_NAME, f"{SUBTASK}.3mf", "plate_2.gcode.3mf", "plate_2.3mf"]

    def test_a_real_dispatch_name_is_the_only_one_asked_for(self):
        """The dispatch's name is authoritative; the subtask guesses are not."""
        assert probe_filenames("Cube.gcode.3mf", self.CANDIDATES) == ["Cube.gcode.3mf"]

    def test_the_placeholder_is_replaced_by_the_print_s_own_names(self):
        assert probe_filenames("project_file.gcode.3mf", self.CANDIDATES) == self.CANDIDATES

    def test_no_probe_name_means_no_probe(self):
        """An unreachable verdict without a name (an empty slot) stays unprobed."""
        assert probe_filenames(None, self.CANDIDATES) == []

    def test_placeholder_candidates_are_dropped(self):
        """A subtask that is itself `project_file` names nothing worth a lookup."""
        assert probe_filenames("project_file.gcode.3mf", ["project_file.gcode.3mf", "project_file.3mf"]) == [
            "project_file.gcode.3mf"
        ]

    @pytest.mark.parametrize("bad", ["../x.3mf", "a\\b.3mf", "x\n.3mf", ".hidden.3mf", "plate_2.gcode", "C" * 256])
    def test_a_candidate_that_could_steer_a_path_is_refused(self, bad):
        """The subtask name comes off the wire like the URL does, and becomes a
        remote path and a local temp filename the same way."""
        assert probe_filenames("project_file.gcode.3mf", [bad, REAL_NAME]) == [REAL_NAME]

    def test_duplicates_are_asked_for_once(self):
        assert probe_filenames("project_file.gcode.3mf", [REAL_NAME, REAL_NAME]) == [REAL_NAME]


def _printer():
    printer = MagicMock()
    printer.id = 1
    printer.auto_archive = True
    printer.external_camera_enabled = False
    printer.external_camera_url = None
    printer.plate_detection_enabled = False
    printer.name = "H2C01"
    printer.model = "H2C"
    printer.ip_address = "192.168.50.43"
    printer.access_code = "12345678"
    return printer


async def _run_print_start(url, serve, *, cache_listing=(), data_extra=None):
    """Drive on_print_start for an internal-storage print.

    ``serve(paths, dest)`` plays the printer: it gets the remote paths one
    download call walks and the local destination, and returns the path that
    served the file or None.
    """
    printer = _printer()
    state = MagicMock(current_project_url=url, sdcard=True, sdcard_reported=True)

    def execute_router(stmt, *args, **kwargs):
        sql = str(stmt).lower()
        if "from printers" in sql or "from printer " in sql:
            return MagicMock(
                scalar_one_or_none=MagicMock(return_value=printer),
                scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[printer]))),
            )
        return MagicMock(
            scalar_one_or_none=MagicMock(return_value=None),
            scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[]))),
        )

    added: list = []
    session = AsyncMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock()
    session.execute = AsyncMock(side_effect=execute_router)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock(side_effect=added.append)

    calls: list[list[str]] = []

    async def _download(ip, code, paths, dest, **kwargs):
        calls.append(list(paths))
        return serve(list(paths), Path(dest))

    async def _list(ip, code, path="/", **kwargs):
        if path.rstrip("/") == "/cache":
            return [{"name": name, "is_directory": False} for name in cache_listing]
        return []

    archive_service = MagicMock()
    archive_service.archive_print = AsyncMock(return_value=MagicMock(id=20, print_name=SUBTASK, status="printing"))
    schedule = MagicMock()

    with ExitStack() as stack:
        session_maker = stack.enter_context(patch("backend.app.main.async_session"))
        notif = stack.enter_context(patch("backend.app.main.notification_service"))
        plug = stack.enter_context(patch("backend.app.main.smart_plug_manager"))
        ws = stack.enter_context(patch("backend.app.main.ws_manager"))
        relay = stack.enter_context(patch("backend.app.main.mqtt_relay"))
        pm = stack.enter_context(patch("backend.app.main.printer_manager"))
        stack.enter_context(patch("backend.app.main.download_file_try_paths_async", new=_download))
        stack.enter_context(patch("backend.app.main.download_file_async", new=AsyncMock(return_value=False)))
        stack.enter_context(patch("backend.app.main.with_ftp_retry", new=AsyncMock(return_value=False)))
        stack.enter_context(patch("backend.app.main.get_cached_3mf", return_value=None))
        stack.enter_context(patch("backend.app.main.cache_3mf_download"))
        stack.enter_context(patch("backend.app.services.bambu_ftp.list_files_async", new=_list))
        stack.enter_context(patch("backend.app.main.ftps_handshake_blocked", return_value=False))
        stack.enter_context(
            patch("backend.app.main.get_ftp_retry_settings", new=AsyncMock(return_value=(False, 3, 2.0, 30)))
        )
        stack.enter_context(patch("backend.app.main.ArchiveService", return_value=archive_service))
        stack.enter_context(patch("backend.app.main.peek_plate_index_in_3mf", return_value=None))
        stack.enter_context(patch("backend.app.main._record_energy_start", new_callable=AsyncMock))
        stack.enter_context(patch("backend.app.main._send_print_start_notification", new_callable=AsyncMock))
        stack.enter_context(patch("backend.app.main._maybe_start_layer_timelapse"))
        stack.enter_context(patch("backend.app.main._capture_timelapse_baseline_at_start", new_callable=AsyncMock))
        stack.enter_context(patch("backend.app.main._schedule_fallback_3mf_retry", schedule))
        session_maker.return_value = session
        notif.on_print_start = AsyncMock()
        plug.on_print_start = AsyncMock()
        ws.send_print_start = AsyncMock()
        ws.send_archive_created = AsyncMock()
        ws.send_archive_updated = AsyncMock()
        relay.on_print_start = AsyncMock()
        relay.on_archive_created = AsyncMock()
        pm.get_status = MagicMock(return_value=state)
        pm.get_client = MagicMock(return_value=None)
        pm.get_printer = MagicMock(return_value=MagicMock(serial_number="31B8BP5A1801820"))

        from backend.app.main import on_print_start

        await on_print_start(1, {"filename": DISPATCH, "subtask_name": SUBTASK, **(data_extra or {})})

    return calls, archive_service, schedule, added


def _fallback(added):
    for row in added:
        extra = getattr(row, "extra_data", None)
        if isinstance(extra, dict) and extra.get("no_3mf_available"):
            return row
    return None


def _serve_at(wanted: str, content: bytes = b"3mf"):
    def serve(paths, dest):
        if wanted in paths:
            dest.write_bytes(content)
            return wanted
        return None

    return serve


@pytest.mark.asyncio
class TestReprintFromHistory:
    async def test_the_reprint_is_found_in_cache_under_its_own_name(self):
        """#6536: the card had /cache/Kia cache_plate_2.gcode.3mf all along."""
        calls, service, _schedule, added = await _run_print_start(REPRINT_URL, _serve_at(f"/cache/{REAL_NAME}"))

        assert any(f"/cache/{REAL_NAME}" in paths for paths in calls)
        assert not any(any("project_file" in p for p in paths) for paths in calls)
        service.archive_print.assert_awaited_once()
        assert Path(service.archive_print.await_args.kwargs["source_file"]).name == REAL_NAME
        assert _fallback(added) is None

    async def test_a_miss_keeps_the_reprint_reason(self):
        _calls, service, _schedule, added = await _run_print_start(REPRINT_URL, lambda paths, dest: None)

        service.archive_print.assert_not_awaited()
        assert _fallback(added).extra_data["no_3mf_reason"] == REASON_INTERNAL_HISTORY


@pytest.mark.asyncio
class TestProbeHitIsChecked:
    async def test_a_stale_copy_is_rejected_and_the_search_goes_on(self):
        """Root is probed first and keeps old same-name uploads; with the
        dispatch md5 in hand the stale one is skipped for /cache's."""
        fresh = b"this week's slice"
        stale = b"last year's slice"

        def serve(paths, dest):
            for path in paths:
                if path == f"/{REAL_NAME}":
                    dest.write_bytes(stale)
                    return path
                if path == f"/cache/{REAL_NAME}":
                    dest.write_bytes(fresh)
                    return path
            return None

        calls, service, _schedule, added = await _run_print_start(
            f"brtc://emmc/{REAL_NAME}",
            serve,
            data_extra={"print_md5": hashlib.md5(fresh).hexdigest()},
        )

        assert len(calls) == 2
        assert calls[1][0] == f"/cache/{REAL_NAME}", "the retry must resume after the rejected path"
        service.archive_print.assert_awaited_once()
        assert service.archive_print.await_args.kwargs["content_verified"] is True
        assert _fallback(added) is None

    async def test_only_stale_copies_end_in_the_fallback(self):
        def serve(paths, dest):
            dest.write_bytes(b"wrong")
            return paths[0]

        _calls, service, _schedule, added = await _run_print_start(
            f"brtc://emmc/{REAL_NAME}", serve, data_extra={"print_md5": hashlib.md5(b"right").hexdigest()}
        )

        service.archive_print.assert_not_awaited()
        assert _fallback(added) is not None


@pytest.mark.asyncio
class TestLookAgainLater:
    async def test_a_printer_that_mirrors_gets_a_retry(self):
        """#6522: the H2S had not finished its /cache copy two seconds in."""
        from backend.app.main import _CACHE_MIRROR_RETRY_DELAYS_SECONDS

        _calls, _service, schedule, added = await _run_print_start(
            f"brtc://emmc/{REAL_NAME}", lambda paths, dest: None, cache_listing=["Other.gcode.3mf"]
        )

        archive = _fallback(added)
        assert archive is not None
        schedule.assert_called_once()
        kwargs = schedule.call_args.kwargs
        assert kwargs["filenames"] == [REAL_NAME]
        assert kwargs["delays"] == _CACHE_MIRROR_RETRY_DELAYS_SECONDS
        assert kwargs["reason"] == REASON_INTERNAL_STORAGE
        assert callable(kwargs["judge"])

    async def test_a_reprint_retries_under_its_own_names(self):
        _calls, _service, schedule, _added = await _run_print_start(
            REPRINT_URL, lambda paths, dest: None, cache_listing=["Other.gcode.3mf"]
        )

        assert schedule.call_args.kwargs["filenames"][0] == REAL_NAME

    async def test_a_printer_that_never_mirrors_is_left_alone(self):
        """H2C05 had an empty /cache all day: retrying there finds nothing."""
        _calls, _service, schedule, added = await _run_print_start(
            f"brtc://emmc/{REAL_NAME}", lambda paths, dest: None, cache_listing=()
        )

        assert _fallback(added).extra_data["no_3mf_reason"] == REASON_INTERNAL_STORAGE
        schedule.assert_not_called()


def _write_3mf(path: Path, print_name: str = SUBTASK) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            "Metadata/slice_info.config",
            "<?xml version='1.0' encoding='UTF-8'?><config><plate>"
            "<metadata key='index' value='2'/><metadata key='prediction' value='3600'/>"
            "</plate></config>",
        )
        zf.writestr(
            "Metadata/model_settings.config",
            f"<config><plate><metadata key='name' value='{print_name}'/></plate></config>",
        )
        zf.writestr("3D/3dmodel.model", "<model/>")
    return path


async def _seed(engine) -> tuple[async_sessionmaker, int, int]:
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        printer = Printer(
            name="H2C02", serial_number="31B8BP5A1801686", ip_address="192.168.50.44", access_code="1", model="H2C"
        )
        db.add(printer)
        await db.commit()
        await db.refresh(printer)
        archive = PrintArchive(
            printer_id=printer.id,
            filename=DISPATCH,
            file_path="",
            file_size=0,
            print_name=SUBTASK,
            status="printing",
            extra_data={"no_3mf_available": True, "no_3mf_reason": REASON_INTERNAL_STORAGE},
        )
        db.add(archive)
        await db.commit()
        await db.refresh(archive)
        return maker, printer.id, archive.id


@pytest.mark.asyncio
class TestRecoveredNames:
    async def test_the_cover_temp_prefix_never_reaches_the_card(self, test_engine, tmp_path):
        """#6526 came back as `cover_15_Kia cache_plate_2`: the recovery took
        the cover endpoint's temp filename for the print's own."""
        from backend.app import main as main_module

        maker, printer_id, archive_id = await _seed(test_engine)
        source = _write_3mf(tmp_path / "temp" / f"cover_{printer_id}_{REAL_NAME}", print_name="")

        with (
            patch.object(main_module, "async_session", maker),
            patch.dict(main_module._active_prints, {(printer_id, SUBTASK): archive_id}, clear=True),
        ):
            assert await main_module.try_recover_fallback_archive(printer_id, REAL_NAME, source) is True

        async with maker() as db:
            archive = await db.get(PrintArchive, archive_id)
            assert archive.filename == REAL_NAME
            assert not archive.print_name.startswith("cover_")
            assert "cover_" not in Path(archive.file_path).parent.name


@pytest.mark.asyncio
class TestRetryJudgesItsFind:
    async def _retry(self, test_engine, monkeypatch, judge):
        import asyncio

        from backend.app import main as main_module

        maker, printer_id, archive_id = await _seed(test_engine)

        async def _serve(ip, code, paths, dest, **kwargs):
            _write_3mf(Path(dest))
            return paths[0]

        with (
            patch.object(main_module, "async_session", maker),
            patch.object(main_module, "ftps_handshake_blocked", return_value=False),
            patch.object(main_module, "get_ftp_retry_settings", return_value=(True, 3, 2.0, 30.0)),
            patch.object(main_module, "download_file_try_paths_async", _serve),
        ):
            main_module._schedule_fallback_3mf_retry(
                printer_id=printer_id,
                archive_id=archive_id,
                filenames=[REAL_NAME],
                delays=(0.01,),
                reason=REASON_INTERNAL_STORAGE,
                judge=judge,
            )
            await asyncio.wait_for(main_module._fallback_3mf_retry_tasks[printer_id], timeout=5)

        async with maker() as db:
            return await db.get(PrintArchive, archive_id)

    async def test_a_rejected_find_is_not_attached(self, test_engine, monkeypatch):
        archive = await self._retry(test_engine, monkeypatch, judge=lambda path, remote: "rejected")
        assert not archive.file_path

    async def test_an_accepted_find_is_attached(self, test_engine, monkeypatch):
        archive = await self._retry(test_engine, monkeypatch, judge=lambda path, remote: "verified")
        assert archive.file_path
        assert archive.filename == REAL_NAME


@pytest.mark.asyncio
class TestCoverEndpointReprint:
    """The cover endpoint had the same placeholder blind spot (#6536): it
    probed `project_file.gcode.3mf` and 404'd a cover sitting in /cache."""

    async def _run(self, tmp_path, served_name):
        from types import SimpleNamespace

        import backend.app.api.routes.printers as printers_mod
        from backend.app.api.routes.printers import _produce_cover_image

        asked: list[list[str]] = []
        registered: list[str] = []
        recovered: list[str] = []

        async def _download(ip, code, paths, dest, **kwargs):
            asked.append(list(paths))
            wanted = f"/cache/{served_name}"
            if wanted in paths:
                Path(dest).parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(dest, "w") as zf:
                    zf.writestr("Metadata/plate_2.png", b"\x89PNG\r\n\x1a\nthumb")
                return wanted
            return None

        async def _recover(printer_id, name, path):
            recovered.append(name)
            return False

        printer = SimpleNamespace(id=1, ip_address="192.168.50.43", access_code="x", model="H2C", name="H2C01")
        verdict = SimpleNamespace(
            reachable=False, probe_filename="project_file.gcode.3mf", reason=REASON_INTERNAL_HISTORY
        )
        printers_mod._cover_404_cache.clear()
        with (
            patch.object(printers_mod.settings, "archive_dir", tmp_path / "archive"),
            patch.object(printers_mod.printer_manager, "get_status", MagicMock(return_value=SimpleNamespace())),
            patch.object(printers_mod, "print_file_reachable_over_ftp", MagicMock(return_value=verdict)),
            patch.object(printers_mod, "get_cached_3mf", lambda pid, name: None),
            patch.object(printers_mod, "cache_3mf_download", lambda pid, name, path: registered.append(name)),
            patch.object(printers_mod, "download_file_try_paths_async", _download),
            patch.object(printers_mod, "ftps_handshake_blocked", return_value=False),
            patch("backend.app.main.try_recover_fallback_archive", _recover),
        ):
            image = await _produce_cover_image(printer, 1, SUBTASK, None, "default", 2, (SUBTASK, "default"))
        printers_mod._cover_404_cache.clear()
        return image, asked, registered, recovered

    async def test_the_cover_is_found_under_the_print_s_own_name(self, tmp_path):
        image, asked, _registered, _recovered = await self._run(tmp_path, REAL_NAME)

        assert image
        assert not any("project_file" in p for paths in asked for p in paths)

    async def test_the_file_is_shared_under_the_name_that_served_it(self, tmp_path):
        """The underscore variant is a real candidate (Studio normalizes names);
        whichever served the file is the name the archive flow must see."""
        variant = REAL_NAME.replace(" ", "_")
        _image, _asked, registered, recovered = await self._run(tmp_path, variant)

        assert registered == [variant]
        assert recovered == [variant]
