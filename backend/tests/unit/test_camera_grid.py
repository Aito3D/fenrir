"""Unit tests for camera grid code-review fixes.

Tests _cleanup_stale_frame_buffers(), SharedStreamHub.get_existing/get_existing_batch,
and the NaN/Inf guard in generate_rtsp_mjpeg_stream.
"""

import struct
import time
from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# TestCleanupStaleFrameBuffers
# ---------------------------------------------------------------------------


class TestCleanupStaleFrameBuffers:
    """Tests for _cleanup_stale_frame_buffers (camera routes module)."""

    def _import_cleanup(self):
        from backend.app.api.routes.camera import _cleanup_stale_frame_buffers

        return _cleanup_stale_frame_buffers

    @pytest.mark.asyncio
    async def test_cleanup_removes_stale_entries(self):
        import backend.app.api.routes.camera as cam

        stale_ts = time.monotonic() - cam._FRAME_BUFFER_MAX_AGE - 10
        with (
            patch.dict(cam._state.last_frame_times, {99: stale_ts}, clear=True),
            patch.dict(cam._state.stream_start_times, {99: stale_ts}, clear=True),
        ):
            await cam._cleanup_stale_frame_buffers()
            assert 99 not in cam._state.last_frame_times
            assert 99 not in cam._state.stream_start_times

    @pytest.mark.asyncio
    async def test_cleanup_preserves_fresh_entries(self):
        import backend.app.api.routes.camera as cam

        fresh_ts = time.monotonic()
        with (
            patch.dict(cam._state.last_frame_times, {1: fresh_ts}, clear=True),
            patch.dict(cam._state.stream_start_times, {1: fresh_ts}, clear=True),
        ):
            await cam._cleanup_stale_frame_buffers()
            assert 1 in cam._state.last_frame_times
            assert 1 in cam._state.stream_start_times

    @pytest.mark.asyncio
    async def test_cleanup_handles_partial_entries(self):
        """Stale _last_frame_times entry but no matching _stream_start_times."""
        import backend.app.api.routes.camera as cam

        stale_ts = time.monotonic() - cam._FRAME_BUFFER_MAX_AGE - 10
        with (
            patch.dict(cam._state.last_frame_times, {42: stale_ts}, clear=True),
            patch.dict(cam._state.stream_start_times, {}, clear=True),
        ):
            # Should not raise
            await cam._cleanup_stale_frame_buffers()
            assert 42 not in cam._state.last_frame_times

    @pytest.mark.asyncio
    async def test_cleanup_mixed_fresh_and_stale(self):
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        stale_ts = now - cam._FRAME_BUFFER_MAX_AGE - 10
        fresh_ts = now

        with (
            patch.dict(cam._state.last_frame_times, {1: stale_ts, 2: fresh_ts}, clear=True),
            patch.dict(cam._state.stream_start_times, {1: stale_ts, 2: fresh_ts}, clear=True),
        ):
            await cam._cleanup_stale_frame_buffers()
            # Stale removed
            assert 1 not in cam._state.last_frame_times
            assert 1 not in cam._state.stream_start_times
            # Fresh preserved
            assert 2 in cam._state.last_frame_times
            assert 2 in cam._state.stream_start_times


# ---------------------------------------------------------------------------
# TestSharedStreamHubGetExisting
# ---------------------------------------------------------------------------


