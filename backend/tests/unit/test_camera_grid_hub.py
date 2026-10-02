"""Unit tests for SharedStreamHub lifecycle, race-condition guards, and frame buffer cleanup.

Covers get_or_start(), restart() three-phase protocol, idle timeout, stop(),
is_active(), get_last_frame(), status(), and cleanup start/stop.
"""

import asyncio
import inspect
import time
from unittest.mock import patch

import pytest


def _make_frame_source(frames=5, interval=0.01):
    """Create a simple async frame generator for testing producers."""

    async def source():
        for i in range(frames):
            yield f"frame-{i}".encode()
            await asyncio.sleep(interval)

    return source


class TestSharedStreamHubGetOrStart:
    """Tests for SharedStreamHub.get_or_start()."""

    @pytest.mark.asyncio
    async def test_starts_new_producer_when_none_exists(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source()
        entry = await hub.get_or_start(1, starter, params_key="5-15-0.5")

        assert entry.alive is True
        assert entry.params_key == "5-15-0.5"
        assert entry.task is not None
        assert 1 in hub._streams
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_reuses_existing_alive_producer(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=100, interval=0.1)
        entry1 = await hub.get_or_start(1, starter, params_key="5-15-0.5")

        # Second call with different params should still reuse existing
        entry2 = await hub.get_or_start(1, _make_frame_source(), params_key="10-20-1.0")
        assert entry1 is entry2
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_starts_new_producer_when_existing_is_dead(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        # Insert a dead entry
        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        hub._streams[1] = dead_entry

        starter = _make_frame_source()
        new_entry = await hub.get_or_start(1, starter, params_key="new")
        assert new_entry is not dead_entry
        assert new_entry.alive is True
        assert new_entry.params_key == "new"
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_reuses_entry_created_concurrently_during_replace(self):
        """Shared _replace_producer re-check: an entry that appears while we await the
        old task (regardless of its params) is reused as-is by get_or_start."""
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        concurrent_entry = _SharedStream(params_key="concurrent")

        async def old_task_body():
            # Simulate another caller finishing its own producer registration
            # while we are still awaiting our old task in phase 2.
            hub._streams[1] = concurrent_entry

        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        dead_entry.task = asyncio.create_task(old_task_body())
        hub._streams[1] = dead_entry

        entry = await hub.get_or_start(1, _make_frame_source(), params_key="new")

        assert entry is concurrent_entry
        await hub.stop_all()


class TestSharedStreamHubRestart:
    """Tests for SharedStreamHub.restart() three-phase protocol."""

    @pytest.mark.asyncio
    async def test_restart_with_different_params(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter1 = _make_frame_source(frames=100, interval=0.1)
        entry1 = await hub.get_or_start(1, starter1, params_key="5-15-0.5")

        starter2 = _make_frame_source(frames=100, interval=0.1)
        entry2 = await hub.restart(1, starter2, params_key="10-20-1.0")

        assert entry2 is not entry1
        assert entry1.alive is False
        assert entry2.alive is True
        assert entry2.params_key == "10-20-1.0"
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_restart_same_params_returns_existing(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=100, interval=0.1)
        entry1 = await hub.get_or_start(1, starter, params_key="5-15-0.5")

        entry2 = await hub.restart(1, _make_frame_source(), params_key="5-15-0.5")
        assert entry2 is entry1
        assert entry2.alive is True
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_restart_no_existing_creates_new(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source()
        entry = await hub.restart(1, starter, params_key="5-15-0.5")

        assert entry.alive is True
        assert entry.params_key == "5-15-0.5"
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_restart_identity_check_prevents_stale_removal(self, monkeypatch):
        """Old producer's finally runs AFTER its replacement is registered and must not remove it."""
        from backend.app.api.routes import camera as camera_mod
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        running, release = asyncio.Event(), asyncio.Event()

        def gated_starter():
            async def source():
                try:
                    yield b"old"
                    running.set()
                    await asyncio.Event().wait()
                finally:
                    # Hold the old producer's teardown open until released.
                    await release.wait()

            return source()

        entry1 = await hub.get_or_start(1, gated_starter, params_key="old")
        await running.wait()

        # Simulate the displaced-task wait giving up (its bounded timeout) while
        # entry1's finally is still pending: stop tracking the teardown so the
        # replacement registers before that finally runs.
        async def no_wait(_task, timeout):
            hub._tearing_down.pop(1, None)

        monkeypatch.setattr(camera_mod, "_await_displaced_task", no_wait)

        entry2 = await hub.restart(1, _make_frame_source(frames=100, interval=0.1), params_key="new")
        assert entry2 is not entry1
        assert hub._streams[1] is entry2
        assert not entry1.task.done()

        # Now let entry1's finally run, after the replacement exists.
        release.set()
        await asyncio.wait({entry1.task}, timeout=5.0)
        assert entry1.task.done()

        assert entry1.alive is False
        assert hub._streams[1] is entry2
        assert entry2.alive is True
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_replacement_after_old_producer_finished_naturally(self):
        """Old producer's finally has already run before the replacement is created."""
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        entry1 = await hub.get_or_start(1, _make_frame_source(frames=2, interval=0), params_key="old")
        await asyncio.wait({entry1.task}, timeout=5.0)
        assert entry1.task.done()
        assert 1 not in hub._streams

        entry2 = await hub.get_or_start(1, _make_frame_source(frames=100, interval=0.1), params_key="new")

        assert entry2 is not entry1
        assert hub._streams[1] is entry2
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_cancels_entry_created_concurrently_with_different_params(self):
        """Shared _replace_producer re-check: an entry that appears with different params
        while we await the old task is cancelled and replaced by restart()."""
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        concurrent_entry = _SharedStream(params_key="concurrent-params")
        concurrent_task_started = asyncio.Event()

        async def concurrent_producer():
            concurrent_task_started.set()
            await asyncio.sleep(10)

        async def old_task_body():
            # Simulate another caller finishing its own producer registration
            # while we are still awaiting our old task in phase 2.
            hub._streams[1] = concurrent_entry
            concurrent_entry.task = asyncio.create_task(concurrent_producer())
            await concurrent_task_started.wait()

        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        dead_entry.task = asyncio.create_task(old_task_body())
        hub._streams[1] = dead_entry

        new_entry = await hub.restart(1, _make_frame_source(), params_key="requested-params")

        assert new_entry is not concurrent_entry
        assert concurrent_entry.alive is False
        assert new_entry.alive is True
        assert new_entry.params_key == "requested-params"
        assert hub._streams[1] is new_entry

        try:
            await asyncio.wait_for(concurrent_entry.task, timeout=1.0)
        except (asyncio.CancelledError, TimeoutError):
            pass
        await hub.stop_all()


class TestSharedStreamHubOwnCancellationPropagates:
    """T-140: get_or_start()/restart()/stop() must propagate the *caller's
    own* cancellation while awaiting a displaced/old producer task, instead
    of swallowing it as "best effort" cleanup.

    Swallowing it let a request-task cancellation (e.g. a grid client
    disconnecting mid producer-swap) go unnoticed: the route would carry on
    and spawn a fresh producer for a viewer that had already left, orphaning
    it until the idle timeout. A *normal* swap — where the awaited old task
    was cancelled by the hub itself and finishes on its own — must still be
    swallowed; only the cancellation of the coroutine doing the awaiting is
    now let through.
    """

    @pytest.mark.asyncio
    async def test_get_or_start_propagates_cancellation_and_registers_nothing(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        old_task_started = asyncio.Event()
        never = asyncio.Event()

        async def old_task_body():
            old_task_started.set()
            await never.wait()  # never resolves on its own

        # Entry dead but its task is still "cleaning up" — get_or_start()
        # awaits this task in _replace_producer's phase 2.
        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        dead_entry.task = asyncio.create_task(old_task_body())
        hub._streams[1] = dead_entry

        await old_task_started.wait()

        caller = asyncio.create_task(hub.get_or_start(1, _make_frame_source(), params_key="new"))
        # Let the caller run until it is parked awaiting the displaced task.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not caller.done()

        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller

        # Our own cancellation must NOT force the displaced task to
        # completion first, and no new producer may be registered.
        assert not dead_entry.task.done()
        assert 1 not in hub._streams

        dead_entry.task.cancel()
        try:
            await dead_entry.task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_restart_propagates_cancellation_and_registers_nothing(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        old_task_started = asyncio.Event()
        never = asyncio.Event()

        async def old_producer_body():
            old_task_started.set()
            await never.wait()

        # Alive entry with different params — restart() cancels it and then
        # awaits it in phase 2, same as the displaced-task path above.
        entry = _SharedStream(params_key="old-params")
        entry.alive = True
        entry.task = asyncio.create_task(old_producer_body())
        hub._streams[1] = entry

        await old_task_started.wait()

        caller = asyncio.create_task(hub.restart(1, _make_frame_source(), params_key="new-params"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not caller.done()

        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller

        assert 1 not in hub._streams

        try:
            await entry.task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_stop_propagates_cancellation_without_forcing_task_done(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        task_started = asyncio.Event()
        never = asyncio.Event()

        async def long_running():
            task_started.set()
            try:
                await never.wait()
            except asyncio.CancelledError:
                # Simulate a slow finally block (e.g. killing ffmpeg) so this
                # task is still not done() while `caller` is cancelled below,
                # regardless of exact event-loop scheduling order.
                await never.wait()

        entry = _SharedStream(params_key="5-15-0.5")
        entry.alive = True
        entry.task = asyncio.create_task(long_running())
        hub._streams[1] = entry

        await task_started.wait()

        caller = asyncio.create_task(hub.stop(1))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not caller.done()

        caller.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller

        # stop() already cancelled entry.task itself, but our own
        # cancellation must propagate immediately rather than forcing
        # entry.task to finish first.
        assert not entry.task.done()

        entry.task.cancel()
        try:
            await entry.task
        except asyncio.CancelledError:
            pass


class TestAwaitDisplacedTaskTimeout:
    """T-171: _await_displaced_task's timeout branch — if the displaced task
    is still pending when the deadline passes, it must be force-cancelled
    (mirroring wait_for's own behavior) before the helper returns normally.
    This is distinct from TestSharedStreamHubOwnCancellationPropagates above,
    which covers the *caller's own* cancellation propagating instead of being
    swallowed; here the caller is never cancelled, only the displaced task
    outlives its budget.
    """

    @pytest.mark.asyncio
    async def test_timeout_force_cancels_the_still_pending_task(self):
        from backend.app.api.routes.camera import _await_displaced_task

        never = asyncio.Event()  # never set, so the task blocks forever

        async def stuck_forever():
            await never.wait()

        task = asyncio.create_task(stuck_forever())
        await asyncio.sleep(0)  # let it start
        assert not task.done()

        # Returns normally (does not raise) once the short timeout elapses,
        # having force-cancelled the still-pending task first.
        await _await_displaced_task(task, timeout=0.05)

        assert task.done()
        assert task.cancelled()

    @pytest.mark.asyncio
    async def test_task_finishing_before_deadline_is_not_cancelled(self):
        from backend.app.api.routes.camera import _await_displaced_task

        async def finishes_quickly():
            await asyncio.sleep(0.01)
            return "done"

        task = asyncio.create_task(finishes_quickly())

        # Timeout is comfortably longer than the task's own runtime, so it
        # should complete on its own without ever being cancelled.
        await _await_displaced_task(task, timeout=1.0)

        assert task.done()
        assert not task.cancelled()
        assert task.result() == "done"


class TestSharedStreamHubIdleTimeout:
    """Tests for producer auto-stop after IDLE_TIMEOUT without viewer activity."""

    @pytest.mark.asyncio
    async def test_producer_auto_stops_when_idle(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        # Set a very short idle timeout for testing
        original_timeout = hub.IDLE_TIMEOUT
        hub.IDLE_TIMEOUT = 0.05  # 50ms

        starter = _make_frame_source(frames=100, interval=0.01)
        entry = await hub.get_or_start(1, starter, params_key="test")

        # Set last_accessed far in the past so idle check triggers immediately
        entry.last_accessed = time.monotonic() - 10

        # Wait for the producer to detect idle and stop
        await asyncio.sleep(0.2)

        assert entry.alive is False
        hub.IDLE_TIMEOUT = original_timeout

    @pytest.mark.asyncio
    async def test_producer_stays_alive_when_accessed(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        original_timeout = hub.IDLE_TIMEOUT
        hub.IDLE_TIMEOUT = 0.5

        starter = _make_frame_source(frames=20, interval=0.05)
        entry = await hub.get_or_start(1, starter, params_key="test")

        # Keep touching last_accessed
        for _ in range(5):
            entry.last_accessed = time.monotonic()
            await asyncio.sleep(0.05)

        assert entry.alive is True
        hub.IDLE_TIMEOUT = original_timeout
        await hub.stop_all()


class TestSharedStreamHubStop:
    """Tests for SharedStreamHub.stop()."""

    @pytest.mark.asyncio
    async def test_stop_returns_false_for_missing(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        assert await hub.stop(999) is False

    @pytest.mark.asyncio
    async def test_stop_marks_entry_dead(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream(params_key="5-15-0.5")
        entry.alive = True
        # Provide a completed task so stop() doesn't hang
        entry.task = asyncio.ensure_future(asyncio.sleep(0))
        await entry.task  # let it finish
        hub._streams[1] = entry

        result = await hub.stop(1)
        assert result is True
        assert entry.alive is False
        assert entry.frame is None
        assert 1 not in hub._streams

    @pytest.mark.asyncio
    async def test_stop_cancels_running_task(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream(params_key="5-15-0.5")
        entry.alive = True

        # Create a long-running task
        async def long_running():
            await asyncio.sleep(100)

        entry.task = asyncio.create_task(long_running())
        hub._streams[1] = entry

        result = await hub.stop(1)
        assert result is True
        assert entry.task.cancelled() or entry.task.done()


class TestSharedStreamHubIsActive:
    """Tests for SharedStreamHub.is_active()."""

    @pytest.mark.asyncio
    async def test_returns_false_for_missing(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        assert hub.is_active(999) is False

    @pytest.mark.asyncio
    async def test_returns_true_for_alive(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream()
        entry.alive = True
        hub._streams[1] = entry
        assert hub.is_active(1) is True

    @pytest.mark.asyncio
    async def test_returns_false_for_dead(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream()
        entry.alive = False
        hub._streams[1] = entry
        assert hub.is_active(1) is False


class TestSharedStreamHubGetLastFrame:
    """Tests for SharedStreamHub.get_last_frame()."""

    def test_returns_none_for_missing(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        assert hub.get_last_frame(999) is None

    def test_returns_none_for_dead_entry(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream()
        entry.alive = False
        entry.frame = b"\xff\xd8frame\xff\xd9"
        hub._streams[1] = entry
        assert hub.get_last_frame(1) is None

    def test_returns_frame_for_alive_entry(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream()
        entry.alive = True
        entry.frame = b"\xff\xd8frame\xff\xd9"
        hub._streams[1] = entry
        assert hub.get_last_frame(1) == b"\xff\xd8frame\xff\xd9"

    def test_returns_none_when_no_frame_yet(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream()
        entry.alive = True
        entry.frame = None
        hub._streams[1] = entry
        assert hub.get_last_frame(1) is None


class TestSharedStreamHubStatus:
    """Tests for SharedStreamHub.status() debugging endpoint."""

    def test_empty_hub(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        s = hub.status()
        assert s["producer_count"] == 0
        assert s["producers"] == {}

    def test_status_includes_all_entries(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        for pid in [1, 2, 3]:
            entry = _SharedStream(params_key=f"5-15-{pid}")
            entry.alive = pid != 3  # Third is dead
            entry.viewer_count = pid
            entry.frame_seq = pid * 10
            hub._streams[pid] = entry

        s = hub.status()
        assert s["producer_count"] == 3
        assert set(s["producers"].keys()) == {1, 2, 3}
        assert s["producers"][1]["alive"] is True
        assert s["producers"][3]["alive"] is False
        assert s["producers"][2]["viewers"] == 2
        assert s["producers"][1]["frames_produced"] == 10


class TestGetBufferedFrame:
    """Tests for get_buffered_frame() checking hub then fallback."""

    def test_returns_hub_frame(self):
        import backend.app.api.routes.camera as cam
        from backend.app.api.routes.camera import _SharedStream

        entry = _SharedStream()
        entry.alive = True
        entry.frame = b"hub_frame"

        original_streams = dict(cam._hub._streams)
        cam._hub._streams[42] = entry
        try:
            result = cam.get_buffered_frame(42)
            assert result == b"hub_frame"
        finally:
            cam._hub._streams.clear()
            cam._hub._streams.update(original_streams)

    def test_returns_none_when_no_hub_entry(self):
        import backend.app.api.routes.camera as cam

        result = cam.get_buffered_frame(9999)
        assert result is None


class TestFrameBufferCleanupLifecycle:
    """Tests for start_frame_buffer_cleanup / stop_frame_buffer_cleanup."""

    @pytest.mark.asyncio
    async def test_start_creates_task(self):
        import backend.app.api.routes.camera as cam

        # Ensure clean state
        cam.stop_frame_buffer_cleanup()
        assert cam._state.cleanup_task is None

        cam.start_frame_buffer_cleanup()
        assert cam._state.cleanup_task is not None
        assert not cam._state.cleanup_task.done()

        # Cleanup
        cam.stop_frame_buffer_cleanup()
        assert cam._state.cleanup_task is None

    @pytest.mark.asyncio
    async def test_stop_cancels_task(self):
        import backend.app.api.routes.camera as cam

        cam.stop_frame_buffer_cleanup()
        cam.start_frame_buffer_cleanup()
        task = cam._state.cleanup_task

        cam.stop_frame_buffer_cleanup()
        # Yield control so the cancellation propagates
        await asyncio.sleep(0)
        assert task.cancelled() or task.done()

    @pytest.mark.asyncio
    async def test_start_is_idempotent(self):
        import backend.app.api.routes.camera as cam

        cam.stop_frame_buffer_cleanup()
        cam.start_frame_buffer_cleanup()
        first_task = cam._state.cleanup_task

        cam.start_frame_buffer_cleanup()
        assert cam._state.cleanup_task is first_task  # Same task, not a new one

        cam.stop_frame_buffer_cleanup()


class TestRestartStaleSameParams:
    """Tests for restart() with stale producer and same params (B1 regression)."""

    @pytest.mark.asyncio
    async def test_restart_stale_same_params_does_not_keyerror(self):
        """Stale producer with same params should be replaced without KeyError."""
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=100, interval=0.1)
        entry = await hub.get_or_start(1, starter, params_key="5-15-0.5")

        # Wait for at least one frame so frame_seq > 0
        await asyncio.sleep(0.05)
        assert entry.frame_seq > 0

        # Simulate stale: last frame was produced long ago
        entry.last_frame_produced = time.monotonic() - 60.0

        # This should NOT raise KeyError
        new_entry = await hub.restart(1, _make_frame_source(frames=100, interval=0.1), params_key="5-15-0.5")
        assert new_entry is not entry
        assert new_entry.alive is True
        assert new_entry.params_key == "5-15-0.5"
        assert 1 in hub._streams
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_restart_stale_same_params_old_entry_marked_dead(self):
        """The old stale entry should be marked dead after restart."""
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=100, interval=0.1)
        old_entry = await hub.get_or_start(1, starter, params_key="5-15-0.5")

        await asyncio.sleep(0.05)
        old_entry.last_frame_produced = time.monotonic() - 60.0

        await hub.restart(1, _make_frame_source(frames=100, interval=0.1), params_key="5-15-0.5")
        assert old_entry.alive is False
        await hub.stop_all()


class TestMakeViewer:
    """Tests for SharedStreamHub.make_viewer() frame delivery."""

    @pytest.mark.asyncio
    async def test_viewer_yields_mjpeg_formatted_frames(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=3, interval=0.01)
        entry = await hub.get_or_start(1, starter, params_key="test")

        viewer = hub.make_viewer(entry, fps=30)
        chunks = []
        async for chunk in viewer:
            chunks.append(chunk)
            if len(chunks) >= 9:  # 3 frames x 3 chunks each (header, data, boundary)
                break

        # Each frame produces 3 chunks: MJPEG header, frame data, trailing CRLF
        assert len(chunks) >= 3
        assert b"--frame" in chunks[0]
        assert b"Content-Type: image/jpeg" in chunks[0]
        assert chunks[2] == b"\r\n"
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_viewer_exits_when_entry_marked_dead(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=100, interval=0.1)
        entry = await hub.get_or_start(1, starter, params_key="test")

        viewer = hub.make_viewer(entry, fps=30)
        # Kill the entry
        entry.alive = False

        chunks = []
        async for chunk in viewer:
            chunks.append(chunk)
        # Should exit promptly
        assert len(chunks) == 0 or len(chunks) <= 3  # at most one frame in flight
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_viewer_count_incremented_and_decremented(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        starter = _make_frame_source(frames=3, interval=0.01)
        entry = await hub.get_or_start(1, starter, params_key="test")

        assert entry.viewer_count == 0

        viewer = hub.make_viewer(entry, fps=30)
        # Consume one chunk to trigger the viewer_count increment
        chunk_iter = viewer.__aiter__()
        try:
            await asyncio.wait_for(chunk_iter.__anext__(), timeout=1.0)
            assert entry.viewer_count == 1
        except (StopAsyncIteration, TimeoutError):
            pass

        # Close the viewer
        await chunk_iter.aclose()
        assert entry.viewer_count == 0
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_viewer_skips_duplicate_sequences(self):
        """Viewer should not yield the same frame twice (same seq)."""
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream(params_key="test")
        entry.alive = True

        # Manually set a frame
        entry.frame = b"\xff\xd8test\xff\xd9"
        entry.frame_seq = 1

        viewer = hub.make_viewer(entry, fps=30)
        chunks = []

        async def consume():
            async for chunk in viewer:
                chunks.append(chunk)
                if len(chunks) >= 3:
                    # After getting one full frame, don't produce new frames
                    # Give enough time for the viewer to poll again
                    await asyncio.sleep(0.1)
                    entry.alive = False

        await asyncio.wait_for(consume(), timeout=2.0)
        # Should have exactly 3 chunks (one frame: header + data + boundary)
        assert len(chunks) == 3

    @pytest.mark.asyncio
    async def test_viewer_survives_asyncio_timeouterror_not_builtin(self, monkeypatch):
        """Regression for T-010.

        ``asyncio.TimeoutError`` is only an alias of the builtin ``TimeoutError`` on
        Python 3.11+. On Python 3.10, ``asyncio.wait_for`` raises
        ``asyncio.exceptions.TimeoutError``, a distinct class that a bare
        ``except TimeoutError:`` does NOT catch, so the whole viewer generator would
        raise out instead of looping.

        This suite runs on Python 3.13, where the two classes are identical, so a
        real ``asyncio.wait_for`` timeout can't distinguish the buggy clause from the
        fixed one. To make the test meaningful, we monkeypatch
        ``asyncio.wait_for`` (as seen by the camera module) so the very first call
        explicitly raises ``asyncio.exceptions.TimeoutError()`` -- reproducing what
        Python 3.10 raises -- and assert the viewer keeps polling and eventually
        yields a frame instead of propagating the exception.
        """
        import backend.app.api.routes.camera as camera_module
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        entry = _SharedStream(params_key="test")
        entry.alive = True
        # No frame yet, so make_viewer's poll loop takes the wait_for() branch.

        real_wait_for = asyncio.wait_for
        calls = {"n": 0}

        async def fake_wait_for(aw, timeout):
            # Only intercept the viewer's own `evt.wait()` call (a plain coroutine
            # object). `inspect.iscoroutine` (unlike `asyncio.iscoroutine`) does NOT
            # also match the async_generator_asend object produced by this test's own
            # `chunk_iter.__anext__()` polling below, so that call passes through
            # untouched.
            if calls["n"] == 0 and inspect.iscoroutine(aw):
                calls["n"] += 1
                # Close the coroutine we were handed instead of awaiting it, mirroring
                # wait_for's own cancel-on-timeout behavior, then raise the
                # asyncio-specific TimeoutError subclass Python 3.10 raises.
                aw.close()
                raise asyncio.exceptions.TimeoutError()
            return await real_wait_for(aw, timeout)

        monkeypatch.setattr(camera_module.asyncio, "wait_for", fake_wait_for)

        viewer = hub.make_viewer(entry, fps=30)
        chunk_iter = viewer.__aiter__()

        async def deliver_frame():
            await asyncio.sleep(0.05)
            entry.frame = b"\xff\xd8test\xff\xd9"
            entry.frame_seq = 1
            entry.frame_event.set()

        deliver_task = asyncio.create_task(deliver_frame())
        try:
            chunk = await asyncio.wait_for(chunk_iter.__anext__(), timeout=2.0)
        finally:
            await deliver_task

        # The viewer must have survived the simulated 3.10-style TimeoutError and
        # continued on to yield the frame delivered afterwards.
        assert calls["n"] == 1
        assert b"--frame" in chunk
        await chunk_iter.aclose()


class TestProducerErrorHandling:
    """Tests for _run_producer() error handling paths."""

    @pytest.mark.asyncio
    async def test_producer_sets_error_on_source_exception(self):
        from backend.app.api.routes.camera import SharedStreamHub

        async def failing_source():
            yield b"frame-0"
            raise RuntimeError("stream broke")

        hub = SharedStreamHub()
        entry = await hub.get_or_start(1, failing_source, params_key="test")

        # Wait for producer to hit the error
        await asyncio.sleep(0.1)
        assert entry.alive is False
        assert entry.error == "stream broke"

    @pytest.mark.asyncio
    async def test_producer_identity_check_preserves_replacement(self):
        """Producer's finally block should not remove a replacement entry."""
        from backend.app.api.routes.camera import SharedStreamHub

        async def short_source():
            yield b"frame"

        hub = SharedStreamHub()
        entry1 = await hub.get_or_start(1, short_source, params_key="old")

        # Wait for first producer to finish
        await asyncio.sleep(0.1)

        # Start a replacement
        entry2 = await hub.get_or_start(1, _make_frame_source(frames=100, interval=0.1), params_key="new")
        assert entry2 is not entry1
        assert hub._streams.get(1) is entry2
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_producer_auto_stops_on_idle_timeout(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        original_timeout = hub.IDLE_TIMEOUT
        hub.IDLE_TIMEOUT = 0.05

        entry = await hub.get_or_start(1, _make_frame_source(frames=100, interval=0.01), params_key="test")
        entry.last_accessed = time.monotonic() - 10

        await asyncio.sleep(0.2)
        assert entry.alive is False
        hub.IDLE_TIMEOUT = original_timeout


class TestStaleProducerTimeoutConstant:
    """Tests that STALE_PRODUCER_TIMEOUT is a class constant (M3)."""

    def test_stale_timeout_is_class_constant(self):
        from backend.app.api.routes.camera import SharedStreamHub

        assert hasattr(SharedStreamHub, "STALE_PRODUCER_TIMEOUT")
        assert SharedStreamHub.STALE_PRODUCER_TIMEOUT == 45.0

    def test_stale_timeout_is_overridable_per_instance(self):
        from backend.app.api.routes.camera import SharedStreamHub

        hub = SharedStreamHub()
        hub.STALE_PRODUCER_TIMEOUT = 10.0
        assert hub.STALE_PRODUCER_TIMEOUT == 10.0
        # Class default unchanged
        assert SharedStreamHub.STALE_PRODUCER_TIMEOUT == 45.0


class TestSharedStreamHubWaitsForTeardown:
    """T-012: every caller waits for a dying producer's teardown before a new
    producer is started for the same printer — not only the caller that
    detached the dying entry. Otherwise a second viewer arriving mid-teardown
    dials the camera while the old ffmpeg/SSL connection is still closing.
    """

    @staticmethod
    def _counting_starter(calls):
        async def source():
            calls.append(1)
            while True:
                yield b"frame"
                await asyncio.sleep(0.01)

        return source

    @staticmethod
    def _slow_teardown_task(started, release):
        """A producer-like task whose cancellation/exit waits on *release*.

        The cancelled path is bounded (3s) so a failing assertion cannot leave
        the event loop hanging on an unreleased teardown at test exit.
        """

        async def body():
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                try:
                    await asyncio.wait_for(release.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    pass
                raise

        return asyncio.create_task(body())

    @staticmethod
    async def _settle():
        for _ in range(5):
            await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_concurrent_get_or_start_on_dying_entry_waits_and_starts_one_producer(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        started, release = asyncio.Event(), asyncio.Event()
        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        dead_entry.task = self._slow_teardown_task(started, release)
        hub._streams[1] = dead_entry
        await started.wait()

        calls: list[int] = []
        first = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="a"))
        await self._settle()
        # The first caller detached the dead entry and is awaiting its teardown.
        assert 1 not in hub._streams
        second = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="b"))
        await self._settle()

        # Neither caller may start a producer while the teardown is running.
        assert not first.done()
        assert not second.done()
        assert 1 not in hub._streams
        assert calls == []

        release.set()
        entry_a, entry_b = await asyncio.gather(first, second)
        await self._settle()

        assert entry_a is entry_b
        assert hub._streams[1] is entry_a
        assert len(calls) == 1
        assert hub._tearing_down == {}
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_get_or_start_during_restart_waits_for_old_producer_teardown(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        started, release = asyncio.Event(), asyncio.Event()
        old = _SharedStream(params_key="old-params")
        old.task = self._slow_teardown_task(started, release)
        hub._streams[1] = old
        await started.wait()

        calls: list[int] = []
        restarter = asyncio.create_task(hub.restart(1, self._counting_starter(calls), params_key="new-params"))
        await self._settle()
        viewer = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="other"))
        await self._settle()

        assert not restarter.done()
        assert not viewer.done()
        assert calls == []
        assert 1 not in hub._streams

        release.set()
        restarted, viewed = await asyncio.gather(restarter, viewer)
        await self._settle()

        assert restarted is viewed
        assert restarted.params_key == "new-params"
        assert len(calls) == 1
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_get_or_start_racing_stop_waits_for_teardown(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        started, release = asyncio.Event(), asyncio.Event()
        entry = _SharedStream(params_key="p")
        entry.task = self._slow_teardown_task(started, release)
        hub._streams[1] = entry
        await started.wait()

        calls: list[int] = []
        stopper = asyncio.create_task(hub.stop(1))
        await self._settle()
        viewer = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="p"))
        await self._settle()

        assert not stopper.done()
        assert not viewer.done()
        assert calls == []
        assert 1 not in hub._streams

        release.set()
        stopped, new_entry = await asyncio.gather(stopper, viewer)
        await self._settle()

        assert stopped is True
        assert new_entry is not entry
        assert new_entry.alive is True
        assert len(calls) == 1
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_get_or_start_racing_stop_all_waits_for_teardown(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        started, release = asyncio.Event(), asyncio.Event()
        entry = _SharedStream(params_key="p")
        entry.task = self._slow_teardown_task(started, release)
        hub._streams[1] = entry
        await started.wait()

        calls: list[int] = []
        stopper = asyncio.create_task(hub.stop_all())
        await self._settle()
        viewer = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="p"))
        await self._settle()

        assert not viewer.done()
        assert calls == []

        release.set()
        count, new_entry = await asyncio.gather(stopper, viewer)
        await self._settle()

        assert count == 1
        assert new_entry.alive is True
        assert len(calls) == 1
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_concurrent_get_or_start_on_stale_producer_starts_one_producer(self):
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        started, release = asyncio.Event(), asyncio.Event()
        stale = _SharedStream(params_key="old")
        stale.frame_seq = 3
        stale.last_frame_produced = time.monotonic() - hub.STALE_PRODUCER_TIMEOUT - 5
        stale.task = self._slow_teardown_task(started, release)
        hub._streams[1] = stale
        await started.wait()

        calls: list[int] = []
        first = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="a"))
        await self._settle()
        second = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="b"))
        await self._settle()
        assert calls == []

        release.set()
        entry_a, entry_b = await asyncio.gather(first, second)
        await self._settle()

        assert entry_a is entry_b
        assert len(calls) == 1
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_waits_for_dead_entry_still_registered_during_replace(self):
        """A dead entry that lands in _streams while a caller awaits its own old
        task is itself awaited before the new producer is created."""
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        hub = SharedStreamHub()
        started, release, go = asyncio.Event(), asyncio.Event(), asyncio.Event()
        other_dead = _SharedStream(params_key="other")
        other_dead.alive = False

        async def old_task_body():
            await go.wait()  # run only once the caller has detached dead_entry
            other_dead.task = self._slow_teardown_task(started, release)
            hub._streams[1] = other_dead
            await started.wait()

        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        dead_entry.task = asyncio.create_task(old_task_body())
        hub._streams[1] = dead_entry

        calls: list[int] = []
        caller = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="new"))
        await self._settle()
        assert 1 not in hub._streams
        go.set()
        await self._settle()
        assert hub._streams[1] is other_dead
        assert not caller.done()
        assert calls == []

        release.set()
        entry = await caller
        await self._settle()
        assert entry.params_key == "new"
        assert len(calls) == 1
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_second_caller_wait_is_bounded_by_timeout(self):
        """The wait stays bounded: a teardown that never finishes is force-cancelled
        after the timeout and the waiting caller proceeds to start one producer."""
        from backend.app.api.routes import camera as camera_mod
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        real_wait = camera_mod._await_displaced_task

        async def short_wait(task, timeout):
            assert timeout == 8.0
            await real_wait(task, timeout=0.05)

        hub = SharedStreamHub()
        stuck = asyncio.Event()  # never set

        async def never_finishes():
            await stuck.wait()

        dead_entry = _SharedStream(params_key="old")
        dead_entry.alive = False
        dead_entry.task = asyncio.create_task(never_finishes())
        hub._streams[1] = dead_entry
        await asyncio.sleep(0)

        calls: list[int] = []
        with patch.object(camera_mod, "_await_displaced_task", short_wait):
            first = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="a"))
            await self._settle()
            second = asyncio.create_task(hub.get_or_start(1, self._counting_starter(calls), params_key="b"))
            entry_a, entry_b = await asyncio.wait_for(asyncio.gather(first, second), timeout=2.0)
        await self._settle()

        assert dead_entry.task.cancelled()
        assert entry_a is entry_b
        assert len(calls) == 1
        await hub.stop_all()


class TestTrackTeardown:
    """T-012: the per-printer teardown record clears itself when its task
    finishes, but never clears a newer teardown recorded after it."""

    @pytest.mark.asyncio
    async def test_finished_task_does_not_clear_newer_record(self):
        from backend.app.api.routes.camera import _track_teardown

        registry: dict[int, asyncio.Task] = {}
        gate_a, gate_b = asyncio.Event(), asyncio.Event()
        task_a = asyncio.create_task(gate_a.wait())
        task_b = asyncio.create_task(gate_b.wait())

        _track_teardown(registry, 1, task_a)
        _track_teardown(registry, 1, task_b)
        assert registry[1] is task_b

        gate_a.set()
        await task_a
        await asyncio.sleep(0)
        assert registry[1] is task_b

        gate_b.set()
        await task_b
        await asyncio.sleep(0)
        assert registry == {}

    @pytest.mark.asyncio
    async def test_ignores_missing_or_finished_task(self):
        from backend.app.api.routes.camera import _track_teardown

        registry: dict[int, asyncio.Task] = {}
        done = asyncio.create_task(asyncio.sleep(0))
        await done

        _track_teardown(registry, 1, None)
        _track_teardown(registry, 1, done)
        assert registry == {}


class TestParamsChangeReplaceWaitsForTeardown:
    """T-027: when _replace_producer's phase 3 finds a concurrently created producer
    with the wrong params, it records that producer in ``_tearing_down`` and waits
    for its teardown before starting the replacement, so two ffmpeg/RTSP sessions
    never overlap on one camera — and any other caller arriving meanwhile waits too.
    """

    async def _drive_to_phase3_cancel(self, monkeypatch):
        """Restart A (params p1) and restart B (params p2) race on a dying producer.

        A wins phase 3 and starts producer P1; B is held after its phase-2 wait
        until P1 is running, then reaches phase 3 and finds P1 with the wrong params.
        Returns once B has cancelled P1 and P1's (gated) teardown is in progress.
        """
        from backend.app.api.routes import camera as camera_mod
        from backend.app.api.routes.camera import SharedStreamHub, _SharedStream

        helpers = TestSharedStreamHubWaitsForTeardown
        hub = SharedStreamHub()
        old_started, old_release = asyncio.Event(), asyncio.Event()
        old = _SharedStream(params_key="old")
        old.task = helpers._slow_teardown_task(old_started, old_release)
        hub._streams[1] = old
        await old_started.wait()

        p1_running, p1_release, never = asyncio.Event(), asyncio.Event(), asyncio.Event()
        p1_teardown_done: list[int] = []

        def p1_starter():
            async def source():
                try:
                    yield b"p1"
                    p1_running.set()
                    await never.wait()
                finally:
                    try:
                        await asyncio.wait_for(p1_release.wait(), timeout=3.0)
                    except asyncio.TimeoutError:
                        pass
                    p1_teardown_done.append(1)

            return source()

        p2_starts: list[int] = []

        def p2_starter():
            async def source():
                # Record how many P1 teardowns had completed when P2 dialed the camera.
                p2_starts.append(len(p1_teardown_done))
                while True:
                    yield b"p2"
                    await never.wait()

            return source()

        b_gate = asyncio.Event()
        b_holder: list[asyncio.Task] = []
        real_wait = camera_mod._await_displaced_task

        async def gated_wait(task, timeout):
            await real_wait(task, timeout)
            if b_holder and asyncio.current_task() is b_holder[0]:
                await b_gate.wait()

        monkeypatch.setattr(camera_mod, "_await_displaced_task", gated_wait)

        a = asyncio.create_task(hub.restart(1, p1_starter, params_key="p1"))
        await helpers._settle()
        b = asyncio.create_task(hub.restart(1, p2_starter, params_key="p2"))
        b_holder.append(b)
        await helpers._settle()
        assert not a.done() and not b.done()

        old_release.set()
        p1_entry = await a
        await p1_running.wait()
        assert p1_entry.params_key == "p1"
        assert hub._streams[1] is p1_entry
        assert hub._tearing_down == {}

        b_gate.set()
        await helpers._settle()
        # B cancelled P1, but P1's teardown is still gated.
        assert p1_entry.alive is False
        assert not p1_entry.task.done()
        assert p1_teardown_done == []
        return hub, b, p1_entry, p1_release, p2_starts, p1_teardown_done

    @pytest.mark.asyncio
    async def test_second_producer_starts_only_after_first_finished(self, monkeypatch):
        hub, b, p1_entry, p1_release, p2_starts, p1_teardown_done = await self._drive_to_phase3_cancel(monkeypatch)
        helpers = TestSharedStreamHubWaitsForTeardown

        # While P1 is tearing down, B must neither register nor start P2.
        assert not b.done()
        assert 1 not in hub._streams
        assert p2_starts == []

        p1_release.set()
        p2_entry = await b
        await helpers._settle()

        assert p1_entry.task.done()
        assert p1_teardown_done == [1]
        assert p2_entry.params_key == "p2"
        assert p2_entry.alive is True
        # P2 dialed only after P1's teardown completed.
        assert p2_starts == [1]
        # P1's finally identity check did not remove the replacement entry.
        assert hub._streams[1] is p2_entry
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_displaced_task_is_tracked_while_tearing_down(self, monkeypatch):
        hub, b, p1_entry, p1_release, _p2_starts, _done = await self._drive_to_phase3_cancel(monkeypatch)
        helpers = TestSharedStreamHubWaitsForTeardown

        assert hub._tearing_down[1] is p1_entry.task

        p1_release.set()
        p2_entry = await b
        await helpers._settle()

        assert 1 not in hub._tearing_down
        assert hub._streams[1] is p2_entry
        await hub.stop_all()

    @pytest.mark.asyncio
    async def test_third_caller_waits_for_displaced_task(self, monkeypatch):
        hub, b, p1_entry, p1_release, p2_starts, p1_teardown_done = await self._drive_to_phase3_cancel(monkeypatch)
        helpers = TestSharedStreamHubWaitsForTeardown

        calls: list[int] = []
        c = asyncio.create_task(hub.get_or_start(1, helpers._counting_starter(calls), params_key="c"))
        await helpers._settle()

        # The third caller sees no stream but must wait on P1's teardown too.
        assert not c.done()
        assert calls == []
        assert 1 not in hub._streams

        p1_release.set()
        p2_entry, c_entry = await asyncio.gather(b, c)
        await helpers._settle()

        assert p1_teardown_done == [1]
        assert p2_starts == [1]
        # The third caller reuses B's producer rather than dialing a second session.
        assert c_entry is p2_entry
        assert calls == []
        assert hub._streams[1] is p2_entry
        await hub.stop_all()
