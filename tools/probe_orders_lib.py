"""Shared plumbing of the order-board golden probes (loop tooling, not app code).

Three things every Python probe of the Order Board needs, in one place:

* ``pin_clock()``: a fixed, ticking clock for the order-board modules. The probes
  must print the same bytes at any hour of any day, and the feature reads
  ``date.today()`` (LOCAL day), ``datetime.now(timezone.utc)`` (UTC instants) and
  ``time.monotonic()`` (the 429 back-off window, the write fences). Local time is
  pinned to 2026-03-14 20:30 and UTC to 2026-03-15 06:30: the two calendar days
  differ on purpose (the shop is UTC-10), so code that starts taking "today" from
  UTC moves the output. Every read ticks the clock by one millisecond, so
  "fetched before / after" comparisons keep their real ordering.
* ``temp_db()``: a throw-away SQLite FILE database (never ./bambuddy.db, never
  :memory: with a shared connection) with every table created.
* ``Wire``: an ``httpx.MockTransport`` set on ``zoho_service.transport`` (the
  service's own documented test seam). The real ZohoService runs; what it would
  have put on the wire is recorded (method, path, query, JSON body) and answered
  by the probe's fake Books. Nothing can reach the network.

``leak_check(text)`` is the safety net of the pin: the real calendar day in a
probe's output means some code read the clock outside the pinned modules.
"""

import contextlib
import datetime as _dt
import json
import shutil
import sys
import tempfile
import time as _time
import types

import httpx

LOCAL_NOW = _dt.datetime(2026, 3, 14, 20, 30)
UTC_NOW = _dt.datetime(2026, 3, 15, 6, 30, tzinfo=_dt.timezone.utc)
TODAY = LOCAL_NOW.date()
_REAL_DAYS = {_dt.date.today().isoformat(), _dt.datetime.now(_dt.timezone.utc).date().isoformat()}


def day(offset: int = 0) -> str:
    """The pinned local day shifted by ``offset`` days, ISO."""
    return (TODAY + _dt.timedelta(days=offset)).isoformat()


class Clock:
    def __init__(self):
        self.reads = 0
        self.mono = 1000.0

    def _tick(self) -> _dt.timedelta:
        self.reads += 1
        return _dt.timedelta(milliseconds=self.reads)

    def monotonic(self) -> float:
        self.mono += 0.001
        return self.mono

    def advance(self, seconds: float) -> None:
        """Let ``seconds`` pass on the monotonic clock (ends a 429 back-off window)."""
        self.mono += seconds


clock = Clock()


class FakeDate(_dt.date):
    @classmethod
    def today(cls):
        return cls(TODAY.year, TODAY.month, TODAY.day)


class FakeDateTime(_dt.datetime):
    @classmethod
    def now(cls, tz=None):
        if tz is None:
            moment = LOCAL_NOW + clock._tick()
        else:
            moment = (UTC_NOW + clock._tick()).astimezone(tz)
        return cls(
            moment.year, moment.month, moment.day, moment.hour, moment.minute, moment.second, moment.microsecond,
            tzinfo=moment.tzinfo,
        )

    @classmethod
    def utcnow(cls):
        return cls.now(_dt.timezone.utc).replace(tzinfo=None)

    @classmethod
    def today(cls):
        return cls.now()


class _Shim(types.ModuleType):
    """A module look-alike: the given names replaced, everything else the real module's."""

    def __init__(self, real, **replaced):
        super().__init__(real.__name__)
        self.__dict__["_real"] = real
        self.__dict__.update(replaced)

    def __getattr__(self, name):
        return getattr(self.__dict__["_real"], name)


def pin_clock(match: str = "order_board") -> list[str]:
    """Pin the clock in every imported module whose name contains ``match``, whatever its import style
    (``from datetime import date``, ``import datetime``, ``import time``, ``from time import monotonic``).
    Call it after the app is imported. Returns the module names it touched."""
    swaps = [
        (_dt.date, FakeDate),
        (_dt.datetime, FakeDateTime),
        (_dt, _Shim(_dt, date=FakeDate, datetime=FakeDateTime)),
        (_time, _Shim(_time, monotonic=clock.monotonic)),
        (_time.monotonic, clock.monotonic),
    ]
    touched = []
    for name, module in sorted(sys.modules.items()):
        if match not in name or module is None or name == __name__:
            continue
        for attr, value in list(vars(module).items()):
            for real, fake in swaps:
                if value is real:
                    setattr(module, attr, fake)
                    touched.append(name)
    return sorted(set(touched))