class TestSharedStreamHubGetExisting:
    """Tests for SharedStreamHub.get_existing()."""

    @pytest.mark.asyncio
    async def test_get_existing_returns_alive_entry(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream(params_key="5-15-0.5")
        entry.alive = True
        old_accessed = entry.last_accessed - 10
        entry.last_accessed = old_accessed
        hub._streams[1] = entry

        result = await hub.get_existing(1)
        assert result is entry
        assert result.last_accessed > old_accessed

    @pytest.mark.asyncio
    async def test_get_existing_returns_none_for_missing(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        result = await hub.get_existing(999)
        assert result is None

    @pytest.mark.asyncio
    async def test_get_existing_returns_none_for_dead_entry(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream()
        entry.alive = False
        hub._streams[1] = entry

        result = await hub.get_existing(1)
        assert result is None


# ---------------------------------------------------------------------------
# TestSharedStreamHubGetExistingBatch
# ---------------------------------------------------------------------------


class TestSharedStreamHubGetExistingBatch:
    """Tests for SharedStreamHub.get_existing_batch()."""

    @pytest.mark.asyncio
    async def test_batch_partitions_correctly(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()

        alive_entry = _SharedStream()
        alive_entry.alive = True
        hub._streams[1] = alive_entry

        dead_entry = _SharedStream()
        dead_entry.alive = False
        hub._streams[2] = dead_entry

        # 3 is absent

        found, missing = await hub.get_existing_batch([1, 2, 3])
        assert set(found.keys()) == {1}
        assert found[1] is alive_entry
        assert missing == [2, 3]

    @pytest.mark.asyncio
    async def test_batch_updates_last_accessed_only_for_found(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()

        alive_entry = _SharedStream()
        alive_entry.alive = True
        old_ts = alive_entry.last_accessed - 100
        alive_entry.last_accessed = old_ts
        hub._streams[1] = alive_entry

        dead_entry = _SharedStream()
        dead_entry.alive = False
        dead_ts = dead_entry.last_accessed
        hub._streams[2] = dead_entry

        await hub.get_existing_batch([1, 2])
        assert alive_entry.last_accessed > old_ts
        assert dead_entry.last_accessed == dead_ts

    @pytest.mark.asyncio
    async def test_batch_all_missing(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()

        found, missing = await hub.get_existing_batch([1, 2, 3])
        assert found == {}
        assert missing == [1, 2, 3]

    @pytest.mark.asyncio
    async def test_batch_all_found(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()

        for pid in [1, 2]:
            entry = _SharedStream()
            entry.alive = True
            hub._streams[pid] = entry

        found, missing = await hub.get_existing_batch([1, 2])
        assert set(found.keys()) == {1, 2}
        assert missing == []


# ---------------------------------------------------------------------------
# TestGenerateRtspNonFiniteGuard
# ---------------------------------------------------------------------------


class TestGenerateRtspNonFiniteGuard:
    """Tests for the NaN/Inf guard in generate_rtsp_mjpeg_stream."""

    @pytest.mark.asyncio
    async def test_nan_scale(self):
        from backend.app.api.routes.camera import generate_rtsp_mjpeg_stream

        with patch("backend.app.api.routes.camera.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"):
            frames = []
            async for chunk in generate_rtsp_mjpeg_stream(
                "192.168.1.1",
                "code",
                "X1C",
                fps=5,
                scale=float("nan"),
            ):
                frames.append(chunk)
                break
            assert any(b"invalid parameters" in f for f in frames)

    @pytest.mark.asyncio
    async def test_inf_fps(self):
        from backend.app.api.routes.camera import generate_rtsp_mjpeg_stream

        with patch("backend.app.api.routes.camera.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"):
            frames = []
            async for chunk in generate_rtsp_mjpeg_stream(
                "192.168.1.1",
                "code",
                "X1C",
                fps=float("inf"),
            ):
                frames.append(chunk)
                break
            assert any(b"invalid parameters" in f for f in frames)

    @pytest.mark.asyncio
    async def test_neg_inf_quality(self):
        from backend.app.api.routes.camera import generate_rtsp_mjpeg_stream

        with patch("backend.app.api.routes.camera.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"):
            frames = []
            async for chunk in generate_rtsp_mjpeg_stream(
                "192.168.1.1",
                "code",
                "X1C",
                quality=float("-inf"),
            ):
                frames.append(chunk)
                break
            assert any(b"invalid parameters" in f for f in frames)


# ---------------------------------------------------------------------------
# TestEnsureProducerDispatch
# ---------------------------------------------------------------------------


class TestEnsureProducerDispatch:
    """Tests for _ensure_producer() dispatch logic."""

    @pytest.mark.asyncio
    async def test_ensure_producer_external_camera_returns_none(self):
        """External cameras are unsupported in grid mode — should return None."""
        from unittest.mock import AsyncMock, MagicMock

        from backend.app.api.routes.camera import SharedStreamHub, _ensure_producer

        hub = SharedStreamHub()
        db = AsyncMock()

        printer = MagicMock()
        printer.id = 1
        printer.external_camera_enabled = True
        printer.external_camera_url = "http://example.com/stream"

        result = await _ensure_producer(1, db, 5, 15, 0.5, printer=printer, hub=hub)
        assert result is None

    @pytest.mark.asyncio
    async def test_ensure_producer_reuse_does_not_reset_start_time(self):
        """Reusing an existing producer should not reset _stream_start_times (M2)."""
        from unittest.mock import AsyncMock, patch

        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import SharedStreamHub, _ensure_producer, _SharedStream

        hub = SharedStreamHub()
        # Pre-insert an alive producer
        entry = _SharedStream(params_key="5-15-0.5-0-False-False")
        entry.alive = True
        hub._streams[1] = entry

        original_start = time.monotonic() - 100
        with patch.dict(cam._state.stream_start_times, {1: original_start}, clear=False):
            db = AsyncMock()
            result = await _ensure_producer(1, db, 5, 15, 0.5, hub=hub)
            assert result is entry
            # Start time should NOT have been reset
            assert cam._state.stream_start_times[1] == original_start

    @pytest.mark.asyncio
    async def test_ensure_producer_force_quality_calls_restart(self):
        """force_quality=True should trigger hub.restart() for param changes."""
        from unittest.mock import AsyncMock, MagicMock, patch

        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import SharedStreamHub, _ensure_producer

        hub = SharedStreamHub()

        # Create a mock printer
        printer = MagicMock()
        printer.id = 1
        printer.model = "X1C"
        printer.ip_address = "192.168.1.100"
        printer.access_code = "12345678"
        printer.external_camera_enabled = False
        printer.external_camera_url = None

        db = AsyncMock()

        # Mock the stream generators to avoid real ffmpeg
        async def fake_stream(**kwargs):
            while True:
                yield b"\xff\xd8fake\xff\xd9"
                import asyncio

                await asyncio.sleep(0.1)

        with (
            patch("backend.app.api.routes.camera.generate_rtsp_mjpeg_stream", fake_stream),
            patch("backend.app.api.routes.camera.is_chamber_image_model", return_value=False),
            patch("backend.app.api.routes.camera._check_system_load", return_value=0.0),
            patch.dict(cam._state.stream_start_times, {}, clear=False),
        ):
            # Start initial producer
            entry1 = await _ensure_producer(1, db, 5, 15, 0.5, printer=printer, hub=hub)
            assert entry1 is not None
            assert entry1.alive is True

            # Force restart with different params
            entry2 = await _ensure_producer(1, db, 10, 20, 1.0, printer=printer, force_quality=True, hub=hub)
            assert entry2 is not None
            assert entry2 is not entry1  # Should be a new entry
            assert entry1.alive is False  # Old one should be dead

        await hub.stop_all()


# ---------------------------------------------------------------------------
# TestFleetCpuWatchdog
# ---------------------------------------------------------------------------


class TestFleetCpuWatchdog:
    """Tests for the fleet-level CPU watchdog in _cleanup_stale_frame_buffers."""

    @pytest.mark.asyncio
    async def test_fleet_watchdog_kills_worst_offenders(self):
        """When fleet CPU total exceeds threshold, kill highest-CPU processes first."""
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        # Simulate 4 FFmpeg processes past grace period with high CPU
        pids = {100: now - 60, 101: now - 60, 102: now - 60, 103: now - 60}
        # Previous samples: each at ~25% CPU (under 30% individual threshold)
        prev_wall = now - 10
        samples = {
            100: (prev_wall, 10.0),
            101: (prev_wall, 10.0),
            102: (prev_wall, 10.0),
            103: (prev_wall, 10.0),
        }
        # Current CPU times: each used 2.5 more seconds in 10s = 25%
        cpu_times_result = {100: 12.5, 101: 12.5, 102: 12.5, 103: 12.5}
        # Fleet total = 4 × 25% = 100%

        killed_pids = []
        original_kill = cam.os.kill

        def mock_kill(pid, sig):
            if pid in pids:
                killed_pids.append(pid)
            else:
                original_kill(pid, sig)

        # Set fleet threshold low so 100% triggers it
        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
            patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
            patch.dict(cam._state.last_frame_times, {}, clear=True),
            patch.dict(cam._state.stream_start_times, {}, clear=True),
            patch.object(cam, "_FLEET_CPU_PCT_THRESHOLD", 80.0),
            patch("backend.app.api.routes.camera.os.kill", side_effect=mock_kill),
            patch(
                "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                return_value=cpu_times_result,
            ),
            patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
        ):
            await cam._cleanup_stale_frame_buffers()
            # Should have killed enough to get under 80%: need to kill at least 1 of 4
            # (100% - 25% = 75% under)
            assert len(killed_pids) >= 1

    @pytest.mark.asyncio
    async def test_fleet_watchdog_no_kill_under_threshold(self):
        """When fleet CPU total is under threshold, no processes are killed."""
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        pids = {200: now - 60, 201: now - 60}
        prev_wall = now - 10
        samples = {200: (prev_wall, 10.0), 201: (prev_wall, 10.0)}
        # Each at 10% CPU = fleet total 20%
        cpu_times_result = {200: 11.0, 201: 11.0}

        killed_pids = []

        def mock_kill(pid, sig):
            killed_pids.append(pid)

        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
            patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
            patch.dict(cam._state.last_frame_times, {}, clear=True),
            patch.dict(cam._state.stream_start_times, {}, clear=True),
            patch("backend.app.api.routes.camera.os.kill", side_effect=mock_kill),
            patch(
                "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                return_value=cpu_times_result,
            ),
            patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
        ):
            await cam._cleanup_stale_frame_buffers()
            assert len(killed_pids) == 0

    @pytest.mark.asyncio
    async def test_fleet_watchdog_respects_grace_period(self):
        """Processes in grace period should not be included in fleet CPU total."""
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        # PID 300 is past grace (10s), PID 301 is in grace period
        pids = {300: now - 60, 301: now - 3}
        prev_wall = now - 10
        samples = {300: (prev_wall, 10.0)}
        # PID 300 at 25% (under 50% per-process), PID 301 would be 25% but in grace
        cpu_times_result = {300: 12.5, 301: 12.5}

        killed_pids = []

        def mock_kill(pid, sig):
            killed_pids.append(pid)

        # Fleet threshold at 20% — only PID 300 (25%) is counted, fleet total = 25% > 20%
        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
            patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
            patch.dict(cam._state.last_frame_times, {}, clear=True),
            patch.dict(cam._state.stream_start_times, {}, clear=True),
            patch.object(cam, "_FLEET_CPU_PCT_THRESHOLD", 20.0),
            patch("backend.app.api.routes.camera.os.kill", side_effect=mock_kill),
            patch(
                "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                return_value=cpu_times_result,
            ),
            patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
        ):
            await cam._cleanup_stale_frame_buffers()
            # Only PID 300 counted and it's over fleet threshold → killed by fleet watchdog
            assert 300 in killed_pids
            # PID 301 in grace period — should NOT be killed
            assert 301 not in killed_pids


# ---------------------------------------------------------------------------
# TestScanBambuFfmpegPids
# ---------------------------------------------------------------------------


class TestScanBambuFfmpegPids:
    """Tests for _scan_bambu_ffmpeg_pids platform guard (O2)."""

    def test_returns_empty_on_non_linux(self):
        """On macOS/Windows, should return [] without scanning /proc."""
        from backend.app.api.routes.camera import _scan_bambu_ffmpeg_pids

        with patch("backend.app.api.routes.camera.sys") as mock_sys:
            mock_sys.platform = "darwin"
            result = _scan_bambu_ffmpeg_pids()
            assert result == []


# ---------------------------------------------------------------------------
# TestSpawnLoadGate
# ---------------------------------------------------------------------------


class TestSpawnLoadGate:
    """Tests for _check_system_load and the load gate in _ensure_producer."""

    def test_check_system_load_returns_float(self):
        from backend.app.api.routes.camera import _check_system_load

        with patch("backend.app.api.routes.camera.os.getloadavg", return_value=(2.5, 2.0, 1.5)):
            result = _check_system_load()
            assert result == 2.5

    def test_check_system_load_returns_none_on_error(self):
        from backend.app.api.routes.camera import _check_system_load

        with patch("backend.app.api.routes.camera.os.getloadavg", side_effect=AttributeError):
            result = _check_system_load()
            assert result is None

    @pytest.mark.asyncio
    async def test_load_gate_blocks_spawn_when_overloaded(self):
        """_ensure_producer should return None when system load exceeds threshold."""
        from unittest.mock import AsyncMock, MagicMock

        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import SharedStreamHub, _ensure_producer

        hub = SharedStreamHub()
        db = AsyncMock()

        printer = MagicMock()
        printer.id = 1
        printer.model = "X1C"
        printer.ip_address = "192.168.1.100"
        printer.access_code = "12345678"
        printer.external_camera_enabled = False
        printer.external_camera_url = None

        # Simulate high load (above threshold)
        with patch("backend.app.api.routes.camera.os.getloadavg", return_value=(100.0, 90.0, 80.0)):
            result = await _ensure_producer(1, db, 5, 15, 0.5, printer=printer, hub=hub)
            assert result is None

    @pytest.mark.asyncio
    async def test_load_gate_allows_spawn_when_load_ok(self):
        """_ensure_producer should proceed when system load is below threshold."""
        from unittest.mock import AsyncMock, MagicMock

        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import SharedStreamHub, _ensure_producer

        hub = SharedStreamHub()
        db = AsyncMock()

        printer = MagicMock()
        printer.id = 1
        printer.model = "X1C"
        printer.ip_address = "192.168.1.100"
        printer.access_code = "12345678"
        printer.external_camera_enabled = False
        printer.external_camera_url = None

        async def fake_stream(**kwargs):
            while True:
                yield b"\xff\xd8fake\xff\xd9"
                import asyncio

                await asyncio.sleep(0.1)

        # Simulate low load (below threshold)
        with (
            patch("backend.app.api.routes.camera.os.getloadavg", return_value=(0.5, 0.5, 0.5)),
            patch("backend.app.api.routes.camera.generate_rtsp_mjpeg_stream", fake_stream),
            patch("backend.app.api.routes.camera.is_chamber_image_model", return_value=False),
            patch.dict(cam._state.stream_start_times, {}, clear=False),
        ):
            result = await _ensure_producer(1, db, 5, 15, 0.5, printer=printer, hub=hub)
            assert result is not None
            assert result.alive is True

        await hub.stop_all()


# ---------------------------------------------------------------------------
# TestCircuitBreaker
# ---------------------------------------------------------------------------


class TestCircuitBreaker:
    """Tests for the circuit breaker between watchdog and grid restart logic."""

    @pytest.mark.asyncio
    async def test_watchdog_kill_sets_per_printer_cooldown(self):
        """Per-process watchdog kill should activate per-printer cooldown, not fleet cooldown."""
        import asyncio
        from unittest.mock import MagicMock

        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        pids = {400: now - 60}
        prev_wall = now - 10
        samples = {400: (prev_wall, 10.0)}
        # 55% CPU — over the 50% per-process threshold
        cpu_times_result = {400: 15.5}

        original_kill = cam.os.kill

        def mock_kill(pid, sig):
            if pid in pids:
                pass  # Don't actually kill
            else:
                original_kill(pid, sig)

        # Mock _active_streams to map PID -> printer_id via stream_id
        mock_proc = MagicMock()
        mock_proc.pid = 400

        old_cooldown = cam._state.fleet_cooldown_until
        old_per_printer = dict(cam._state.per_printer_cooldown)
        try:
            with (
                patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
                patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
                patch.dict(cam._state.last_frame_times, {}, clear=True),
                patch.dict(cam._state.stream_start_times, {}, clear=True),
                patch.dict(cam._state.active_streams, {"42-abc": mock_proc}, clear=True),
                patch("backend.app.api.routes.camera.os.kill", side_effect=mock_kill),
                patch(
                    "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                    return_value=cpu_times_result,
                ),
                patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
            ):
                cam._state.fleet_cooldown_until = 0.0  # Reset fleet cooldown
                await cam._cleanup_stale_frame_buffers()
                # Per-printer cooldown should be set for printer 42
                assert 42 in cam._state.per_printer_cooldown
                assert cam._state.per_printer_cooldown[42] > now
                assert cam._state.per_printer_cooldown[42] <= now + cam._PER_PRINTER_COOLDOWN_DURATION + 1
                # Fleet cooldown should NOT be set by per-process kill
                assert cam._state.fleet_cooldown_until == 0.0
        finally:
            cam._state.fleet_cooldown_until = old_cooldown
            cam._state.per_printer_cooldown.clear()
            cam._state.per_printer_cooldown.update(old_per_printer)

    @pytest.mark.asyncio
    async def test_fleet_kill_sets_cooldown_and_tracks_printers(self):
        """Fleet-level watchdog kill should set cooldown and track killed printer IDs."""
        import asyncio
        from unittest.mock import MagicMock

        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        pids = {500: now - 60, 501: now - 60}
        prev_wall = now - 10
        samples = {500: (prev_wall, 10.0), 501: (prev_wall, 10.0)}
        # Each at 25% — under per-process 50% but fleet total 50%
        cpu_times_result = {500: 12.5, 501: 12.5}

        killed_pids = []

        def mock_kill(pid, sig):
            killed_pids.append(pid)

        # Mock _active_streams to map PID -> printer_id
        mock_proc_500 = MagicMock()
        mock_proc_500.pid = 500
        mock_proc_501 = MagicMock()
        mock_proc_501.pid = 501

        old_cooldown = cam._state.fleet_cooldown_until
        old_killed = cam._state.watchdog_killed_printers.copy()
        try:
            with (
                patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
                patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
                patch.dict(cam._state.last_frame_times, {}, clear=True),
                patch.dict(cam._state.stream_start_times, {}, clear=True),
                patch.dict(cam._state.active_streams, {"10-abc": mock_proc_500, "11-def": mock_proc_501}, clear=True),
                patch.object(cam, "_FLEET_CPU_PCT_THRESHOLD", 40.0),
                patch("backend.app.api.routes.camera.os.kill", side_effect=mock_kill),
                patch(
                    "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                    return_value=cpu_times_result,
                ),
                patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
            ):
                await cam._cleanup_stale_frame_buffers()
                assert len(killed_pids) >= 1
                assert cam._state.fleet_cooldown_until > now
                # Killed printer IDs should be tracked
                assert len(cam._state.watchdog_killed_printers) >= 1
        finally:
            cam._state.fleet_cooldown_until = old_cooldown
            cam._state.watchdog_killed_printers = old_killed

    def test_watchdog_killed_printer_gets_higher_initial_attempts(self):
        """When a watchdog-killed printer dies, it should start with initial_attempts=2."""
        import backend.app.api.routes.camera as cam

        # Verify the constant exists and _watchdog_killed_printers is a set
        assert isinstance(cam._state.watchdog_killed_printers, set)
        assert cam._FLEET_COOLDOWN_DURATION == 15.0

    def test_per_printer_cooldown_isolates_printers(self):
        """Per-printer cooldown should not block other printers from restarting."""
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        old_per_printer = dict(cam._state.per_printer_cooldown)
        try:
            # Printer 1 is in cooldown, printer 2 is not
            cam._state.per_printer_cooldown[1] = now + 60  # 60s remaining
            cam._state.per_printer_cooldown[2] = now - 10  # expired 10s ago

            # Printer 1 should still be in cooldown
            assert now < cam._state.per_printer_cooldown[1]
            # Printer 2's cooldown has expired
            assert now >= cam._state.per_printer_cooldown[2]
            # Verify duration constant
            assert cam._PER_PRINTER_COOLDOWN_DURATION == 10.0
        finally:
            cam._state.per_printer_cooldown.clear()
            cam._state.per_printer_cooldown.update(old_per_printer)


# ---------------------------------------------------------------------------
# TestAdaptiveCleanupInterval
# ---------------------------------------------------------------------------


class TestAdaptiveCleanupInterval:
    """Tests for adaptive cleanup interval under CPU load."""

    @pytest.mark.asyncio
    async def test_interval_accelerates_under_load(self):
        """Cleanup interval should be overridden to 5s when fleet CPU > 50% of threshold."""
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        pids = {600: now - 60, 601: now - 60}
        prev_wall = now - 10
        samples = {600: (prev_wall, 10.0), 601: (prev_wall, 10.0)}
        # Each at 20% = fleet total 40%, which is > 50% of default 200% threshold? No.
        # 50% of threshold = 100%. 40% < 100%. Need higher values.
        # Each at 60% -> fleet 120% > 50% of 200% (100%). But 60% > 30% per-process kills them.
        # Use patched threshold: 60%. 50% of 60% = 30%. Fleet at 40% > 30%.
        cpu_times_result = {600: 12.0, 601: 12.0}  # Each 20%

        old_override = cam._state.cleanup_interval_override
        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
            patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
            patch.dict(cam._state.last_frame_times, {}, clear=True),
            patch.dict(cam._state.stream_start_times, {}, clear=True),
            patch.object(cam, "_FLEET_CPU_PCT_THRESHOLD", 60.0),
            patch("backend.app.api.routes.camera.os.kill", side_effect=lambda p, s: None),
            patch(
                "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                return_value=cpu_times_result,
            ),
            patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
        ):
            await cam._cleanup_stale_frame_buffers()
            # Fleet total 40% > 50% of 60% (30%) → should set override to 5.0
            assert cam._state.cleanup_interval_override == 5.0

        cam._state.cleanup_interval_override = old_override

    @pytest.mark.asyncio
    async def test_interval_resets_when_load_drops(self):
        """Cleanup interval override should be cleared when fleet CPU drops below 50% of threshold."""
        import backend.app.api.routes.camera as cam

        now = time.monotonic()
        pids = {700: now - 60}
        prev_wall = now - 10
        samples = {700: (prev_wall, 10.0)}
        # 5% CPU — well below any threshold
        cpu_times_result = {700: 10.5}

        cam._state.cleanup_interval_override = 5.0  # Pre-set as if it was previously accelerated
        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, pids, clear=True),
            patch.dict(cam._state.ffmpeg_cpu_samples, samples, clear=True),
            patch.dict(cam._state.last_frame_times, {}, clear=True),
            patch.dict(cam._state.stream_start_times, {}, clear=True),
            patch("backend.app.api.routes.camera.os.kill", side_effect=lambda p, s: None),
            patch(
                "backend.app.api.routes.camera._read_ffmpeg_cpu_times",
                return_value=cpu_times_result,
            ),
            patch("backend.app.api.routes.camera._scan_dead_pids", return_value=[]),
        ):
            await cam._cleanup_stale_frame_buffers()
            assert cam._state.cleanup_interval_override is None


# ---------------------------------------------------------------------------
# TestCrossplatformCpuTimes
# ---------------------------------------------------------------------------


class TestCrossplatformCpuTimes:
    """Tests for psutil-based _read_ffmpeg_cpu_times."""

    def test_reads_cpu_times_via_psutil(self):
        """Should return CPU seconds for tracked PIDs using psutil."""
        from unittest.mock import MagicMock

        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import _read_ffmpeg_cpu_times

        mock_times = MagicMock()
        mock_times.user = 5.0
        mock_times.system = 2.0

        mock_process = MagicMock()
        mock_process.cpu_times.return_value = mock_times

        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, {999: time.monotonic()}, clear=True),
            patch("backend.app.api.routes.camera.psutil.Process", return_value=mock_process),
        ):
            result = _read_ffmpeg_cpu_times()
            assert result == {999: 7.0}

    def test_handles_missing_process(self):
        """Should skip PIDs where the process no longer exists."""
        import psutil

        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import _read_ffmpeg_cpu_times

        with (
            patch.dict(cam._state.spawned_ffmpeg_pids, {888: time.monotonic()}, clear=True),
            patch("backend.app.api.routes.camera.psutil.Process", side_effect=psutil.NoSuchProcess(888)),
        ):
            result = _read_ffmpeg_cpu_times()
            assert result == {}


