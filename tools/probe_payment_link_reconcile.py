"""Golden probe (campaign 17): the payment-link reconciler as a state machine.

Each scenario gets a FRESH in-memory database, a scripted Heimdall (an
httpx.MockTransport that answers per request path, and can be told to fail),
and a fixed `now`/`today` passed straight into `reconcile_payment_links` —
so nothing here reads the wall clock. After the pass, the golden records the
whole observable result: every ledger row (key, heimdall id, amount, expiry,
status, url, error, failure count, superseded), every story event the pass
wrote, the project's quote status, and every Heimdall request the pass made,
in order.

This is the §5.4/§5.5 table as evidence rather than prose. It covers the
transitions money depends on: the first mint, the steady state that must
cost nothing, a total/expiry/renumber drift (cancel the old, mint the new,
keep the old row as history), a payment discovered by a poll (paid_at, the
story event, the Books push and the notification that acceptance triggers),
a link that died at Heimdall, a link Heimdall no longer knows (404 →
replace, or → cancel when the quote no longer wants one), the four reasons a
live link is cancelled (declined, invoiced, retainer-covered, trashed), the
per-row backoff after a failure and `force`'s bypass of it, the global 429
stand-down, the wake path's `changes_only` filter, and an unmanaged quote
being left alone.

`push_quote_status` and the payment notification are replaced by recorders:
they are outward calls (Zoho, webhooks), and what matters here is THAT a
paid link triggers them, with which arguments.
"""

import asyncio
import json
import secrets as _secrets
import sys
import time as _time
from datetime import date, datetime, timedelta
from unittest.mock import patch

sys.path.insert(0, ".")

import httpx  # noqa: E402
from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.api.routes.settings import set_setting  # noqa: E402
from backend.app.core.database import Base  # noqa: E402
from backend.app.models.aito_event import AitoEvent  # noqa: E402
from backend.app.models.aito_payment_link import AitoPaymentLink  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.services import aito_payment_links as PL  # noqa: E402
from backend.app.services import heimdall as H  # noqa: E402

TOKEN = "hmd_live.84f32b71ac095ed2.2vy0_YZCo5BscR8UgRTVYTO1NB46EyARcIalbpnJD7o"
BASE_URL = "http://pos.local:8081"
NOW = datetime(2026, 9, 16, 12, 0, 0)
TODAY = date(2026, 9, 16)
LINK_URL = "https://secure.osb.pf/pay/abc"