def leak_check(text: str) -> None:
    """Exit loudly when the real calendar day shows in a probe's output."""
    for real_day in sorted(_REAL_DAYS):
        if real_day in text:
            print(f"### PROBE FAILURE: the real day {real_day} leaked into the output (clock pin bypassed)")
            sys.exit(3)


SCRUB_STAMP = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})"


@contextlib.asynccontextmanager
async def temp_db():
    """A session factory on a fresh temp-file SQLite database with every table; removed afterwards."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    import backend.app.main  # noqa: F401  (registers every model on Base.metadata)
    from backend.app.core.database import Base

    folder = tempfile.mkdtemp(prefix="fenrir-orders-probe-")
    engine = create_async_engine(f"sqlite+aiosqlite:///{folder}/probe.db")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    finally:
        await engine.dispose()
        shutil.rmtree(folder, ignore_errors=True)


ZOHO_SETTINGS = {
    "zoho_client_id": "probe-client",
    "zoho_client_secret": "probe-secret",
    "zoho_refresh_token": "probe-refresh",
    "zoho_organization_id": "ORG1",
    "zoho_base_url": "https://api.zoho.test",
    "zoho_accounts_url": "https://accounts.zoho.test",
}


async def set_settings(sessions, values: dict) -> None:
    """Upsert (value) or delete (None) rows of the settings table."""
    from sqlalchemy import select

    from backend.app.models.settings import Settings

    async with sessions() as db:
        for key, value in values.items():
            row = (await db.execute(select(Settings).where(Settings.key == key))).scalar_one_or_none()
            if value is None:
                if row is not None:
                    await db.delete(row)
            elif row is None:
                db.add(Settings(key=key, value=value))
            else:
                row.value = value
        await db.commit()


class Wire:
    """Records what ZohoService sends and answers from ``books(method, path, query, body)``, which returns
    ``(status, json_or_bytes)`` or ``(status, json_or_bytes, headers)``. May be a coroutine function."""

    def __init__(self, books):
        from backend.app.services.zoho import zoho_service

        self.books = books
        self.sent: list = []
        zoho_service.transport = httpx.MockTransport(self._handle)
        zoho_service.invalidate_token()

    def take(self) -> list:
        sent, self.sent = self.sent, []
        return sent

    async def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.url.host == "accounts.zoho.test":
            form = dict(httpx.QueryParams(request.content.decode()))
            self.sent.append(f"{request.method} accounts:{path} form-keys={','.join(sorted(form))}")
            return httpx.Response(200, json={"access_token": "probe-token", "expires_in": 3600})
        if request.url.host != "api.zoho.test" or not path.startswith("/books/v3"):
            self.sent.append(f"### UNEXPECTED HOST {request.method} {request.url}")
            return httpx.Response(599, json={"message": "probe: unexpected host"})
        path = request.url.raw_path.decode().split("?")[0][len("/books/v3") :]  # as sent: escapes kept
        query = dict(sorted(request.url.params.items()))
        body = json.loads(request.content) if request.content else None
        line = f"{request.method} {path}" + ("?" + "&".join(f"{k}={v}" for k, v in query.items()) if query else "")
        if request.headers.get("authorization") != "Zoho-oauthtoken probe-token":
            line += "  ### WRONG AUTH HEADER"
        self.sent.append(line if body is None else {"request": line, "json": body})
        answer = self.books(request.method, path, query, body)
        if hasattr(answer, "__await__"):
            answer = await answer
        status, payload, *rest = answer
        headers = rest[0] if rest else {}
        if isinstance(payload, bytes):
            return httpx.Response(status, content=payload, headers=headers)
        return httpx.Response(status, json=payload, headers=headers)