# ---------------------------------------------------------------------------
# TestPreSeededBaseline
# ---------------------------------------------------------------------------


class TestPreSeededBaseline:
    """Tests for CPU baseline pre-seeding at spawn time."""

    def test_constants_reflect_tighter_thresholds(self):
        """Verify the tightened watchdog constants."""
        import backend.app.api.routes.camera as cam

        assert cam._CPU_PCT_KILL_THRESHOLD == 50.0
        assert cam._CPU_WATCHDOG_GRACE_SECS == 10.0
        assert cam._CLEANUP_INTERVAL == 10.0
        # Fleet threshold = cpu_count * 50
        import os

        expected_fleet = (os.cpu_count() or 4) * 50.0
        assert expected_fleet == cam._FLEET_CPU_PCT_THRESHOLD


# ---------------------------------------------------------------------------
# TestStderrCategorization
# ---------------------------------------------------------------------------


class TestStderrCategorization:
    """Tests for structured FFmpeg stderr error categorization."""

    def test_categorize_decoder_corruption(self):
        from backend.app.api.routes.camera import _categorize_ffmpeg_error

        assert _categorize_ffmpeg_error("broken bitstream in frame 42") == "decoder_corruption"
        assert _categorize_ffmpeg_error("corrupt data near offset 0x1234") == "decoder_corruption"
        assert _categorize_ffmpeg_error("invalid NAL unit type 31") == "decoder_corruption"

    def test_categorize_bitstream_error(self):
        from backend.app.api.routes.camera import _categorize_ffmpeg_error

        assert _categorize_ffmpeg_error("overread 8 bits") == "bitstream_error"
        assert _categorize_ffmpeg_error("cabac decode failure") == "bitstream_error"

    def test_categorize_network_timeout(self):
        from backend.app.api.routes.camera import _categorize_ffmpeg_error

        assert _categorize_ffmpeg_error("Connection timed out") == "network_timeout"
        assert _categorize_ffmpeg_error("timeout waiting for data") == "network_timeout"
        assert _categorize_ffmpeg_error("Connection refused") == "network_timeout"

    def test_categorize_stream_eof(self):
        from backend.app.api.routes.camera import _categorize_ffmpeg_error

        assert _categorize_ffmpeg_error("End of file reached") == "stream_eof"

    def test_categorize_fatal(self):
        from backend.app.api.routes.camera import _categorize_ffmpeg_error

        assert _categorize_ffmpeg_error("fatal: unknown codec") == "fatal"

    def test_categorize_generic_error(self):
        from backend.app.api.routes.camera import _categorize_ffmpeg_error

        assert _categorize_ffmpeg_error("error processing input") == "generic_error"

    @pytest.mark.asyncio
    async def test_drain_stderr_populates_details(self):
        """_drain_stderr should populate _stderr_error_details and _stderr_recent_errors."""
        import asyncio

        import backend.app.api.routes.camera as cam

        # Create a mock process with stderr that yields error lines
        class MockStderr:
            def __init__(self):
                self._data = [
                    b"[h264] broken bitstream in frame 1\n",
                    b"[h264] overread 8 bits\n",
                    b"Connection timed out\n",
                    b"",  # EOF
                ]
                self._idx = 0

            async def read(self, n):
                if self._idx >= len(self._data):
                    return b""
                data = self._data[self._idx]
                self._idx += 1
                return data

        class MockProcess:
            stderr = MockStderr()

        old_counts = dict(cam._state.stderr_error_counts)
        old_details = dict(cam._state.stderr_error_details)
        old_recent = dict(cam._state.stderr_recent_errors)

        try:
            await cam._drain_stderr(MockProcess(), "test-stream-1")

            assert "test-stream-1" in cam._state.stderr_error_counts
            assert cam._state.stderr_error_counts["test-stream-1"] == 3

            details = cam._state.stderr_error_details["test-stream-1"]
            assert details["decoder_corruption"] == 1
            assert details["bitstream_error"] == 1
            assert details["network_timeout"] == 1

            recent = cam._state.stderr_recent_errors["test-stream-1"]
            assert len(recent) == 3
        finally:
            # Restore
            cam._state.stderr_error_counts.clear()
            cam._state.stderr_error_counts.update(old_counts)
            cam._state.stderr_error_details.clear()
            cam._state.stderr_error_details.update(old_details)
            cam._state.stderr_recent_errors.clear()
            cam._state.stderr_recent_errors.update(old_recent)

    @pytest.mark.asyncio
    async def test_drain_stderr_caps_recent_lines(self):
        """_stderr_recent_errors should be capped at _STDERR_RECENT_CAP."""
        import backend.app.api.routes.camera as cam

        # Generate more error lines than the cap
        lines = [f"[h264] error in frame {i}\n".encode() for i in range(30)]

        class MockStderr:
            def __init__(self):
                self._data = lines + [b""]
                self._idx = 0

            async def read(self, n):
                if self._idx >= len(self._data):
                    return b""
                data = self._data[self._idx]
                self._idx += 1
                return data

        class MockProcess:
            stderr = MockStderr()

        old_recent = dict(cam._state.stderr_recent_errors)
        try:
            await cam._drain_stderr(MockProcess(), "test-cap")
            assert len(cam._state.stderr_recent_errors["test-cap"]) == cam._STDERR_RECENT_CAP
        finally:
            cam._state.stderr_recent_errors.clear()
            cam._state.stderr_recent_errors.update(old_recent)

    @pytest.mark.asyncio
    async def test_repeated_restarts_leave_one_latest_summary_per_printer(self):
        """A failing camera's stderr summary must not grow without bound.

        The grid restart loop mints a fresh stream_id for the same printer on
        every retry. ``_drain_stderr``'s ``finally`` evicts the printer's
        older stream_id summaries right after writing its own, so N completed
        attempts must leave exactly one entry per printer in each of the
        three dicts — the most recent attempt — never one per attempt. An
        unrelated (live) printer's entry, and hub-status's view of it, must
        be untouched.
        """
        import backend.app.api.routes.camera as cam

        def make_mock_process(lines: list[bytes]):
            class MockStderr:
                def __init__(self):
                    self._data = [*lines, b""]
                    self._idx = 0

                async def read(self, _n):
                    if self._idx >= len(self._data):
                        return b""
                    data = self._data[self._idx]
                    self._idx += 1
                    return data

            class MockProcess:
                stderr = MockStderr()

            return MockProcess()

        old_counts = dict(cam._state.stderr_error_counts)
        old_details = dict(cam._state.stderr_error_details)
        old_recent = dict(cam._state.stderr_recent_errors)

        failing_pid = 999001
        other_pid = 999002
        other_stream = f"{other_pid}-aaaaaaaa"

        try:
            cam._state.stderr_error_counts.clear()
            cam._state.stderr_error_details.clear()
            cam._state.stderr_recent_errors.clear()

            # An unrelated (live) printer's entry must survive the failing
            # printer's restarts untouched (prefix eviction must not
            # over-match).
            cam._state.stderr_error_counts[other_stream] = 5
            cam._state.stderr_error_details[other_stream] = {"fatal": 5}
            cam._state.stderr_recent_errors[other_stream] = ["other printer error"]

            # 12 restart attempts of the same failing camera, each completing
            # (and writing its summary) before the next one starts.
            last_stream_id = None
            for i in range(12):
                stream_id = f"{failing_pid}-{i:08x}"
                last_stream_id = stream_id
                await cam._drain_stderr(make_mock_process([f"[h264] error attempt {i}\n".encode()]), stream_id)

            matching = [k for k in cam._state.stderr_error_counts if k.startswith(f"{failing_pid}-")]
            assert len(matching) == 1, f"expected exactly one bounded entry, got {matching}"
            assert matching == [last_stream_id]
            assert cam._state.stderr_error_details[last_stream_id] == {"generic_error": 1}
            assert cam._state.stderr_recent_errors[last_stream_id] == ["[h264] error attempt 11"]

            # The unrelated printer's entry is untouched.
            assert cam._state.stderr_error_counts[other_stream] == 5
            assert cam._state.stderr_error_details[other_stream] == {"fatal": 5}

            # hub-status surfaces the bounded, most-recent-only summary for
            # the failing printer and leaves the live printer's summary
            # (raw dicts and per-printer aggregate) unaffected.
            status = await cam.camera_hub_status(_=None)
            raw_failing_keys = [k for k in status["stderr_error_counts"] if k.startswith(f"{failing_pid}-")]
            assert raw_failing_keys == [last_stream_id]
            assert status["stderr_error_counts"][other_stream] == 5
            assert status["per_printer_status"][str(failing_pid)]["error_counts"] == {"generic_error": 1}
            assert status["per_printer_status"][str(failing_pid)]["last_error_category"] == "generic_error"
            assert status["per_printer_status"][str(other_pid)]["error_counts"] == {"fatal": 5}
        finally:
            cam._state.stderr_error_counts.clear()
            cam._state.stderr_error_counts.update(old_counts)
            cam._state.stderr_error_details.clear()
            cam._state.stderr_error_details.update(old_details)
            cam._state.stderr_recent_errors.clear()
            cam._state.stderr_recent_errors.update(old_recent)

    @pytest.mark.asyncio
    async def test_previous_attempt_summary_stays_visible_during_in_flight_retry(self):
        """The previous completed attempt's summary must not vanish mid-retry.

        Eviction happens in ``_drain_stderr``'s ``finally``, after the new
        attempt's own summary has been written — not at stream_id mint time.
        So while a new attempt is still draining (no summary written yet),
        the previous attempt's entry for that printer must still be present
        in the raw dicts and in hub-status's per-printer aggregate.
        """
        import asyncio

        import backend.app.api.routes.camera as cam

        old_counts = dict(cam._state.stderr_error_counts)
        old_details = dict(cam._state.stderr_error_details)
        old_recent = dict(cam._state.stderr_recent_errors)

        failing_pid = 999003
        stream_1 = f"{failing_pid}-11111111"
        stream_2 = f"{failing_pid}-22222222"

        reached_block = asyncio.Event()
        release = asyncio.Event()

        class MockStderr:
            def __init__(self):
                self._sent = False

            async def read(self, _n):
                if not self._sent:
                    self._sent = True
                    return b"[h264] error two\n"
                reached_block.set()
                await release.wait()
                return b""

        class MockProcess:
            stderr = MockStderr()

        try:
            cam._state.stderr_error_counts.clear()
            cam._state.stderr_error_details.clear()
            cam._state.stderr_recent_errors.clear()

            # First attempt completes normally.
            class FirstMockStderr:
                def __init__(self):
                    self._data = [b"[h264] error one\n", b""]
                    self._idx = 0

                async def read(self, _n):
                    if self._idx >= len(self._data):
                        return b""
                    data = self._data[self._idx]
                    self._idx += 1
                    return data

            class FirstMockProcess:
                stderr = FirstMockStderr()

            await cam._drain_stderr(FirstMockProcess(), stream_1)
            assert cam._state.stderr_error_counts[stream_1] == 1

            # Second attempt starts producing errors but is still in flight
            # (blocked reading more stderr) — its finally has not run yet.
            task = asyncio.create_task(cam._drain_stderr(MockProcess(), stream_2))
            await asyncio.wait_for(reached_block.wait(), timeout=5)

            # Still in flight: the previous attempt's summary is still there,
            # and the new attempt hasn't written (or evicted) anything yet.
            assert stream_1 in cam._state.stderr_error_counts
            assert stream_2 not in cam._state.stderr_error_counts
            status = await cam.camera_hub_status(_=None)
            assert status["per_printer_status"][str(failing_pid)]["error_counts"] == {"generic_error": 1}

            # Let the attempt finish — it should now replace the previous one.
            release.set()
            await asyncio.wait_for(task, timeout=5)

            assert stream_2 in cam._state.stderr_error_counts
            assert stream_1 not in cam._state.stderr_error_counts
            status = await cam.camera_hub_status(_=None)
            assert status["per_printer_status"][str(failing_pid)]["error_counts"] == {"generic_error": 1}
        finally:
            cam._state.stderr_error_counts.clear()
            cam._state.stderr_error_counts.update(old_counts)
            cam._state.stderr_error_details.clear()
            cam._state.stderr_error_details.update(old_details)
            cam._state.stderr_recent_errors.clear()
            cam._state.stderr_recent_errors.update(old_recent)


