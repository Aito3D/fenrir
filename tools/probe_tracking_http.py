"""Golden probe: the tracking feature over HTTP, through the real app.

The service probe pins what the lookup decides; this one pins what the wire
says — the parts a refactor of the ROUTE layer or main.py could change with
every service test still green:

  * the public route's status codes and headers: 404 with `Cache-Control:
    no-store` for an unknown code, 200 with the payload for a real one (typed
    with a hyphen and in lowercase), the miss cap turning into 429 with
    `Retry-After`, and the view log's dedup seen from outside;
  * the SPA serve for `/t`, `/t/<code>`, `/track/…` (and their upper-case
    twins) carrying `X-Robots-Tag: noindex, nofollow` on top of the HTML cache
    contract, while a neighbouring path carries only the cache contract;
  * the two panel routes: `GET …/tracking-link` null until `external_url` is
    set, then the link; `POST …/tracking-token` replacing the code (the old
    one 404s at once), the event it records and the `quote_notes` field for a
    card without a quote.

Wiring mirrors backend/tests/conftest.py's `async_client`: an in-memory
database behind `get_db`, the module-level session makers patched to it, and
no auth (an empty database has no users, so the auth gate is open). Tokens are
random, so every one is replaced by `<TOKEN>` before printing.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_tracking_http.py`.
"""

import asyncio
import json
import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.getcwd())

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from backend.app.api.routes import aito as aito_routes  # noqa: E402
from backend.app.core.database import Base, get_db  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.models import aito_event  # noqa: E402,F401 — registers every table on Base
from backend.app.models.aito_event import AitoEvent  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.models.aito_task import AitoTask  # noqa: E402
from backend.app.models.aito_tracking_view import AitoTrackingView  # noqa: E402
from backend.app.models.settings import Settings  # noqa: E402

HEADERS_OF_INTEREST = ("cache-control", "x-robots-tag", "retry-after", "content-type", "pragma", "expires")


