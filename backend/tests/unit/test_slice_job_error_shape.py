"""Pins the shape of _SliceJobError and the dispatcher's failure bookkeeping."""

from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.http_status_error import HttpStatusError
from backend.app.services.slice_dispatch import (
    SliceDispatchService,
    SliceJob,
    _SliceJobError,
    http_exception_to_job_error,
)


def test_slice_job_error_shape():
    exc = _SliceJobError(418, "x")
    assert (exc.status_code, exc.detail) == (418, "x")
    assert isinstance(exc, HttpStatusError)
    assert isinstance(exc, Exception)
    assert (str(exc), exc.args, repr(exc)) == ("x", ("x",), "_SliceJobError('x')")


def test_http_exception_to_job_error_stringifies_detail():
    class Fake:
        status_code = 422
        detail = {"a": 1}

    exc = http_exception_to_job_error(Fake())
    assert isinstance(exc, _SliceJobError)
    assert (exc.status_code, exc.detail) == (422, "{'a': 1}")


def _job() -> SliceJob:
    return SliceJob(id=1, kind="archive", source_id=1, source_name="a")


@pytest.mark.asyncio
async def test_run_job_records_slice_job_error():
    svc = SliceDispatchService()
    job = _job()

    async def run(_jid):
        raise _SliceJobError(409, "conflict")

    await svc._run_job(job, run)
    assert (job.status, job.error_status, job.error_detail) == ("failed", 409, "conflict")


@pytest.mark.asyncio
async def test_run_job_records_unexpected_error_as_500():
    svc = SliceDispatchService()
    job = _job()

    async def run(_jid):
        raise RuntimeError("kaput")

    await svc._run_job(job, run)
    assert (job.status, job.error_status, job.error_detail) == ("failed", 500, "Unexpected error: kaput")
    assert job.completed_at is not None


def test_sweep_drops_only_stale_finished_jobs():
    svc = SliceDispatchService()
    old = _job()
    old.status = "completed"
    old.completed_at = datetime.now(timezone.utc) - timedelta(hours=2)
    fresh = SliceJob(id=2, kind="archive", source_id=1, source_name="b", status="completed")
    fresh.completed_at = datetime.now(timezone.utc)
    svc._jobs = {1: old, 2: fresh}
    svc._sweep_locked()
    assert list(svc._jobs) == [2]