# ---------------------------------------------------------------------------
# TestAbortStreamCleanup
# ---------------------------------------------------------------------------


class TestAbortStreamCleanup:
    """Early-return paths in generate_rtsp_mjpeg_stream must release the TLS
    proxy and disconnect-event registration (regression: leaked one listening
    socket per failed grid retry — and the retry loop runs forever)."""

    @pytest.mark.asyncio
    async def test_ffmpeg_not_found_releases_proxy_and_event(self):
        import asyncio
        from unittest.mock import AsyncMock, MagicMock

        import backend.app.api.routes.camera as cam

        fake_proxy_server = AsyncMock()
        fake_proxy_server.close = MagicMock()
        disconnect_event = asyncio.Event()

        with (
            patch("backend.app.api.routes.camera.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"),
            patch("backend.app.api.routes.camera.get_camera_port", return_value=322),
            patch("backend.app.api.routes.camera.create_tls_proxy", return_value=(12345, fake_proxy_server)),
            patch("backend.app.api.routes.camera.rtsp_socket_timeout_flag", return_value="timeout"),
            patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError),
        ):
            frames = [
                chunk
                async for chunk in cam.generate_rtsp_mjpeg_stream(
                    "192.168.1.1",
                    "code",
                    "X1C",
                    fps=5,
                    stream_id="1-aborttest",
                    printer_id=1,
                    disconnect_event=disconnect_event,
                )
            ]

        assert any(b"ffmpeg not installed" in f for f in frames)
        fake_proxy_server.close.assert_called_once()
        fake_proxy_server.wait_closed.assert_awaited()
        assert "1-aborttest" not in cam._disconnect_events

    @pytest.mark.asyncio
    async def test_immediate_ffmpeg_failure_releases_proxy_and_state(self):
        import asyncio
        from unittest.mock import AsyncMock, MagicMock

        import backend.app.api.routes.camera as cam

        fake_proxy_server = AsyncMock()
        fake_proxy_server.close = MagicMock()
        disconnect_event = asyncio.Event()

        class _FakeStderr:
            async def read(self, n=-1):
                return b"Error opening input: Connection refused"

        class _FakeProcess:
            pid = 999_991
            returncode = 1
            stderr = _FakeStderr()

        with (
            patch("backend.app.api.routes.camera.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"),
            patch("backend.app.api.routes.camera.get_camera_port", return_value=322),
            patch("backend.app.api.routes.camera.create_tls_proxy", return_value=(12345, fake_proxy_server)),
            patch("backend.app.api.routes.camera.rtsp_socket_timeout_flag", return_value="timeout"),
            patch("asyncio.create_subprocess_exec", return_value=_FakeProcess()),
        ):
            frames = [
                chunk
                async for chunk in cam.generate_rtsp_mjpeg_stream(
                    "192.168.1.1",
                    "code",
                    "X1C",
                    fps=5,
                    stream_id="1-aborttest2",
                    printer_id=1,
                    disconnect_event=disconnect_event,
                )
            ]

        assert any(b"Camera connection failed" in f for f in frames)
        fake_proxy_server.close.assert_called_once()
        fake_proxy_server.wait_closed.assert_awaited()
        assert "1-aborttest2" not in cam._disconnect_events
        assert "1-aborttest2" not in cam._state.active_streams
        assert 999_991 not in cam._state.spawned_ffmpeg_pids


# ---------------------------------------------------------------------------
# TestGridStreamGenerateLoop
# ---------------------------------------------------------------------------


class _StubRequest:
    """Minimal stand-in for fastapi.Request exposing only is_disconnected().

    Returns False for the first ``disconnect_after`` calls, then True.
    """

    def __init__(self, disconnect_after: int = 1):
        self._calls = 0
        self._disconnect_after = disconnect_after

    async def is_disconnected(self) -> bool:
        self._calls += 1
        return self._calls > self._disconnect_after


class _FakeTime:
    """Proxies the stdlib ``time`` module but makes ``monotonic()`` advance by
    a fixed step on every call.

    generate()'s disconnect check is throttled to "once per real second"
    (``now - last_disconnect_check > 1.0``). With a step bigger than 1.0,
    every single loop iteration's ``now = time.monotonic()`` call is far
    enough past the previous one to re-trigger that check deterministically,
    with zero real sleeping required.
    """

    def __init__(self, start: float = 1_000_000.0, step: float = 1.5):
        self._t = start
        self._step = step

    def monotonic(self) -> float:
        self._t += self._step
        return self._t

    def __getattr__(self, name):
        return getattr(time, name)


class _FakeSessionCtx:
    """Stand-in for ``async with database.async_session() as db: ...``.

    Neither test below reaches a real query (get_existing_batch is
    monkeypatched to hand back an already-live producer), so the session
    object itself is never touched.
    """

    async def __aenter__(self):
        from unittest.mock import AsyncMock

        return AsyncMock()

    async def __aexit__(self, exc_type, exc, tb):
        return False