def _headers(r) -> dict:
    return {k: r.headers[k] for k in HEADERS_OF_INTEREST if k in r.headers}


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with maker() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    async def no_printers(db):
        pass

    app.dependency_overrides[get_db] = override_get_db
    out: dict = {}
    tokens: list[str] = []

    def scrub(value):
        if isinstance(value, str):
            for t in tokens:
                value = value.replace(t, "<TOKEN>")
            return value
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items()}
        if isinstance(value, list):
            return [scrub(v) for v in value]
        return value

    with (
        patch("backend.app.core.database.async_session", maker),
        patch("backend.app.core.auth.async_session", maker),
        patch("backend.app.main.async_session", maker),
        patch("backend.app.services.obico_detection.async_session", maker),
        patch("backend.app.api.routes.auth.async_session", maker),
        patch("backend.app.main.init_printer_connections", no_printers),
    ):
        from backend.app.core.database import seed_default_groups

        await seed_default_groups()

        async with maker() as session:
            session.add(
                AitoProject(
                    id=1,
                    description="Card 1",
                    board_column="print",
                    position=100,
                    status="active",
                    client_id="c-1",
                    client_name="Client 1",
                    client_phone="+689 87 00 00 01",
                    quote_status="accepted",
                    tracking_token="K7F3XQ",
                    due_date="2099-01-01",
                    invoice_status="sent",
                    quote_number="DEV-000201",
                )
            )
            session.add(
                AitoProject(
                    id=2,
                    description="Card 2",
                    board_column="devis",
                    position=200,
                    status="active",
                    client_id="c-2",
                    client_name="Client 2",
                    client_phone="+689 87 00 00 02",
                    quote_status="sent",
                    tracking_token=None,
                    quote_number="DEV-000202",
                )
            )
            await session.flush()
            session.add(AitoTask(project_id=1, position=0, title="Pale", impression_cost=70.0, impression_quantity=2))
            session.add(AitoTask(project_id=1, position=1, title="", maindoeuvre_cost=10.0))
            await session.commit()

        aito_routes._reset_track_rate_limits()
        transport = ASGITransport(app=app, client=("1.2.3.4", 5555))
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            r = await client.get("/api/v1/aito/track/ZZZZZZ")
            out["public_unknown"] = {"status": r.status_code, "headers": _headers(r), "body": r.json()}

            r = await client.get("/api/v1/aito/track/k7f-3xq")
            body = r.json()
            body.pop("updated_at", None)  # the seeded row's server_default timestamp — wall clock
            out["public_known_hyphen_lowercase"] = {"status": r.status_code, "headers": _headers(r), "body": body}
            r = await client.get("/api/v1/aito/track/K7F3XQ")
            out["public_known_again_status"] = r.status_code
            r = await client.get("/api/v1/aito/track/K7F3XU")
            out["public_bad_letter"] = {"status": r.status_code, "body": r.json()}
            r = await client.head("/api/v1/aito/track/K7F3XQ")
            out["public_head"] = {"status": r.status_code, "headers": _headers(r)}

            async with maker() as session:
                views = (await session.execute(select(AitoTrackingView))).scalars().all()
                out["view_log_rows_after_three_hits"] = [v.project_id for v in views]

            # The miss cap: count how many misses go through before the 429.
            aito_routes._reset_track_rate_limits()
            served = 0
            first_429 = None
            for i in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP + 3):
                r = await client.get("/api/v1/aito/track/ZZZZZZ")
                if r.status_code == 429:
                    first_429 = {"after_misses": served, "headers": _headers(r), "body": r.json()}
                    break
                served += 1
            out["public_miss_cap"] = first_429
            # Past the cap, hits are refused too (no oracle).
            r = await client.get("/api/v1/aito/track/K7F3XQ")
            out["public_hit_past_cap_status"] = r.status_code
            aito_routes._reset_track_rate_limits()
            r = await client.get("/api/v1/aito/track/K7F3XQ")
            out["public_hit_after_reset_status"] = r.status_code

            out["spa"] = {}
            for path in ["/t", "/T", "/t/", "/t/K7F3XQ", "/T/k7f3xq", "/track", "/track/K7F3XQ", "/tracker", "/tr", "/settings", "/aito"]:
                r = await client.get(path)
                out["spa"][path] = {"status": r.status_code, "headers": _headers(r), "is_html": r.text.lstrip().lower().startswith("<!doctype html")}

            r = await client.get("/api/v1/aito/2/tracking-link")
            out["link_unset"] = {"status": r.status_code, "headers": _headers(r), "body": r.json()}
            async with maker() as session:
                minted = (await session.execute(select(AitoProject.tracking_token).where(AitoProject.id == 2))).scalar_one()
            out["link_unset_minted_anyway"] = {"length": len(minted or ""), "present": bool(minted)}
            tokens.append(minted)

            async with maker() as session:
                session.add(Settings(key="external_url", value="https://aito3d.example"))
                await session.commit()
            r = await client.get("/api/v1/aito/2/tracking-link")
            out["link_set"] = {"status": r.status_code, "headers": _headers(r), "body": scrub(r.json())}
            r = await client.get(f"/api/v1/aito/track/{minted}")
            out["public_minted_status"] = r.status_code

            r = await client.post("/api/v1/aito/2/tracking-token")
            async with maker() as session:
                regenerated = (await session.execute(select(AitoProject.tracking_token).where(AitoProject.id == 2))).scalar_one()
                events = (await session.execute(select(AitoEvent).where(AitoEvent.project_id == 2, AitoEvent.kind == "tracking.regenerated"))).scalars().all()
            tokens.append(regenerated)
            out["regenerate"] = {
                "status": r.status_code,
                "headers": _headers(r),
                "body": scrub(r.json()),
                "token_changed": regenerated != minted,
                "events": [{"kind": e.kind, "actor_class": e.actor_class, "detail": e.detail, "changes": e.changes} for e in events],
            }
            r = await client.get(f"/api/v1/aito/track/{minted}")
            out["public_old_token_after_regenerate_status"] = r.status_code
            r = await client.get(f"/api/v1/aito/track/{regenerated}")
            out["public_new_token_after_regenerate_status"] = r.status_code

            r = await client.get("/api/v1/aito/999/tracking-link")
            out["link_missing_card"] = {"status": r.status_code, "body": r.json()}
            r = await client.post("/api/v1/aito/999/tracking-token")
            out["regenerate_missing_card"] = {"status": r.status_code, "body": r.json()}
            r = await client.get("/api/v1/aito/track/")
            out["public_no_token"] = {"status": r.status_code}

        aito_routes._reset_track_rate_limits()
        from backend.app.core.database import engine as real_engine

        await real_engine.dispose()

    app.dependency_overrides.clear()
    await engine.dispose()
    print(json.dumps(out, indent=2, sort_keys=True, default=str, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
