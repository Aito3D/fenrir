"""Golden probe (campaign 16): the settings REST API, end to end over HTTP.

Drives the real FastAPI app through httpx's ASGI transport against a fresh
in-memory SQLite database, mirroring backend/tests/conftest.py's async_client
fixture (same get_db override, same module-level session patches). Auth is
off because the database has no users, exactly as in the integration tests.

The sequence covers what a settings user observes: the fresh defaults, the
unauthenticated /ui-preferences and /default-sidebar-order projections, a
PATCH mixing boolean spellings / numbers / strings and its read-back, the
422s for a bad type, an out-of-range value and an unknown field, the
electricity-price shortcut, the local-login lock-out refusal, credential
fields as a user sees them versus blanked for an API-key caller, and reset.
Only endpoints whose output does not depend on the host machine are called
(no ffmpeg / go2rtc / network-interface probes, no backup / restore).
"""

import asyncio
import json
import sys
from unittest.mock import patch

sys.path.insert(0, ".")

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.core.auth import caller_is_api_key  # noqa: E402
from backend.app.core.database import Base, get_db  # noqa: E402
from backend.app.main import app  # noqa: E402

B = "/api/v1/settings"


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with sm() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db
    out = []

    def rec(step, r):
        ct = r.headers.get("content-type", "")
        body = r.json() if ct.startswith("application/json") else r.text
        out.append({"step": step, "status": r.status_code, "body": body})

    with (
        patch("backend.app.core.database.async_session", sm),
        patch("backend.app.core.auth.async_session", sm),
        patch("backend.app.main.async_session", sm),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            rec("01-get-fresh", await c.get(B))
            rec("02-ui-preferences-fresh", await c.get(B + "/ui-preferences"))
            rec("03-default-sidebar-order-fresh", await c.get(B + "/default-sidebar-order"))
            rec("04-virtual-printer-models", await c.get(B + "/virtual-printer/models"))
            rec("05-virtual-printer-fresh", await c.get(B + "/virtual-printer"))
            rec("06-spoolman-fresh", await c.get(B + "/spoolman"))
            rec(
                "07-patch-mixed",
                await c.patch(
                    B,
                    json={
                        "require_plate_clear": "yes",
                        "check_printer_firmware": "off",
                        "time_format": "24h",
                        "energy_cost_per_kwh": 0.42,
                        "default_sidebar_order": '["printers","queue","archives"]',
                        "ams_humidity_good": 35,
                    },
                ),
            )
            rec("08-get-after-patch", await c.get(B))
            rec("09-ui-preferences-after-patch", await c.get(B + "/ui-preferences"))
            rec("10-default-sidebar-order-after-patch", await c.get(B + "/default-sidebar-order"))
            rec("11-patch-bad-type", await c.patch(B, json={"energy_cost_per_kwh": "not-a-number"}))
            rec("12-patch-out-of-range", await c.patch(B, json={"aito_deposit_pct": 250}))
            rec("13-patch-unknown-field", await c.patch(B, json={"no_such_setting": 1}))
            rec("14-patch-empty", await c.patch(B, json={}))
            rec("14b-patch-sidebar-not-json", await c.patch(B, json={"default_sidebar_order": "printers,queue"}))
            rec("15-electricity-price", await c.post(B + "/electricity-price", json={"energy_cost_per_kwh": 0.3}))
            rec("16-electricity-price-negative", await c.post(B + "/electricity-price", json={"energy_cost_per_kwh": -1}))
            rec("17-get-after-electricity", await c.get(B))
            rec("18-put-disable-local-login-refused", await c.put(B + "/", json={"local_login_enabled": False}))
            rec(
                "19-put-secrets",
                await c.put(B + "/", json={"mqtt_password": "hunter2", "ha_token": "ha-tok", "zoho_client_secret": "zsec"}),
            )
            rec("20-get-secrets-as-user", await c.get(B))
            app.dependency_overrides[caller_is_api_key] = lambda: True
            rec("21-get-secrets-as-api-key", await c.get(B))
            del app.dependency_overrides[caller_is_api_key]
            rec("22-reset", await c.post(B + "/reset"))
            rec("23-get-after-reset", await c.get(B))
            rec("24-ui-preferences-after-reset", await c.get(B + "/ui-preferences"))

    app.dependency_overrides.clear()
    await engine.dispose()
    await asyncio.sleep(0.1)
    print(json.dumps(out, sort_keys=True, indent=1, default=str))


asyncio.run(main())