class TestGridStreamGenerateLoop:
    """Drives camera_grid_stream()'s generate() closure directly (T-132).

    TestCameraGridStreamValidation (integration) never reaches the
    StreamingResponse body: every one of its scenarios 400/401/404s before
    entries is non-empty. These tests call the route coroutine directly with
    a stub Request and a patched hub/async_session/clock so they can step
    generate() one ``__anext__()`` at a time.
    """

    @staticmethod
    def _live_entry(frame: bytes = b"\xff\xd8fake-jpeg-bytes\xff\xd9"):
        from backend.app.api.routes.camera import _SharedStream

        entry = _SharedStream(params_key="200-15-0.5-0-False-False")
        entry.alive = True
        entry.frame = frame
        entry.frame_seq = 1
        # Far in the "future" relative to the fake clock's starting point so
        # the "no frame for 30s" stale-producer check inside generate() never
        # fires for this entry.
        entry.last_frame_produced = 2_000_000.0
        return entry

    @pytest.mark.asyncio
    async def test_one_frame_then_disconnect_resets_viewer_count(self):
        """One live producer: a single frame is yielded with the exact binary
        framing, then is_disconnected() flips True and the generator's
        finally block (disconnect cleanup) returns viewer_count to 0."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid = 7001
        entry = self._live_entry()
        request = _StubRequest(disconnect_after=1)

        with (
            patch(
                "backend.app.api.routes.camera._hub.get_existing_batch", new=AsyncMock(return_value=({pid: entry}, []))
            ),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
            patch("backend.app.api.routes.camera.time", _FakeTime()),
        ):
            resp = await cam.camera_grid_stream(
                request, ids=str(pid), fps=200, quality=15, scale=0.5, force=False, api_key=None
            )

            # generate() is an async generator function: calling it just builds
            # the generator object, it doesn't run any of its body (including
            # the viewer_count += 1 registration) until the first __anext__().
            assert entry.viewer_count == 0

            chunk = await resp.body_iterator.__anext__()
            expected = struct.pack("<II", pid, len(entry.frame)) + entry.frame
            assert chunk == expected

            # Now that the generator has run up to its first yield, the
            # viewer-registration step has executed.
            assert entry.viewer_count == 1

            # Second poll: is_disconnected() now returns True -> the loop
            # breaks and the finally block runs, ending the generator.
            with pytest.raises(StopAsyncIteration):
                await resp.body_iterator.__anext__()

        assert entry.viewer_count == 0

    @pytest.mark.asyncio
    async def test_dead_producer_mid_loop_schedules_restart_without_crashing(self):
        """One dead producer alongside one live one: the dead entry must be
        dropped from `entries` and scheduled for a backoff restart — not raise,
        and not have a replacement producer created on the very next cycle
        (the scheduled retry time is still in the future). A second, live
        entry is kept alongside it purely so the generator still hits a
        `yield` (letting the test inspect its suspended frame) instead of
        running the whole dead-only case to completion in one opaque hop."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_dead = 7002
        pid_alive = 7003
        entry_dead = self._live_entry()
        entry_dead.alive = False  # producer died between get_existing_batch and generate()
        entry_alive = self._live_entry()
        request = _StubRequest(disconnect_after=1)

        # Dead entry first so it is popped from `entries` and queued for
        # restart *before* the loop reaches the live entry's `yield` below —
        # letting us inspect that scheduling from the still-suspended frame.
        batch_result = ({pid_dead: entry_dead, pid_alive: entry_alive}, [])

        old_killed = cam._state.watchdog_killed_printers.copy()
        try:
            with (
                patch(
                    "backend.app.api.routes.camera._hub.get_existing_batch",
                    new=AsyncMock(return_value=batch_result),
                ),
                patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.time", _FakeTime()),
                patch("backend.app.api.routes.camera._ensure_producer", new=AsyncMock()) as mock_ensure,
            ):
                resp = await cam.camera_grid_stream(
                    request, ids=f"{pid_dead},{pid_alive}", fps=200, quality=15, scale=0.5, force=False, api_key=None
                )

                # Nothing has run yet — generate() only executes up to its
                # first yield once driven.
                assert entry_dead.viewer_count == 0
                assert entry_alive.viewer_count == 0

                # First frame comes from the still-alive entry; the dead one
                # never yields anything.
                chunk = await resp.body_iterator.__anext__()
                expected = struct.pack("<II", pid_alive, len(entry_alive.frame)) + entry_alive.frame
                assert chunk == expected

                # Both entries were registered as viewers before the loop
                # started inspecting them for aliveness.
                assert entry_dead.viewer_count == 1
                assert entry_alive.viewer_count == 1

                # The generator is suspended at that `yield`, so its frame is
                # still alive — inspect the restart bookkeeping directly to
                # confirm the dead producer landed in the scheduling path
                # rather than crashing the loop.
                local_vars = resp.body_iterator.ag_frame.f_locals
                assert pid_dead in local_vars["pending_restarts"]
                assert pid_dead not in local_vars["entries"]
                assert pid_alive in local_vars["entries"]
                mock_ensure.assert_not_called()  # retry time is still in the future

                # Second poll: is_disconnected() now returns True -> the loop
                # breaks and the finally block runs, ending the generator.
                with pytest.raises(StopAsyncIteration):
                    await resp.body_iterator.__anext__()

            mock_ensure.assert_not_called()
        finally:
            cam._state.watchdog_killed_printers.clear()
            cam._state.watchdog_killed_printers.update(old_killed)

        assert entry_dead.viewer_count == 0
        assert entry_alive.viewer_count == 0

    @staticmethod
    def _incrementing_entry(frame: bytes = b"\xff\xd8helper-jpeg\xff\xd9"):
        """A live entry whose ``frame_seq`` increments on every read.

        A plain ``_live_entry()`` only ever looks "new" once — after generate()
        sends its one frame, ``seen_seqs`` catches up and it never yields
        again. Since generate() is a single continuous coroutine that only
        returns control to the caller's ``__anext__()`` at a ``yield``, a test
        that needs to step through several outer-loop passes (to advance the
        fake clock past a restart's ``next_retry``) needs *something* to yield
        on every single pass. This entry does that, purely as a test harness
        device — its incrementing counter is never inspected for content.
        """
        from backend.app.api.routes.camera import _SharedStream

        class _IncrementingFrameEntry(_SharedStream):
            __slots__ = ("_seq_counter",)

            def __init__(self) -> None:
                super().__init__(params_key="incrementing-helper")
                self._seq_counter = 0

            @property
            def frame_seq(self):
                self._seq_counter += 1
                return self._seq_counter

            @frame_seq.setter
            def frame_seq(self, _value):
                pass  # base __init__ assigns frame_seq = 0; nothing to store

        entry = _IncrementingFrameEntry()
        entry.alive = True
        entry.frame = frame
        entry.last_frame_produced = 2_000_000.0
        return entry

    @pytest.mark.asyncio
    async def test_restart_executes_after_next_retry_elapses(self):
        """Once the fake clock advances past a pending restart's ``next_retry``,
        generate() must actually call ``_ensure_producer`` again, replace the
        dead entry in ``entries``/``registered_entries``, record
        ``restart_history``, and decrement the old entry's viewer_count."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_dead = 7010
        pid_helper = 7011
        entry_dead = self._live_entry()
        entry_dead.alive = False
        entry_helper = self._incrementing_entry()
        new_entry = self._live_entry(frame=b"\xff\xd8replacement\xff\xd9")

        batch_result = ({pid_dead: entry_dead, pid_helper: entry_helper}, [])
        # _FakeTime's default step (1.5) exactly matches _GRID_RESTART_BASE_DELAY,
        # so the restart becomes due within the first couple of iterations.
        # disconnect_after is set high — the test ends the generator with
        # aclose() instead of driving it all the way to a disconnect.
        request = _StubRequest(disconnect_after=1000)

        old_killed = cam._state.watchdog_killed_printers.copy()
        old_cooldown = cam._state.per_printer_cooldown.copy()
        old_fleet_cooldown = cam._state.fleet_cooldown_until
        # Other test classes in this module (e.g. TestFleetCpuWatchdog) can
        # leave a real-clock fleet cooldown in place; reset it so this test's
        # restart-processing isn't skipped by an unrelated leftover cooldown.
        cam._state.fleet_cooldown_until = 0.0
        try:
            with (
                patch(
                    "backend.app.api.routes.camera._hub.get_existing_batch",
                    new=AsyncMock(return_value=batch_result),
                ),
                patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.time", _FakeTime()),
                patch(
                    "backend.app.api.routes.camera._resolve_quality_from_settings",
                    new=AsyncMock(return_value=(200, 15, 0.5, 0, False, False, "custom")),
                ),
                patch(
                    "backend.app.api.routes.camera._ensure_producer", new=AsyncMock(return_value=new_entry)
                ) as mock_ensure,
            ):
                resp = await cam.camera_grid_stream(
                    request,
                    ids=f"{pid_dead},{pid_helper}",
                    fps=200,
                    quality=15,
                    scale=0.5,
                    force=False,
                    api_key=None,
                )

                # Step the loop, one outer-loop pass per __anext__() call (the
                # incrementing helper forces a yield every pass), until the
                # dead entry has been replaced by the restarted producer.
                local_vars = {}
                for _ in range(20):
                    await resp.body_iterator.__anext__()
                    local_vars = resp.body_iterator.ag_frame.f_locals
                    if local_vars["entries"].get(pid_dead) is new_entry:
                        break
                else:
                    pytest.fail("restart was never executed within 20 outer-loop iterations")

                assert local_vars["registered_entries"][pid_dead] is new_entry
                assert pid_dead not in local_vars["pending_restarts"]
                assert local_vars["restart_history"][pid_dead][0] == 1
                mock_ensure.assert_called_once()
                assert mock_ensure.call_args.args[0] == pid_dead
                assert entry_dead.viewer_count == 0  # decremented on replacement
                assert new_entry.viewer_count == 1

                # Close the generator directly (equivalent to a disconnect)
                # so the finally block resets viewer counts.
                await resp.body_iterator.aclose()
        finally:
            cam._state.watchdog_killed_printers.clear()
            cam._state.watchdog_killed_printers.update(old_killed)
            cam._state.per_printer_cooldown.clear()
            cam._state.per_printer_cooldown.update(old_cooldown)
            cam._state.fleet_cooldown_until = old_fleet_cooldown

        assert entry_dead.viewer_count == 0
        assert new_entry.viewer_count == 0
        assert entry_helper.viewer_count == 0

    @pytest.mark.asyncio
    async def test_fleet_cooldown_skips_pending_restarts(self):
        """While ``_state.fleet_cooldown_until`` is in the future, generate()
        must skip the whole restart-processing loop for every pending
        restart — ``_ensure_producer`` must never be called during an active
        fleet cooldown, and the pending restart's attempt count must stay
        untouched."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_dead = 7020
        pid_helper = 7021
        entry_dead = self._live_entry()
        entry_dead.alive = False
        entry_helper = self._incrementing_entry()

        batch_result = ({pid_dead: entry_dead, pid_helper: entry_helper}, [])
        request = _StubRequest(disconnect_after=1000)

        old_cooldown_until = cam._state.fleet_cooldown_until
        old_killed = cam._state.watchdog_killed_printers.copy()
        # Far beyond anything the fake clock (default step 1.5) reaches in a
        # handful of iterations.
        cam._state.fleet_cooldown_until = 5_000_000.0
        try:
            with (
                patch(
                    "backend.app.api.routes.camera._hub.get_existing_batch",
                    new=AsyncMock(return_value=batch_result),
                ),
                patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.time", _FakeTime()),
                patch("backend.app.api.routes.camera._ensure_producer", new=AsyncMock()) as mock_ensure,
            ):
                resp = await cam.camera_grid_stream(
                    request,
                    ids=f"{pid_dead},{pid_helper}",
                    fps=200,
                    quality=15,
                    scale=0.5,
                    force=False,
                    api_key=None,
                )

                # Iteration 1 schedules the restart; several more all fall
                # inside the (far-future) fleet cooldown window.
                local_vars = {}
                for _ in range(5):
                    await resp.body_iterator.__anext__()
                    local_vars = resp.body_iterator.ag_frame.f_locals

                assert pid_dead in local_vars["pending_restarts"]
                assert local_vars["pending_restarts"][pid_dead][0] == 0  # attempt count untouched
                mock_ensure.assert_not_called()

                await resp.body_iterator.aclose()

            mock_ensure.assert_not_called()
        finally:
            cam._state.fleet_cooldown_until = old_cooldown_until
            cam._state.watchdog_killed_printers.clear()
            cam._state.watchdog_killed_printers.update(old_killed)

        assert entry_dead.viewer_count == 0
        assert entry_helper.viewer_count == 0

    @pytest.mark.asyncio
    async def test_slow_retry_cadence_after_max_restarts_without_giving_up(self):
        """Once a pending restart's attempt count reaches ``_GRID_MAX_RESTARTS``,
        generate() must stop calling ``_ensure_producer`` for that cycle and
        instead reschedule at the (jittered) slow-retry base delay — it must
        never permanently give up on the printer."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_dead = 7030
        pid_helper = 7031
        entry_dead = self._live_entry()
        entry_dead.alive = False
        entry_helper = self._incrementing_entry()

        batch_result = ({pid_dead: entry_dead, pid_helper: entry_helper}, [])
        # A step bigger than the largest possible ordinary backoff delay
        # (_GRID_RESTART_MAX_DELAY * 1.3 = 26s) guarantees every outer-loop
        # iteration's restart-processing lands past the previous cycle's
        # next_retry, so each iteration after the first drives exactly one
        # restart attempt.
        fake_time = _FakeTime(step=30.0)
        request = _StubRequest(disconnect_after=1000)

        old_killed = cam._state.watchdog_killed_printers.copy()
        old_cooldown = cam._state.per_printer_cooldown.copy()
        old_fleet_cooldown = cam._state.fleet_cooldown_until
        # Other test classes in this module (e.g. TestFleetCpuWatchdog) can
        # leave a real-clock fleet cooldown in place; reset it so this test's
        # restart-processing isn't skipped by an unrelated leftover cooldown.
        cam._state.fleet_cooldown_until = 0.0
        try:
            with (
                patch(
                    "backend.app.api.routes.camera._hub.get_existing_batch",
                    new=AsyncMock(return_value=batch_result),
                ),
                patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.time", fake_time),
                patch(
                    "backend.app.api.routes.camera._resolve_quality_from_settings",
                    new=AsyncMock(return_value=(200, 15, 0.5, 0, False, False, "custom")),
                ),
                patch(
                    "backend.app.api.routes.camera._ensure_producer", new=AsyncMock(return_value=None)
                ) as mock_ensure,
            ):
                resp = await cam.camera_grid_stream(
                    request,
                    ids=f"{pid_dead},{pid_helper}",
                    fps=200,
                    quality=15,
                    scale=0.5,
                    force=False,
                    api_key=None,
                )

                # Step the loop until a failed restart attempt has pushed the
                # attempt count up to _GRID_MAX_RESTARTS (each failed
                # _ensure_producer call increments it by exactly one).
                attempts = -1
                now_before = None
                for _ in range(30):
                    await resp.body_iterator.__anext__()
                    local_vars = resp.body_iterator.ag_frame.f_locals
                    attempts, _next_retry = local_vars["pending_restarts"][pid_dead]
                    now_before = local_vars["now"]
                    if attempts >= cam._GRID_MAX_RESTARTS:
                        break
                else:
                    pytest.fail("attempts never reached _GRID_MAX_RESTARTS within 30 outer-loop iterations")

                assert attempts == cam._GRID_MAX_RESTARTS
                assert mock_ensure.call_count == cam._GRID_MAX_RESTARTS

                # The next iteration's restart-processing hits the
                # attempts >= _GRID_MAX_RESTARTS branch: no producer call,
                # cadence resets to the base slow-retry delay with jitter,
                # and the printer stays pending rather than being dropped.
                await resp.body_iterator.__anext__()

                local_vars = resp.body_iterator.ag_frame.f_locals
                new_attempts, next_retry_after = local_vars["pending_restarts"][pid_dead]
                assert new_attempts == cam._GRID_MAX_RESTARTS + 1
                assert mock_ensure.call_count == cam._GRID_MAX_RESTARTS  # unchanged: no new producer call
                delay = next_retry_after - now_before
                assert cam._GRID_RESTART_MAX_DELAY <= delay <= cam._GRID_RESTART_MAX_DELAY * 1.3 + 1e-6

                # Close the generator directly (equivalent to a disconnect)
                # so the finally block resets viewer counts.
                await resp.body_iterator.aclose()
        finally:
            cam._state.watchdog_killed_printers.clear()
            cam._state.watchdog_killed_printers.update(old_killed)
            cam._state.per_printer_cooldown.clear()
            cam._state.per_printer_cooldown.update(old_cooldown)
            cam._state.fleet_cooldown_until = old_fleet_cooldown

        assert entry_dead.viewer_count == 0
        assert entry_helper.viewer_count == 0


class _CountingSessionCtx:
    """``async_session()`` stand-in that counts how many sessions are open."""

    def __init__(self, state: dict):
        self._state = state

    async def __aenter__(self):
        from unittest.mock import AsyncMock

        self._state["open"] += 1
        return AsyncMock()

    async def __aexit__(self, exc_type, exc, tb):
        self._state["open"] -= 1
        return False


class TestGridStreamBackgroundRestarts:
    """T-013: producer restarts run as background tasks tracked per connection,
    so one camera restarting never stalls the frames of the healthy tiles."""

    @pytest.fixture(autouse=True)
    def _isolate_restart_state(self):
        import backend.app.api.routes.camera as cam

        old_killed = cam._state.watchdog_killed_printers.copy()
        old_cooldown = cam._state.per_printer_cooldown.copy()
        old_fleet_cooldown = cam._state.fleet_cooldown_until
        cam._state.fleet_cooldown_until = 0.0
        yield
        cam._state.watchdog_killed_printers.clear()
        cam._state.watchdog_killed_printers.update(old_killed)
        cam._state.per_printer_cooldown.clear()
        cam._state.per_printer_cooldown.update(old_cooldown)
        cam._state.fleet_cooldown_until = old_fleet_cooldown

    @staticmethod
    def _patches(batch_result, ensure, session_factory, fake_time=None):
        from unittest.mock import AsyncMock

        return (
            patch("backend.app.api.routes.camera._hub.get_existing_batch", new=AsyncMock(return_value=batch_result)),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
            patch("backend.app.api.routes.camera.async_session", side_effect=session_factory),
            patch("backend.app.api.routes.camera.time", fake_time or _FakeTime()),
            patch(
                "backend.app.api.routes.camera._resolve_quality_from_settings",
                new=AsyncMock(return_value=(200, 15, 0.5, 0, False, False, "custom")),
            ),
            patch("backend.app.api.routes.camera._ensure_producer", new=ensure),
        )

    @staticmethod
    async def _open(ids):
        import backend.app.api.routes.camera as cam

        return await cam.camera_grid_stream(
            _StubRequest(disconnect_after=1000),
            ids=",".join(map(str, ids)),
            fps=200,
            quality=15,
            scale=0.5,
            force=False,
            api_key=None,
        )

    @pytest.mark.asyncio
    async def test_slow_restart_does_not_block_healthy_tiles(self):
        """(a) While one printer's restart is stuck in _ensure_producer, the
        healthy printer on the same wall keeps yielding frames."""
        import asyncio
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        pid_dead, pid_healthy = 7501, 7502
        entry_dead = TestGridStreamGenerateLoop._live_entry()
        entry_dead.alive = False
        entry_healthy = TestGridStreamGenerateLoop._incrementing_entry()
        gate = asyncio.Event()

        async def slow_ensure(*_args, **_kwargs):
            await gate.wait()
            return None

        sessions = {"open": 0}
        ensure = AsyncMock(side_effect=slow_ensure)
        with ExitStack() as stack:
            for p in self._patches(
                ({pid_dead: entry_dead, pid_healthy: entry_healthy}, []), ensure, lambda: _CountingSessionCtx(sessions)
            ):
                stack.enter_context(p)
            resp = await self._open([pid_dead, pid_healthy])

            # Step until the restart is in flight.
            for _ in range(10):
                await resp.body_iterator.__anext__()
                if pid_dead in resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks:
                    break
            else:
                pytest.fail("restart task was never spawned")

            # The restart stays blocked, yet the healthy tile keeps streaming.
            for _ in range(5):
                chunk = await resp.body_iterator.__anext__()
                assert struct.unpack("<I", chunk[:4])[0] == pid_healthy
            local_vars = resp.body_iterator.ag_frame.f_locals
            task, _attempts, _started = local_vars["conn"].restart_tasks[pid_dead]
            assert not task.done()
            assert pid_dead in local_vars["pending_restarts"]
            assert ensure.call_count == 1  # an in-flight printer is never re-spawned
            assert sessions["open"] == 1

            await resp.body_iterator.aclose()

        assert task.cancelled()
        assert sessions["open"] == 0
        assert entry_healthy.viewer_count == 0

    @pytest.mark.asyncio
    async def test_restarted_entry_is_adopted_and_its_frames_flow(self):
        """(b) Once the background restart completes, a later pass adopts the
        new producer exactly like the inline code did, and its frames flow."""
        import asyncio
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        pid_dead, pid_healthy = 7511, 7512
        entry_dead = TestGridStreamGenerateLoop._live_entry()
        entry_dead.alive = False
        entry_healthy = TestGridStreamGenerateLoop._incrementing_entry()
        new_entry = TestGridStreamGenerateLoop._live_entry(frame=b"\xff\xd8restarted\xff\xd9")
        gate = asyncio.Event()

        async def gated_ensure(*_args, **_kwargs):
            await gate.wait()
            return new_entry

        sessions = {"open": 0}
        with ExitStack() as stack:
            for p in self._patches(
                ({pid_dead: entry_dead, pid_healthy: entry_healthy}, []),
                AsyncMock(side_effect=gated_ensure),
                lambda: _CountingSessionCtx(sessions),
            ):
                stack.enter_context(p)
            resp = await self._open([pid_dead, pid_healthy])

            for _ in range(10):
                await resp.body_iterator.__anext__()
                if pid_dead in resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks:
                    break
            else:
                pytest.fail("restart task was never spawned")
            started_at = resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks[pid_dead][2]
            assert new_entry.viewer_count == 0  # not adopted while in flight

            gate.set()
            restarted_frames = []
            for _ in range(10):
                chunk = await resp.body_iterator.__anext__()
                if struct.unpack("<I", chunk[:4])[0] == pid_dead:
                    restarted_frames.append(chunk)
                    break
            assert restarted_frames == [struct.pack("<II", pid_dead, len(new_entry.frame)) + new_entry.frame]

            local_vars = resp.body_iterator.ag_frame.f_locals
            assert local_vars["entries"][pid_dead] is new_entry
            assert local_vars["registered_entries"][pid_dead] is new_entry
            assert pid_dead not in local_vars["pending_restarts"]
            assert pid_dead not in local_vars["conn"].restart_tasks
            assert local_vars["restart_history"][pid_dead] == (1, started_at)
            assert entry_dead.viewer_count == 0
            assert new_entry.viewer_count == 1
            assert sessions["open"] == 0

            await resp.body_iterator.aclose()

        assert new_entry.viewer_count == 0

    @pytest.mark.asyncio
    async def test_restarts_in_flight_are_capped(self):
        """(c) No more than _GRID_MAX_CONCURRENT_RESTARTS restart tasks run at
        once; the rest wait for a slot."""
        import asyncio
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        dead_pids = list(range(7521, 7521 + cam._GRID_MAX_CONCURRENT_RESTARTS + 2))
        pid_healthy = 7520
        batch = {}
        for pid in dead_pids:
            e = TestGridStreamGenerateLoop._live_entry()
            e.alive = False
            batch[pid] = e
        batch[pid_healthy] = TestGridStreamGenerateLoop._incrementing_entry()
        gate = asyncio.Event()

        async def slow_ensure(*_args, **_kwargs):
            await gate.wait()
            return None

        ensure = AsyncMock(side_effect=slow_ensure)
        sessions = {"open": 0}
        with ExitStack() as stack:
            for p in self._patches((batch, []), ensure, lambda: _CountingSessionCtx(sessions)):
                stack.enter_context(p)
            resp = await self._open([*dead_pids, pid_healthy])

            for _ in range(15):
                await resp.body_iterator.__anext__()
                assert len(resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks) <= (
                    cam._GRID_MAX_CONCURRENT_RESTARTS
                )
            assert len(resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks) == (
                cam._GRID_MAX_CONCURRENT_RESTARTS
            )
            assert ensure.call_count == cam._GRID_MAX_CONCURRENT_RESTARTS
            assert sessions["open"] == cam._GRID_MAX_CONCURRENT_RESTARTS

            # Releasing the slots lets the waiting printers be spawned.
            gate.set()
            for _ in range(10):
                await resp.body_iterator.__anext__()
                if ensure.call_count > cam._GRID_MAX_CONCURRENT_RESTARTS:
                    break
            else:
                pytest.fail("waiting restarts were never spawned after slots freed")

            await resp.body_iterator.aclose()

        assert sessions["open"] == 0

    @pytest.mark.asyncio
    async def test_disconnect_cancels_pending_restart_tasks(self):
        """(d) Closing the stream cancels and awaits in-flight restarts: the
        task is cancelled, its DB session is closed, nothing is left tracked."""
        import asyncio
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        pid_dead, pid_healthy = 7531, 7532
        entry_dead = TestGridStreamGenerateLoop._live_entry()
        entry_dead.alive = False
        entry_healthy = TestGridStreamGenerateLoop._incrementing_entry()
        cancelled = asyncio.Event()

        async def never_finishes(*_args, **_kwargs):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        sessions = {"open": 0}
        with ExitStack() as stack:
            for p in self._patches(
                ({pid_dead: entry_dead, pid_healthy: entry_healthy}, []),
                AsyncMock(side_effect=never_finishes),
                lambda: _CountingSessionCtx(sessions),
            ):
                stack.enter_context(p)
            resp = await self._open([pid_dead, pid_healthy])
            for _ in range(10):
                await resp.body_iterator.__anext__()
                if pid_dead in resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks:
                    break
            else:
                pytest.fail("restart task was never spawned")
            conn = resp.body_iterator.ag_frame.f_locals["conn"]
            task = conn.restart_tasks[pid_dead][0]
            # Let the task reach _ensure_producer so the session is open.
            for _ in range(3):
                await asyncio.sleep(0)
            assert sessions["open"] == 1

            await resp.body_iterator.aclose()

        assert task.done() and task.cancelled()
        assert cancelled.is_set()
        assert conn.restart_tasks == {}
        assert sessions["open"] == 0
        assert entry_dead.viewer_count == 0
        assert entry_healthy.viewer_count == 0

    @pytest.mark.asyncio
    async def test_http_disconnect_mid_restart_still_decrements_viewer_counts(self):
        """Regression: through a real Starlette StreamingResponse, a client
        disconnect cancels the response's anyio scope, which re-cancels any
        await in generate()'s ``finally:``. With a restart in flight, the
        viewer-count cleanup must still run (it is synchronous and runs before
        any await), and the cancelled restart must still unwind and close its
        DB session on its own."""
        import asyncio
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        pid_dead, pid_healthy = 7561, 7562
        entry_dead = TestGridStreamGenerateLoop._live_entry()
        entry_dead.alive = False
        entry_healthy = TestGridStreamGenerateLoop._incrementing_entry()
        restart_started = asyncio.Event()
        restart = {}

        async def never_finishes(*_args, **_kwargs):
            restart["task"] = asyncio.current_task()
            restart_started.set()
            await asyncio.Event().wait()

        async def receive():
            await restart_started.wait()
            return {"type": "http.disconnect"}

        async def send(_message):
            pass

        sessions = {"open": 0}
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}}
        with ExitStack() as stack:
            for p in self._patches(
                ({pid_dead: entry_dead, pid_healthy: entry_healthy}, []),
                AsyncMock(side_effect=never_finishes),
                lambda: _CountingSessionCtx(sessions),
            ):
                stack.enter_context(p)
            resp = await self._open([pid_dead, pid_healthy])
            await asyncio.wait_for(resp(scope, receive, send), timeout=10)

            # Viewer counts were released even though the scope was cancelled.
            assert entry_healthy.viewer_count == 0
            assert entry_dead.viewer_count == 0

            task = restart["task"]
            for _ in range(10):
                if task.done():
                    break
                await asyncio.sleep(0)
            assert task.cancelled()
            assert sessions["open"] == 0

    @pytest.mark.asyncio
    async def test_restart_finished_after_close_is_never_registered(self):
        """A restart that completed but was not yet adopted when the viewer
        left is discarded: its producer never gains a viewer from this
        connection, so the hub's idle timeout can reap it."""
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        pid_dead, pid_healthy = 7541, 7542
        entry_dead = TestGridStreamGenerateLoop._live_entry()
        entry_dead.alive = False
        entry_healthy = TestGridStreamGenerateLoop._incrementing_entry()
        new_entry = TestGridStreamGenerateLoop._live_entry()

        with ExitStack() as stack:
            for p in self._patches(
                ({pid_dead: entry_dead, pid_healthy: entry_healthy}, []),
                AsyncMock(return_value=new_entry),
                lambda: _FakeSessionCtx(),
            ):
                stack.enter_context(p)
            resp = await self._open([pid_dead, pid_healthy])
            for _ in range(10):
                await resp.body_iterator.__anext__()
                tasks = resp.body_iterator.ag_frame.f_locals["conn"].restart_tasks
                if pid_dead in tasks and tasks[pid_dead][0].done():
                    break
            else:
                pytest.fail("restart task never finished before being harvested")
            conn = resp.body_iterator.ag_frame.f_locals["conn"]

            await resp.body_iterator.aclose()

        assert conn.restart_tasks == {}
        assert pid_dead not in conn.entries
        assert new_entry.viewer_count == 0
        assert entry_dead.viewer_count == 0

    @pytest.mark.asyncio
    @pytest.mark.parametrize("outcome", ["none", "raises"])
    async def test_failed_restart_task_schedules_backoff(self, outcome, caplog):
        """(e) A failed background restart (None, or an exception logged the
        same way as before) is rescheduled with the unchanged exponential
        backoff, measured from the pass that spawned it."""
        import logging
        from contextlib import ExitStack
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_dead, pid_healthy = 7551, 7552
        entry_dead = TestGridStreamGenerateLoop._live_entry()
        entry_dead.alive = False
        entry_healthy = TestGridStreamGenerateLoop._incrementing_entry()
        ensure = AsyncMock(return_value=None) if outcome == "none" else AsyncMock(side_effect=RuntimeError("boom"))

        with ExitStack() as stack:
            for p in self._patches(
                ({pid_dead: entry_dead, pid_healthy: entry_healthy}, []), ensure, lambda: _FakeSessionCtx()
            ):
                stack.enter_context(p)
            caplog.set_level(logging.WARNING, logger=cam.logger.name)
            resp = await self._open([pid_dead, pid_healthy])
            spawned = None
            for _ in range(10):
                await resp.body_iterator.__anext__()
                local_vars = resp.body_iterator.ag_frame.f_locals
                tasks = local_vars["conn"].restart_tasks
                if spawned is None and pid_dead in tasks:
                    spawned = tasks[pid_dead]
                    assert local_vars["pending_restarts"][pid_dead][0] == spawned[1]
                elif spawned is not None and pid_dead not in tasks:
                    break
            else:
                pytest.fail("failed restart was never harvested")

            _task, attempts, started_at = spawned
            new_attempts, next_retry = local_vars["pending_restarts"][pid_dead]
            assert new_attempts == attempts + 1
            base_delay = min(cam._GRID_RESTART_BASE_DELAY * (2**attempts), cam._GRID_RESTART_MAX_DELAY)
            assert base_delay <= next_retry - started_at <= base_delay * 1.3 + 1e-6
            assert pid_dead not in local_vars["entries"]
            assert ensure.call_count == 1

            await resp.body_iterator.aclose()

        messages = [r.getMessage() for r in caplog.records]
        assert any(m.startswith(f"Grid restart failed for printer {pid_dead} (attempt 1/") for m in messages)
        assert any(m == f"Grid restart DB/producer error for printer {pid_dead}" for m in messages) == (
            outcome == "raises"
        )


