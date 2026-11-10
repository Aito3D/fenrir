"""NotifyWorkerLifecycle: retry backoff, cleanup requeue, schedule_cleanup and close paths (no sleeps, no network)."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from backend.app.models.notification_live_activity import NotificationLiveActivity
from backend.app.services import notify_worker
from backend.app.services.notify_worker import NotifyWorkerLifecycle

_real_sleep = asyncio.sleep


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeDb:
    def __init__(self, providers=(), persisted=(), fail=None):
        self.providers = list(providers)
        self.persisted = list(persisted)
        self.fail = fail

    async def __aenter__(self):
        if self.fail:
            raise self.fail
        return self

    async def __aexit__(self, *exc):
        return False

    async def scalars(self, stmt):
        from_providers = "FROM notification_providers" in str(stmt)
        return _Result(self.providers if from_providers else self.persisted)

    async def scalar(self, stmt):
        return None


class _Worker(NotifyWorkerLifecycle):
    ownership_model = NotificationLiveActivity
    feature_field = "feat"
    worker_interval = 0

    def __init__(self, providers=(), persisted=(), fail=None):
        self._init_worker()
        self._task = None
        self._http = None
        self._client = None
        self.db = _FakeDb(providers, persisted, fail)
        self._initial_discovery = False
        self.tick_calls = 0
        self.tick_script = []  # exceptions (raised) or None (success)
        self.activated = 0
        self.cleanups = []
        self.cleanup_exc = None
        self.on_tick = None

    def _session(self):
        return self.db

    @staticmethod
    def _cleanup_key(cfg):
        return cfg.get("k", "")

    def _on_activated(self):
        self.activated += 1

    async def tick(self):
        self.tick_calls += 1
        if self.on_tick:
            self.on_tick(self)
        await _real_sleep(0)
        step = self.tick_script.pop(0) if self.tick_script else None
        if step:
            raise step

    async def cleanup_provider(self, pid, cfg, captured_rows):
        self.cleanups.append((pid, cfg, captured_rows))
        await _real_sleep(0)  # always yield: a regression that spins here must not starve the loop timeouts
        if self.cleanup_exc:
            raise self.cleanup_exc


def _provider(enabled=True, config=None, pid=1):
    return SimpleNamespace(id=pid, enabled=enabled, config=config if config is not None else {"feat": True})


async def _until(pred):
    async def poll():
        while not pred():
            await _real_sleep(0)

    # A regression surfaces as TimeoutError after 5 s instead of stalling the run.
    await asyncio.wait_for(poll(), timeout=5)


async def _close(w):
    """close() bounded without wait_for: cancelling close() would also cancel the task it joins and mask a missing cancel."""
    closing = asyncio.ensure_future(w.close())
    done, _ = await asyncio.wait({closing}, timeout=5)
    if not done:
        closing.cancel()
        raise TimeoutError("close() did not finish")
    closing.result()


@pytest.fixture(autouse=True)
async def _reap_workers(monkeypatch):
    """Cancel any worker task a failing test leaves running so the loop can shut down."""
    made = []
    orig = _Worker.__init__

    def tracking_init(self, *a, **k):
        orig(self, *a, **k)
        made.append(self)

    monkeypatch.setattr(_Worker, "__init__", tracking_init)
    yield
    for w in made:
        if w._task is not None:
            w._task.cancel()
            await asyncio.gather(w._task, return_exceptions=True)


@pytest.fixture
def delays(monkeypatch):
    rec = []

    async def fake_sleep(d):
        rec.append(d)
        await _real_sleep(0)

    monkeypatch.setattr(notify_worker.asyncio, "sleep", fake_sleep)
    return rec


@pytest.mark.asyncio
async def test_backoff_doubles_caps_at_30_and_success_resets(delays):
    w = _Worker([_provider()])
    w.tick_script = [RuntimeError("x")] * 7
    w.start()
    await _until(lambda: w.tick_calls >= 8 and w._retry_delay == 1)
    assert delays[:7] == [1, 2, 4, 8, 16, 30, 30]
    # after the reset a new failure starts again from 1
    del delays[:]
    w.tick_script = [RuntimeError("y")]
    w.providers_changed()
    await _until(lambda: len(delays) >= 1 and w._retry_delay == 2)
    assert delays[0] == 1
    await _close(w)


@pytest.mark.asyncio
async def test_activation_hook_and_json_string_config(delays):
    w = _Worker([_provider(config=json.dumps({"feat": True}))])
    w._provider_enabled = False
    w.start()
    await _until(lambda: w.tick_calls >= 1)
    assert w.activated == 1
    assert w._provider_enabled is True
    await _close(w)


@pytest.mark.asyncio
async def test_invalid_json_config_raises_and_is_retried(delays):
    w = _Worker([_provider(config="{not json")])
    w.start()
    await _until(lambda: len(delays) >= 2)
    assert delays[:2] == [1, 2]
    assert w.tick_calls == 0
    await _close(w)


def test_non_dict_config_raises():
    w = _Worker()
    with pytest.raises(AttributeError):
        w._eligible(_provider(config=[1]))


@pytest.mark.asyncio
async def test_clean_dirty_skips_provider_reload_and_interval_timeout(delays):
    # worker_interval=0: wait_for times out immediately, the loop ticks again without reloading providers
    w = _Worker([_provider()])
    w.start()
    await _until(lambda: w.tick_calls >= 3)
    assert w._providers_dirty is False
    await _close(w)


@pytest.mark.asyncio
async def test_failed_cleanup_requeues_rows_and_backs_off(delays):
    w = _Worker()
    row = SimpleNamespace(id=1)
    w._cleanup_jobs[(5, "c")] = ({"k": "c"}, [row])
    w._retired.add((5, "c"))
    w.cleanup_exc = RuntimeError("boom")
    w.start()
    await _until(lambda: len(delays) >= 1)
    assert delays[0] == 1
    assert w._cleanup_jobs[(5, "c")][1][0] is row
    assert (5, "c") in w._retired
    # cleanup recovers: job drains and key is released
    w.cleanup_exc = None
    await _until(lambda: not w._cleanup_jobs)
    await _until(lambda: (5, "c") not in w._retired)
    await _close(w)


@pytest.mark.asyncio
async def test_close_cancels_running_task_and_closes_http():
    w = _Worker()
    closed = []

    async def aclose():
        closed.append(1)

    w._http = SimpleNamespace(aclose=aclose)
    w._client = object()
    w.start()
    await _real_sleep(0)
    task = w._task
    assert not task.done()
    await _close(w)
    assert task.cancelled()
    assert w._task is None
    assert closed == [1]
    assert w._http is None and w._client is None
    await _close(w)  # idempotent


@pytest.mark.asyncio
async def test_close_without_task_or_http_is_noop():
    w = _Worker()
    await _close(w)


@pytest.mark.asyncio
async def test_schedule_cleanup_error_releases_retired_key():
    w = _Worker(fail=RuntimeError("db down"))
    with pytest.raises(RuntimeError):
        await w.schedule_cleanup(3, {"k": "c"})
    assert (3, "c") not in w._retired
    assert not w._cleanup_jobs


@pytest.mark.asyncio
async def test_schedule_cleanup_error_keeps_key_when_job_already_queued():
    w = _Worker(fail=RuntimeError("db down"))
    w._cleanup_jobs[(3, "c")] = ({}, [])
    with pytest.raises(RuntimeError):
        await w.schedule_cleanup(3, {"k": "c"})
    assert (3, "c") in w._retired


@pytest.mark.asyncio
async def test_schedule_cleanup_captures_only_matching_working_rows(monkeypatch):
    w = _Worker()
    monkeypatch.setattr(w, "start", lambda: None)
    mine = SimpleNamespace(id=1, provider_id=3, credential_key="c")
    other = SimpleNamespace(id=2, provider_id=4, credential_key="c")
    w._working_rows = [other, mine]
    await w.schedule_cleanup(3, {"k": "c"})
    assert w._cleanup_jobs[(3, "c")][1] == [mine]
    assert w._providers_dirty is True


def test_default_activation_hook_is_a_noop():
    assert NotifyWorkerLifecycle._on_activated(_Worker()) is None