class Heimdall:
    """A scripted POS bridge that actually HOLDS the payments it mints.

    Statefulness is the point: a poll right after a mint must answer with the
    amount that was just created, and a PATCH must answer with the amended
    one. A stateless fake would echo a fixed 12500 back into `_adopt` and
    quietly erase a deposit or a retainer netting from the golden — the exact
    numbers this probe exists to pin.

    `plan` overrides one `"<METHOD> <path>"` (the 404 / already-paid / 409
    scenarios); `fail_all` fails every request (the 500 and 429 scenarios).
    """

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.created = 0
        self.store: dict[str, dict] = {}
        self.plan: dict[str, tuple] = {}
        self.fail_all: tuple | None = None

    @staticmethod
    def closes_at(days: int) -> str:
        """The `expires_at` real Heimdall reports for an `expires_in_days` of
        `days`: the end of that calendar day, UTC (models/aito_payment_link.py
        — "Heimdall closes it at 23:59:59.999 UTC")."""
        return (TODAY + timedelta(days=int(days))).isoformat() + "T23:59:59.999Z"

    def seed(self, heimdall_id: str, **kw) -> None:
        """Register a payment that already exists at Heimdall — the
        counterpart of a ledger row the scenario starts with."""
        self.store[heimdall_id] = {
            "id": heimdall_id,
            "status": kw.get("status", "pending"),
            "amount": kw.get("amount", 12500),
            "currency": "XPF",
            "reference": kw.get("reference", "DEV-000123"),
            "link": {"url": kw.get("url", LINK_URL), "expires_at": kw.get("expires_at", self.closes_at(15))},
        }

    def transport(self) -> httpx.MockTransport:
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            body = request.content.decode() if request.content else ""
            self.requests.append(
                {
                    "method": request.method,
                    "path": path,
                    "body": body,
                    "idempotency_key": request.headers.get("Idempotency-Key"),
                }
            )
            if self.fail_all is not None:
                status, payload, headers = self.fail_all
                return httpx.Response(status, json=payload, headers=headers or {})
            key = f"{request.method} {path}"
            if key in self.plan:
                status, payload, headers = self.plan[key]
                return httpx.Response(status, json=payload, headers=headers or {})
            if request.method == "POST" and path == "/api/v1/payments":
                self.created += 1
                sent = json.loads(body) if body else {}
                hid = f"hd-new-{self.created}"
                self.seed(
                    hid,
                    amount=sent.get("amount", 0),
                    reference=sent.get("reference", ""),
                    url=f"{LINK_URL}-{self.created}",
                    expires_at=self.closes_at(sent.get("expires_in_days", 15)),
                )
                return httpx.Response(200, json=self.store[hid])
            if path.endswith("/cancel"):
                hid = path.split("/")[-2]
                if hid not in self.store:
                    return httpx.Response(404, json={"error": {"code": "not_found", "message": "no such payment"}})
                self.store[hid]["status"] = "cancelled"
                return httpx.Response(200, json=self.store[hid])
            hid = path.rsplit("/", 1)[-1]
            if hid not in self.store:
                return httpx.Response(404, json={"error": {"code": "not_found", "message": "no such payment"}})
            if request.method == "PATCH":
                sent = json.loads(body) if body else {}
                if "amount" in sent:
                    self.store[hid]["amount"] = sent["amount"]
                # `expires_in_days` must be applied too, not just echoed. The
                # first version of this fake ignored it, which was harmless
                # while `expires_on` came from `wanted` — but once the ledger
                # started storing the expiry Heimdall CONFIRMS (T-012) and the
                # drift branch started checking that the PATCH actually landed
                # (T-011), ignoring it made every expiry drift look like a
                # link Heimdall refuses to converge. That failure cannot
                # happen against real Heimdall, so the golden was recording a
                # false alarm on a money path.
                if "expires_in_days" in sent:
                    self.store[hid]["link"]["expires_at"] = self.closes_at(sent["expires_in_days"])
            return httpx.Response(200, json=self.store[hid])

        return httpx.MockTransport(handler)


def project_kw(**kw) -> dict:
    base = dict(
        description="p",
        board_column="devis",
        position=0,
        status="active",
        quote_id="Q1",
        quote_number="DEV-000123",
        quote_status="sent",
        quote_total=12500.0,
        quote_invoiced=False,
        quote_expiry_date="2026-10-01",
        quote_sync_state="idle",
    )
    base.update(kw)
    return base


def link_kw(**kw) -> dict:
    base = dict(
        project_id=1,
        idempotency_key="aito:1:1",
        heimdall_id="hd-old",
        reference="DEV-000123",
        amount=12500,
        currency="XPF",
        expires_on="2026-10-01",
        status="pending",
        url=LINK_URL,
        sync_failures=0,
    )
    base.update(kw)
    return base


async def dump(db: AsyncSession) -> dict:
    rows = (await db.execute(select(AitoPaymentLink).order_by(AitoPaymentLink.id))).scalars().all()
    events = (await db.execute(select(AitoEvent).order_by(AitoEvent.id))).scalars().all()
    projects = (await db.execute(select(AitoProject).order_by(AitoProject.id))).scalars().all()
    return {
        "links": [
            {
                "project_id": r.project_id,
                "key": r.idempotency_key,
                "heimdall_id": r.heimdall_id,
                "reference": r.reference,
                "amount": r.amount,
                "expires_on": r.expires_on,
                "status": r.status,
                "url": r.url,
                "paid_at": r.paid_at,
                "checked_at": r.checked_at,
                "sync_error": r.sync_error,
                "sync_failures": r.sync_failures,
                "superseded": r.superseded_at is not None,
            }
            for r in rows
        ],
        "events": [
            {"project_id": e.project_id, "kind": e.kind, "actor_class": e.actor_class, "detail": e.detail}
            for e in events
            if (e.kind or "").startswith(("payment_link", "quote."))
        ],
        # `quote_accepted_at` is stamped by apply_quote_decision off its own
        # clock, which this probe does not freeze — WHETHER it was stamped is
        # the behavior that matters, so only presence is recorded.
        "projects": [
            {"id": p.id, "quote_status": p.quote_status, "quote_accepted": p.quote_accepted_at is not None}
            for p in projects
        ],
    }