class TestGridStreamAPIKeyPrinterScope:
    """T-165: an API key's ``printer_ids`` allowlist must be honoured by the
    multiplexed grid stream, not just the single-printer camera routes.

    Drives ``camera_grid_stream()`` directly (same idiom as
    ``TestGridStreamGenerateLoop``) so the assertions are on the actual
    StreamingResponse body — the printer allowed by the key is the only one
    whose frame is ever produced, and the disallowed id never reaches
    ``get_existing_batch`` (no producer is ever started for it, matching how
    the frontend already tolerates ids that never yield a frame).
    """

    @staticmethod
    def _live_entry(frame: bytes = b"\xff\xd8fake-jpeg-bytes\xff\xd9"):
        return TestGridStreamGenerateLoop._live_entry(frame)

    @staticmethod
    def _scoped_key(printer_ids):
        from backend.app.models.api_key import APIKey

        return APIKey(
            name="scoped",
            key_hash="x",
            key_prefix="bb_x",
            can_read_status=True,
            printer_ids=printer_ids,
            enabled=True,
        )

    @pytest.mark.asyncio
    async def test_restricted_key_only_streams_the_allowed_printer(self):
        """ids=allowed,disallowed with a key scoped to [allowed] yields only
        the allowed printer's frame, and the disallowed id never reaches
        get_existing_batch at all."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_allowed = 7101
        pid_disallowed = 7102
        entry_allowed = self._live_entry()
        api_key = self._scoped_key([pid_allowed])
        request = _StubRequest(disconnect_after=1)

        captured_ids = []

        async def mock_batch(printer_ids):
            captured_ids.extend(printer_ids)
            return {pid: e for pid, e in {pid_allowed: entry_allowed}.items() if pid in printer_ids}, [
                pid for pid in printer_ids if pid != pid_allowed
            ]

        with (
            patch("backend.app.api.routes.camera._hub.get_existing_batch", new=AsyncMock(side_effect=mock_batch)),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
            patch("backend.app.api.routes.camera.time", _FakeTime()),
        ):
            resp = await cam.camera_grid_stream(
                request,
                ids=f"{pid_allowed},{pid_disallowed}",
                fps=200,
                quality=15,
                scale=0.5,
                force=False,
                api_key=api_key,
            )

            # The disallowed id was dropped before the hub was ever consulted.
            assert captured_ids == [pid_allowed]

            chunk = await resp.body_iterator.__anext__()
            expected = struct.pack("<II", pid_allowed, len(entry_allowed.frame)) + entry_allowed.frame
            assert chunk == expected

            with pytest.raises(StopAsyncIteration):
                await resp.body_iterator.__anext__()

    @pytest.mark.asyncio
    async def test_unrestricted_key_streams_every_requested_printer(self):
        """An API key with printer_ids=None (global key) is byte-identical to
        an unauthenticated/JWT caller — nothing is filtered."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_a = 7103
        pid_b = 7104
        entry_a = self._live_entry()
        entry_b = self._live_entry()
        api_key = self._scoped_key(None)
        request = _StubRequest(disconnect_after=2)

        captured_ids = []

        async def mock_batch(printer_ids):
            captured_ids.extend(printer_ids)
            return {pid_a: entry_a, pid_b: entry_b}, []

        with (
            patch("backend.app.api.routes.camera._hub.get_existing_batch", new=AsyncMock(side_effect=mock_batch)),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
            patch("backend.app.api.routes.camera.time", _FakeTime()),
        ):
            resp = await cam.camera_grid_stream(
                request,
                ids=f"{pid_a},{pid_b}",
                fps=200,
                quality=15,
                scale=0.5,
                force=False,
                api_key=api_key,
            )

            assert captured_ids == [pid_a, pid_b]

            seen = set()
            for _ in range(2):
                chunk = await resp.body_iterator.__anext__()
                seen.add(chunk[:4])
            assert seen == {struct.pack("<I", pid_a), struct.pack("<I", pid_b)}


# ---------------------------------------------------------------------------
# TestGridStreamDoesNotForceProducerRestarts
# ---------------------------------------------------------------------------


class TestGridStreamDoesNotForceProducerRestarts:
    """A grid connect that resolves its params from the quality preset must
    NOT force-restart producers that are already alive.

    The resolved params depend on the caller's own stream count (skip_frames
    flips at 4 printers, "auto" scales with the count), so forcing meant two
    walls watching different subsets — or a wall and a single-camera viewer —
    each restarted the other's producers on connect, and then kept doing so
    from the dead-producer restart path: alternating ~20s live / ~20s black
    per viewer, with ffmpeg respawning every cycle.
    """

    @staticmethod
    def _alive_entry(params_key: str):
        from backend.app.api.routes.camera import _SharedStream

        entry = _SharedStream(params_key=params_key)
        entry.alive = True
        entry.frame = b"\xff\xd8other-viewer-jpeg\xff\xd9"
        entry.frame_seq = 1
        entry.last_frame_produced = 2_000_000.0
        return entry

    @pytest.mark.asyncio
    async def test_preset_connect_reuses_alive_producer_with_different_params(self):
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid = 7301
        # Started by another viewer with params resolved for ITS stream count.
        other_viewers_entry = self._alive_entry("5-15-0.5-0-True-True")
        request = _StubRequest(disconnect_after=1)

        with (
            patch(
                "backend.app.api.routes.camera._hub.get_existing_batch",
                new=AsyncMock(return_value=({pid: other_viewers_entry}, [])),
            ),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
            patch("backend.app.api.routes.camera.time", _FakeTime()),
            patch(
                "backend.app.api.routes.camera._resolve_quality_from_settings",
                # This caller resolves to different params (skip_frames=False).
                new=AsyncMock(return_value=(5, 15, 0.5, 0, True, False, "medium")),
            ),
            patch("backend.app.api.routes.camera._ensure_producer", new=AsyncMock()) as mock_ensure,
        ):
            resp = await cam.camera_grid_stream(
                request, ids=str(pid), fps=None, quality=None, scale=None, force=False, api_key=None
            )
            chunk = await resp.body_iterator.__anext__()
            assert chunk[:4] == struct.pack("<I", pid)
            with pytest.raises(StopAsyncIteration):
                await resp.body_iterator.__anext__()

        # The other viewer's producer was adopted as-is — never restarted.
        mock_ensure.assert_not_called()
        assert other_viewers_entry.alive is True

    @pytest.mark.asyncio
    async def test_explicit_force_query_param_still_restarts(self):
        """``?force=true`` remains the explicit opt-in for a restart."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid = 7302
        entry = self._alive_entry("5-15-0.5-0-True-True")
        request = _StubRequest(disconnect_after=1)

        with (
            patch(
                "backend.app.api.routes.camera._hub.get_existing_batch",
                new=AsyncMock(return_value=({pid: entry}, [])),
            ),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
            patch("backend.app.api.routes.camera.time", _FakeTime()),
            patch(
                "backend.app.api.routes.camera._resolve_quality_from_settings",
                new=AsyncMock(return_value=(5, 15, 0.5, 0, True, False, "medium")),
            ),
            patch("backend.app.api.routes.camera._ensure_producer", new=AsyncMock(return_value=entry)) as mock_ensure,
        ):
            resp = await cam.camera_grid_stream(
                request, ids=str(pid), fps=None, quality=None, scale=None, force=True, _=None, api_key=None
            )
            await resp.body_iterator.__anext__()
            with pytest.raises(StopAsyncIteration):
                await resp.body_iterator.__anext__()

        mock_ensure.assert_called_once()
        assert mock_ensure.call_args.kwargs["force_quality"] is True

    @pytest.mark.asyncio
    async def test_dead_producer_restart_does_not_force(self):
        """The in-loop restart of a dead producer must adopt a replacement
        another viewer may already have started, instead of forcing its own
        params on it (the other half of the ping-pong)."""
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        pid_dead = 7303
        pid_helper = 7304
        entry_dead = self._alive_entry("200-15-0.5-0-False-False")
        entry_dead.alive = False
        entry_helper = TestGridStreamGenerateLoop._incrementing_entry()
        new_entry = self._alive_entry("200-15-0.5-0-False-False")
        request = _StubRequest(disconnect_after=1000)

        old_killed = cam._state.watchdog_killed_printers.copy()
        old_cooldown = cam._state.per_printer_cooldown.copy()
        old_fleet_cooldown = cam._state.fleet_cooldown_until
        cam._state.fleet_cooldown_until = 0.0
        try:
            with (
                patch(
                    "backend.app.api.routes.camera._hub.get_existing_batch",
                    new=AsyncMock(return_value=({pid_dead: entry_dead, pid_helper: entry_helper}, [])),
                ),
                patch("backend.app.api.routes.camera.database.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.async_session", return_value=_FakeSessionCtx()),
                patch("backend.app.api.routes.camera.time", _FakeTime()),
                patch(
                    "backend.app.api.routes.camera._resolve_quality_from_settings",
                    new=AsyncMock(return_value=(200, 15, 0.5, 0, False, False, "custom")),
                ),
                patch(
                    "backend.app.api.routes.camera._ensure_producer", new=AsyncMock(return_value=new_entry)
                ) as mock_ensure,
            ):
                resp = await cam.camera_grid_stream(
                    request,
                    ids=f"{pid_dead},{pid_helper}",
                    fps=200,
                    quality=15,
                    scale=0.5,
                    force=False,
                    api_key=None,
                )
                for _ in range(20):
                    await resp.body_iterator.__anext__()
                    if resp.body_iterator.ag_frame.f_locals["entries"].get(pid_dead) is new_entry:
                        break
                else:
                    pytest.fail("restart was never executed within 20 outer-loop iterations")
                await resp.body_iterator.aclose()
        finally:
            cam._state.watchdog_killed_printers.clear()
            cam._state.watchdog_killed_printers.update(old_killed)
            cam._state.per_printer_cooldown.clear()
            cam._state.per_printer_cooldown.update(old_cooldown)
            cam._state.fleet_cooldown_until = old_fleet_cooldown

        mock_ensure.assert_called_once()
        assert mock_ensure.call_args.args[0] == pid_dead
        assert mock_ensure.call_args.kwargs.get("force_quality", False) is False


class TestGridStreamSpawnOutsideSession:
    """Cold-connect producer spawning must not pin the pooled DB connection
    for the whole stagger, and must stop once the client has gone away."""

    @pytest.mark.asyncio
    async def test_spawn_loop_runs_after_the_session_closed_and_stops_when_client_leaves(self):
        from unittest.mock import AsyncMock, MagicMock

        import backend.app.api.routes.camera as cam

        pids = [7401, 7402, 7403]
        printers = {}
        for pid in pids:
            p = MagicMock()
            p.id = pid
            printers[pid] = p

        session_state = {"open": False, "spawned_while_open": []}

        class _TrackingSessionCtx:
            async def __aenter__(self):
                session_state["open"] = True
                db = AsyncMock()
                result = MagicMock()
                result.scalars.return_value.all.return_value = list(printers.values())
                db.execute = AsyncMock(return_value=result)
                return db

            async def __aexit__(self, exc_type, exc, tb):
                session_state["open"] = False
                return False

        spawned = []

        async def fake_ensure(pid, db, *_args, **kwargs):
            session_state["spawned_while_open"].append(session_state["open"])
            assert db is None  # the printer is passed in; no session needed
            assert kwargs["printer"] is printers[pid]
            spawned.append(pid)
            entry = TestGridStreamGenerateLoop._live_entry()
            return entry

        # Connected for the first spawn, gone by the second stagger check.
        request = _StubRequest(disconnect_after=0)

        with (
            patch("backend.app.api.routes.camera._hub.get_existing_batch", new=AsyncMock(return_value=({}, pids))),
            patch("backend.app.api.routes.camera.database.async_session", return_value=_TrackingSessionCtx()),
            patch("backend.app.api.routes.camera._check_system_load", return_value=0.0),
            patch("backend.app.api.routes.camera.asyncio.sleep", new=AsyncMock()),
            patch("backend.app.api.routes.camera._ensure_producer", new=AsyncMock(side_effect=fake_ensure)),
        ):
            resp = await cam.camera_grid_stream(
                request, ids=",".join(map(str, pids)), fps=200, quality=15, scale=0.5, force=False, api_key=None
            )
            await resp.body_iterator.aclose()

        assert spawned == [pids[0]]  # the disconnect check before #2 stopped the loop
        assert session_state["spawned_while_open"] == [False]


class TestGridStreamLoadGateRefusal:
    """T-011: a cold connect whose every producer the spawn-time load gate
    refuses answers 503 + Retry-After (transient: the wall retries), while
    "no streamable printers" keeps its 404."""

    @staticmethod
    def _printer(pid: int, external: bool = False):
        from unittest.mock import MagicMock

        p = MagicMock()
        p.id = pid
        p.external_camera_enabled = external
        p.external_camera_url = "rtsp://cam.example/stream" if external else None
        p.model = "X1C"
        return p

    @staticmethod
    def _session_returning(printers):
        from unittest.mock import AsyncMock, MagicMock

        class _Ctx:
            async def __aenter__(self):
                db = AsyncMock()
                result = MagicMock()
                result.scalars.return_value.all.return_value = list(printers)
                db.execute = AsyncMock(return_value=result)
                return db

            async def __aexit__(self, exc_type, exc, tb):
                return False

        return _Ctx()

    async def _call(self, pids, printers, **patches):
        from unittest.mock import AsyncMock

        import backend.app.api.routes.camera as cam

        load = patches.pop("load", 0.0)
        ensure = patches.pop("ensure", None)
        ctx = [
            patch("backend.app.api.routes.camera._hub.get_existing_batch", new=AsyncMock(return_value=({}, pids))),
            patch(
                "backend.app.api.routes.camera.database.async_session",
                return_value=self._session_returning(printers),
            ),
            patch("backend.app.api.routes.camera._check_system_load", return_value=load),
            patch("backend.app.api.routes.camera.asyncio.sleep", new=AsyncMock()),
        ]
        if ensure is not None:
            ctx.append(patch("backend.app.api.routes.camera._ensure_producer", new=AsyncMock(side_effect=ensure)))
        for c in ctx:
            c.start()
        try:
            return await cam.camera_grid_stream(
                _StubRequest(disconnect_after=100),
                ids=",".join(map(str, pids)),
                fps=5,
                quality=15,
                scale=0.5,
                force=False,
                api_key=None,
            )
        finally:
            for c in reversed(ctx):
                c.stop()

    @pytest.mark.asyncio
    async def test_load_gate_refusing_every_producer_returns_503_with_retry_after(self):
        from fastapi import HTTPException

        import backend.app.api.routes.camera as cam

        pids = [7501, 7502]
        printers = [self._printer(pid) for pid in pids]
        with pytest.raises(HTTPException) as exc_info:
            # Real _ensure_producer: the patched load is above the gate.
            await self._call(pids, printers, load=cam._SPAWN_LOAD_THRESHOLD + 1.0)

        assert exc_info.value.status_code == 503
        assert exc_info.value.headers == {"Retry-After": "5"}
        assert cam._GRID_SPAWN_REFUSED_RETRY_AFTER == 5

    @pytest.mark.asyncio
    async def test_no_printers_found_still_returns_404(self):
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            await self._call([7511, 7512], [])

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "No valid printers found"

    @pytest.mark.asyncio
    async def test_only_external_camera_printers_still_returns_404(self):
        from fastapi import HTTPException

        pids = [7521]
        with pytest.raises(HTTPException) as exc_info:
            await self._call(pids, [self._printer(7521, external=True)])

        assert exc_info.value.status_code == 404

    @pytest.mark.asyncio
    async def test_one_producer_started_still_streams(self):
        from fastapi.responses import StreamingResponse

        pids = [7531, 7532]
        printers = [self._printer(pid) for pid in pids]

        async def ensure(pid, _db, *_args, **_kwargs):
            # First refused by the gate, second started.
            return None if pid == pids[0] else TestGridStreamGenerateLoop._live_entry()

        resp = await self._call(pids, printers, ensure=ensure)
        assert isinstance(resp, StreamingResponse)
        await resp.body_iterator.aclose()