async def scenario(name: str, *, projects, links=(), hd: Heimdall | None = None, settings=None, **pass_kw) -> dict:
    """One pass over a fresh database. Returns the observable result."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    hd = hd or Heimdall()
    # Every ledger row the scenario starts with has a counterpart at
    # Heimdall, holding the same amount — otherwise a poll would answer with
    # someone else's figure.
    for kw in links:
        if kw.get("heimdall_id"):
            hd.seed(
                kw["heimdall_id"],
                status=kw.get("status", "pending"),
                amount=kw.get("amount", 12500),
                reference=kw.get("reference", "DEV-000123"),
                url=kw.get("url") or LINK_URL,
            )
    H.heimdall_service._transport = hd.transport()
    PL._throttled_until = None

    pushes: list[dict] = []
    notes: list[dict] = []

    async def fake_push(db, project, status):
        pushes.append({"project_id": project.id, "status": status})
        return True

    async def fake_notify(db, **kw):
        notes.append(kw)

    result: dict = {"scenario": name}
    with (
        patch("backend.app.services.aito_quote_status.push_quote_status", fake_push),
        patch(
            "backend.app.services.notification_service.notification_service.on_aito_payment_received",
            fake_notify,
        ),
    ):
        async with sm() as db:
            await set_setting(db, "heimdall_base_url", BASE_URL)
            await set_setting(db, "heimdall_api_token", TOKEN)
            for k, v in (settings or {}).items():
                await set_setting(db, k, v)
            for i, kw in enumerate(projects, start=1):
                db.add(AitoProject(id=i, **kw))
            for kw in links:
                db.add(AitoPaymentLink(**kw))
            await db.commit()

            visited = await PL.reconcile_payment_links(db, now=NOW, today=TODAY, **pass_kw)
            result["visited"] = visited
            result.update(await dump(db))

    result["heimdall_requests"] = hd.requests
    result["books_pushes"] = pushes
    result["notifications"] = notes
    result["throttled"] = PL._throttled_until is not None
    H.heimdall_service._transport = None
    PL._throttled_until = None
    await engine.dispose()
    return result


async def main() -> None:
    _time.time = lambda: 1757707200.0  # type: ignore[assignment]
    _secrets.token_hex = lambda n=32: "0123456789abcdef0123456789abcdef"  # type: ignore[assignment]
    PL._now = lambda: NOW  # type: ignore[assignment]

    out = []

    # 1. Nothing yet: the first mint. One POST, a `created` event, the row
    #    adopted with Heimdall's id and url.
    out.append(await scenario("01-first-mint", projects=[project_kw()]))

    # 2. Steady state: a matching pending link. The reconcile half must do
    #    nothing; the poll half still GETs it (that is how a payment is seen).
    out.append(await scenario("02-steady-state", projects=[project_kw()], links=[link_kw()]))

    # 3. A reservation (heimdall_id NULL) is completed under its OWN key —
    #    never a second POST under a new one.
    out.append(
        await scenario(
            "03-complete-reservation",
            projects=[project_kw()],
            links=[link_kw(heimdall_id=None, url=None, status="pending")],
        )
    )

    # 4. Drift: the total moved. The live link is cancelled and re-minted,
    #    the old row kept as history.
    out.append(await scenario("04-amount-drift", projects=[project_kw(quote_total=9000.0)], links=[link_kw()]))

    # 5. Drift: the expiry moved.
    out.append(
        await scenario("05-expiry-drift", projects=[project_kw(quote_expiry_date="2026-11-30")], links=[link_kw()])
    )

    # 6. Drift: the quote was renumbered — the reference no longer matches.
    out.append(
        await scenario("06-reference-drift", projects=[project_kw(quote_number="DEV-000999")], links=[link_kw()])
    )

    # 7. A deposit percentage: the link asks for the deposit, rounded up.
    out.append(await scenario("07-deposit-30pct", projects=[project_kw()], settings={"aito_deposit_pct": "30"}))

    # 8. Retainers already paid: the link asks only for the remainder.
    out.append(await scenario("08-retainer-partial", projects=[project_kw(retainer_paid_total=2500.5)]))

    # 9. The poll finds it PAID: paid_at, the story event, the acceptance,
    #    the Books push and the notification.
    hd = Heimdall()
    hd.plan["GET /api/v1/payments/hd-old"] = (
        200,
        {
            "id": "hd-old",
            "status": "paid",
            "amount": 12500,
            "currency": "XPF",
            "reference": "DEV-000123",
            "link": {"url": LINK_URL, "expires_at": "2026-10-01T23:59:59.999Z"},
        },
        None,
    )
    out.append(await scenario("09-poll-finds-paid", projects=[project_kw()], links=[link_kw()], hd=hd))

    # 10. An already-paid row is never touched again, by either half.
    out.append(await scenario("10-already-paid", projects=[project_kw()], links=[link_kw(status="paid", paid_at=NOW)]))

    # 11. The link died at Heimdall (expired) but the quote still wants one:
    #     a fresh link, the dead row kept.
    for dead in ("expired", "cancelled", "failed"):
        out.append(
            await scenario(f"11-dead-{dead}-still-wanted", projects=[project_kw()], links=[link_kw(status=dead)])
        )

    # 12. Heimdall no longer knows the id (404) and the quote still wants a
    #     link: the row goes dead with no backoff and a replacement is minted
    #     in the same pass.
    hd = Heimdall()
    hd.plan["GET /api/v1/payments/hd-old"] = (404, {"error": {"code": "not_found", "message": "gone"}}, None)
    out.append(await scenario("12-lost-link-replaced", projects=[project_kw()], links=[link_kw()], hd=hd))

    # 13. The same 404 when the quote no longer wants a link: told once as a
    #     cancellation, nothing minted.
    hd = Heimdall()
    hd.plan["GET /api/v1/payments/hd-old"] = (404, {"error": {"code": "not_found", "message": "gone"}}, None)
    out.append(
        await scenario(
            "13-lost-link-unwanted", projects=[project_kw(quote_status="declined")], links=[link_kw()], hd=hd
        )
    )

    # 14. The four reasons a live link is cancelled.
    for label, kw in [
        ("declined", {"quote_status": "declined"}),
        ("expired-quote", {"quote_status": "expired"}),
        ("invoiced", {"quote_invoiced": True}),
        ("retainer-covers", {"retainer_paid_total": 99999.0}),
        ("trashed", {"status": "deleted"}),
        ("total-zeroed", {"quote_total": 0.0}),
    ]:
        out.append(await scenario(f"14-cancel-{label}", projects=[project_kw(**kw)], links=[link_kw()]))

    # 15. A Heimdall 500: the error lands on the row, the failure count goes
    #     up, and the row is then inside its backoff window.
    hd = Heimdall()
    hd.fail_all = (500, {"error": {"code": "internal", "message": "POS down"}}, None)
    out.append(await scenario("15-upstream-500", projects=[project_kw()], links=[link_kw()], hd=hd))

    # 16. A row inside its backoff window is skipped — unless force.
    out.append(
        await scenario(
            "16-backoff-skips",
            projects=[project_kw(quote_total=9000.0)],
            links=[link_kw(sync_failures=2, checked_at=NOW, sync_error="earlier failure")],
        )
    )
    out.append(
        await scenario(
            "16b-force-bypasses-backoff",
            projects=[project_kw(quote_total=9000.0)],
            links=[link_kw(sync_failures=2, checked_at=NOW, sync_error="earlier failure")],
            force=True,
        )
    )

    # 17. A 429 arms the global stand-down for the whole reconciler.
    hd = Heimdall()
    hd.fail_all = (429, {"error": {"code": "rate_limited"}}, {"Retry-After": "30"})
    out.append(await scenario("17-rate-limited", projects=[project_kw(), project_kw()], links=[link_kw()], hd=hd))

    # 18. The wake path: only the projects whose link drifted are visited,
    #     and the poll half is skipped entirely.
    out.append(
        await scenario(
            "18-changes-only-skips-steady",
            projects=[project_kw()],
            links=[link_kw()],
            changes_only=True,
        )
    )
    out.append(
        await scenario(
            "18b-changes-only-visits-drift",
            projects=[project_kw(quote_total=9000.0)],
            links=[link_kw()],
            changes_only=True,
        )
    )

    # 19. only_project_id confines the pass to one project.
    out.append(
        await scenario(
            "19-only-project-id",
            projects=[project_kw(), project_kw(quote_number="DEV-000222")],
            only_project_id=1,
        )
    )

    # 20. An unmanaged quote is never touched.
    out.append(await scenario("20-unmanaged-skipped", projects=[project_kw(quote_sync_state="unmanaged")]))

    # 21. No quote number at all: not even selected.
    out.append(await scenario("21-no-quote-number", projects=[project_kw(quote_number=None)]))

    # 22. A cancel that races a payment: Heimdall answers 409, the poll then
    #     shows paid. What the reconciler does with the money.
    hd = Heimdall()
    hd.plan["POST /api/v1/payments/hd-old/cancel"] = (
        409,
        {"error": {"code": "conflict_state", "message": "already paid"}},
        None,
    )
    hd.plan["GET /api/v1/payments/hd-old"] = (
        200,
        {
            "id": "hd-old",
            "status": "paid",
            "amount": 12500,
            "currency": "XPF",
            "reference": "DEV-000123",
            "link": {"url": LINK_URL},
        },
        None,
    )
    out.append(
        await scenario(
            "22-cancel-races-payment", projects=[project_kw(quote_status="declined")], links=[link_kw()], hd=hd
        )
    )

    # 23. A patch that races a payment: same question on the drift path.
    hd = Heimdall()
    hd.plan["PATCH /api/v1/payments/hd-old"] = (
        409,
        {"error": {"code": "conflict_state", "message": "already paid"}},
        None,
    )
    hd.plan["GET /api/v1/payments/hd-old"] = (
        200,
        {
            "id": "hd-old",
            "status": "paid",
            "amount": 12500,
            "currency": "XPF",
            "reference": "DEV-000123",
            "link": {"url": LINK_URL},
        },
        None,
    )
    out.append(
        await scenario("23-patch-races-payment", projects=[project_kw(quote_total=9000.0)], links=[link_kw()], hd=hd)
    )

    # 24. Many pending links: the per-tick polling budget.
    many_projects = [project_kw(quote_number=f"DEV-{i:06d}") for i in range(1, PL.MAX_POLLS_PER_TICK + 6)]
    many_links = [
        link_kw(project_id=i, idempotency_key=f"aito:{i}:1", heimdall_id=f"hd-{i}", reference=f"DEV-{i:06d}")
        for i in range(1, PL.MAX_POLLS_PER_TICK + 6)
    ]
    big = await scenario("24-poll-budget", projects=many_projects, links=many_links)
    # Only the counts matter here, not 45 identical rows.
    out.append(
        {
            "scenario": big["scenario"],
            "visited": big["visited"],
            "project_count": len(many_projects),
            "max_polls_per_tick": PL.MAX_POLLS_PER_TICK,
            "heimdall_request_count": len(big["heimdall_requests"]),
            "get_count": sum(1 for r in big["heimdall_requests"] if r["method"] == "GET"),
            "post_count": sum(1 for r in big["heimdall_requests"] if r["method"] == "POST"),
        }
    )

    # 25. Heimdall not configured: a silent no-op, no requests at all.
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    hd = Heimdall()
    H.heimdall_service._transport = hd.transport()
    async with sm() as db:
        db.add(AitoProject(id=1, **project_kw()))
        await db.commit()
        visited = await PL.reconcile_payment_links(db, now=NOW, today=TODAY)
        out.append(
            {
                "scenario": "25-not-configured",
                "visited": visited,
                "heimdall_requests": hd.requests,
                **(await dump(db)),
            }
        )
    H.heimdall_service._transport = None
    await engine.dispose()

    await asyncio.sleep(0.05)
    print(json.dumps(out, sort_keys=True, indent=1, default=str))


asyncio.run(main())
