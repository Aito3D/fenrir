"""Golden probe: the client tracking feature's backend, end to end.

`compute_tracking` (services/aito_tracking.py) turns a typed code plus a card,
its tasks, its event log and its payment ledger into the one payload the public
page draws. Everything the client sees — the stage, the parts and their counts,
the ETA, the shipping line, the invoice and payment states, the "Mis à jour"
moment — and everything they must NOT see (a trashed, declined, expired or
dormant card, all folded into one 404) is decided here. So this pins:

  * the lookup across every shape of card the service distinguishes, driven
    against a seeded in-memory database at a frozen clock;
  * the code normalisation table (case, separators, look-alike letters, the
    legacy 43-character token);
  * the pure helpers the sync and SMS paths reuse: notes merging, SMS layout,
    task quantities, expiry, invoice-state mapping, URL building;
  * the module-level constants the rules are expressed in — TTLs, alphabets,
    prefixes — plus the public route's rate-limit caps and network keying, and
    main.py's tracking-page detection and the headers it attaches.

Determinism: the clock is passed in (NOW below), every seeded timestamp is a
literal, and the one random path (minting) is asserted on its properties only.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_tracking_backend.py`.
"""

import asyncio
import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.getcwd())

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from backend.app.api.routes import aito as aito_routes  # noqa: E402
from backend.app.core.database import Base  # noqa: E402
from backend.app.main import _TRACKING_HTML_HEADERS, PUBLIC_API_PREFIXES, _is_tracking_page  # noqa: E402
from backend.app.models.aito_event import AitoEvent  # noqa: E402
from backend.app.models.aito_payment_link import AitoPaymentLink  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.models.aito_task import AitoTask  # noqa: E402
from backend.app.models.aito_tracking_view import AitoTrackingView  # noqa: E402
from backend.app.models.settings import Settings  # noqa: E402
from backend.app.services import aito_tracking as svc  # noqa: E402

NOW = datetime(2026, 3, 15, 12, 0, 0)
LEGACY = "lQ38LSKdM7M9yUTn-7dvl_03NqAXCZP1hlqvpvMNKT4"


def _dt(spec: str) -> datetime:
    return datetime.strptime(spec, "%Y-%m-%d %H:%M:%S")


# --- Fixture -----------------------------------------------------------------
# One card per shape the lookup distinguishes. Fields: id, column, status,
# quote_status, token, due_date, shipping (island, service, lta), invoice_status,
# quote_number, updated_at. `updated_at` is the fallback "last activity" for a
# card without events; the column's server_default is func.now(), so it is set
# explicitly on every row.
PROJECTS = [
    (1, "devis", "active", "sent", "K7F3XQ", "2026-03-20", None, None, "DEV-000101", "2026-03-10 09:00:00"),
    (2, "waiting", "active", "sent", "WA1T01", None, None, "sent", "DEV-000102", "2026-03-01 09:00:00"),
    (3, "print", "active", "accepted", "PR1NT1", "2026-03-30", None, "partially_paid", "DEV-000103", "2026-03-12 09:00:00"),
    (4, "finish", "active", "accepted", "F1N001", "2026-03-01", None, "paid", "DEV-000104", "2026-03-13 09:00:00"),
    (5, "done", "active", "accepted", "D0NE01", None, ("moorea", "air", "AWB-123"), "overdue", "DEV-000105", "2026-03-02 09:00:00"),
    (6, "done", "active", "accepted", "D0NE02", None, None, "paid", "DEV-000106", "2026-01-02 09:00:00"),
    (7, "done", "active", "accepted", "D0NE03", None, ("atoll-x", "weird", None), None, "", "2026-03-10 09:00:00"),
    (8, "devis", "active", "sent", "D0RM01", None, None, None, "DEV-000108", "2025-06-01 09:00:00"),
    (9, "devis", "deleted", "sent", "TRASH1", None, None, None, "DEV-000109", "2026-03-10 09:00:00"),
    (10, "scan", "active", "declined", "DECL01", None, None, None, "DEV-000110", "2026-03-10 09:00:00"),
    (11, "scan", "active", "expired", "EXPQ01", None, None, None, "DEV-000111", "2026-03-10 09:00:00"),
    (12, "model", "active", "accepted", LEGACY, "2026-03-01", None, "unpaid", "DEV-000112", "2026-03-05 09:00:00"),
    (13, "model", "active", "accepted", "PAYDEP", None, None, None, "DEV-000113", "2026-03-14 09:00:00"),
    (14, "model", "active", "accepted", "PAYEXP", None, None, None, "DEV-000114", "2026-03-14 09:00:00"),
    (15, "waiting", "active", "accepted", "PAYN0H", None, None, None, "DEV-000115", "2026-03-14 09:00:00"),
]

# project, title, service columns — every quantity rule in one card (1), a
# labour-only task (no count), and titles that need the fallback.
TASKS = [
    (1, "Boîtier", {"scan_cost": 100.0, "scan_quantity": 3, "impression_cost": 50.0, "impression_quantity": 3}),
    (1, "", {"maindoeuvre_cost": 10.0}),
    (1, "Support", {"scan_cost": 5.0, "scan_quantity": 2, "impression_cost": 5.0, "impression_quantity": 4}),
    (1, "Capot", {"impression_cost": 7.0, "impression_quantity": 1}),
    (1, "  Vis  ", {"usinage_cost": 7.0, "usinage_quantity": 12, "maindoeuvre_cost": 3.0}),
    (1, None, {"modelisation_cost": 7.0}),
    (3, "Pale", {"impression_cost": 70.0, "impression_quantity": 2}),
    (5, "Coque", {"impression_cost": 70.0, "impression_quantity": 1}),
]

# project, kind, occurred_at, occurred_until, changes
EVENTS = [
    (2, "project.updated", "2026-03-14 10:00:00", None, None),
    (5, "stage.changed", "2026-02-20 10:00:00", None, [{"field": "column", "from": "print", "to": "finish"}]),
    (5, "stage.changed", "2026-03-01 10:00:00", None, [{"field": "column", "from": "finish", "to": "done"}]),
    (5, "project.updated", "2026-03-03 10:00:00", None, None),
    (6, "stage.changed", "2026-01-01 10:00:00", None, [{"field": "column", "from": "finish", "to": "done"}]),
    # A folded edit session: last activity is the window's END.
    (12, "project.updated", "2026-03-12 10:00:00", "2026-03-12 11:30:00", None),
    # A stage move away from done is not a move into it.
    (7, "stage.changed", "2026-03-09 10:00:00", None, [{"field": "column", "from": "done", "to": "finish"}]),
]

# project, heimdall_id, status, url, superseded
PAYMENT_LINKS = [
    (2, "h-2", "pending", "https://pay.example/2", False),  # quote not accepted -> None
    (3, "h-3", "pending", "https://pay.example/3", False),  # unpaid, with URL
    (4, "h-4", "paid", "https://pay.example/4", False),  # paid
    (13, "h-13a", "pending", "https://pay.example/13a", True),  # superseded, ignored
    (13, "h-13b", "pending", "https://pay.example/13b", False),  # current
    (14, "h-14", "expired", "https://pay.example/14", False),  # dead link -> None
    (15, None, "pending", None, False),  # never created -> None
]


async def _seed(session: AsyncSession, deposit_pct: str | None) -> None:
    for pid, column, status, qstatus, token, due, shipping, invoice, number, updated in PROJECTS:
        island, service, lta = shipping or (None, None, None)
        session.add(
            AitoProject(
                id=pid,
                description=f"Card {pid}",
                board_column=column,
                position=pid * 100,
                status=status,
                client_id=f"c-{pid}",
                client_name=f"Client {pid}",
                quote_status=qstatus,
                tracking_token=token,
                due_date=due,
                shipping_island=island,
                shipping_service=service,
                shipping_lta=lta,
                invoice_status=invoice,
                quote_number=number,
                created_at=_dt("2026-01-01 08:00:00"),
                updated_at=_dt(updated),
            )
        )
    await session.flush()
    for i, (pid, title, cols) in enumerate(TASKS):
        session.add(AitoTask(project_id=pid, position=i, title=title, **cols))
    for pid, kind, at, until, changes in EVENTS:
        session.add(
            AitoEvent(
                project_id=pid,
                occurred_at=_dt(at),
                occurred_until=_dt(until) if until else None,
                kind=kind,
                actor_class="user",
                changes=changes,
            )
        )
    for i, (pid, hid, status, url, superseded) in enumerate(PAYMENT_LINKS):
        session.add(
            AitoPaymentLink(
                project_id=pid,
                idempotency_key=f"key-{i}",
                heimdall_id=hid,
                reference=f"DEV/{pid}",
                amount=1000,
                expires_on="2026-12-31",
                url=url,
                status=status,
                superseded_at=_dt("2026-03-01 00:00:00") if superseded else None,
            )
        )
    if deposit_pct is not None:
        session.add(Settings(key="aito_deposit_pct", value=deposit_pct))
    await session.commit()


LOOKUPS = [
    ("devis_exact", "K7F3XQ"),
    ("devis_lowercase", "k7f3xq"),
    ("devis_hyphen_space", " k7f-3xq "),
    ("waiting_unpaid_no_payment", "WA1T01"),
    ("waiting_lookalikes", "walt0l"),
    ("print_pending_link", "PR1NT1"),
    ("finish_paid", "F1N001"),
    ("done_shipped_lta", "D0NE01"),
    ("done_expired", "D0NE02"),
    ("done_no_stage_event_cold_labels", "D0NE03"),
    ("devis_dormant", "D0RM01"),
    ("trashed", "TRASH1"),
    ("declined_quote", "DECL01"),
    ("expired_quote", "EXPQ01"),
    ("legacy_token_folded_activity", LEGACY),
    ("legacy_token_lowercased_is_another_token", LEGACY.lower()),
    ("deposit_link_current_not_superseded", "PAYDEP"),
    ("dead_link", "PAYEXP"),
    ("link_never_created", "PAYN0H"),
    ("unknown", "ZZZZZZ"),
    ("too_short", "K7F3X"),
    ("bad_letter_u", "K7F3XU"),
    ("empty", ""),
]

SHIPPING_NAMES = {"air": "Fret aérien"}
ISLAND_LABELS = {key: label for _s, islands in __import__("backend.app.services.aito_shipping", fromlist=["grouped_islands"]).grouped_islands() for key, label in islands}


async def _lookups(deposit_pct: str | None) -> dict:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    out: dict = {}
    async with maker() as session:
        await _seed(session, deposit_pct)
        for label, raw in LOOKUPS:
            found = await svc.compute_tracking(session, raw, SHIPPING_NAMES, ISLAND_LABELS, NOW)
            out[label] = None if found is None else {"project_id": found[0], "data": found[1].model_dump(mode="json")}

        # The view log: two opens inside the window write one row, a third
        # past it writes another.
        await svc.log_view(session, 1, NOW)
        await svc.log_view(session, 1, NOW + timedelta(minutes=2))
        await svc.log_view(session, 1, NOW + timedelta(minutes=6))
        await svc.log_view(session, 3, NOW)
        rows = (
            await session.execute(
                select(AitoTrackingView.project_id, func.count()).group_by(AitoTrackingView.project_id)
            )
        ).all()
        out["_view_log"] = {str(pid): n for pid, n in rows}

        # Minting: random, so only its shape and stability are recorded.
        project = (await session.execute(select(AitoProject).where(AitoProject.id == 1))).scalar_one()
        project.tracking_token = None
        await session.commit()
        first = await svc.ensure_tracking_token(session, project)
        second = await svc.ensure_tracking_token(session, project)
        await session.commit()
        out["_mint"] = {
            "length": len(first),
            "alphabet_ok": all(c in svc.TOKEN_ALPHABET for c in first),
            "stable": first == second,
            "persisted": (await session.execute(select(AitoProject.tracking_token).where(AitoProject.id == 1))).scalar_one() == first,
        }
        # URL building through the setting, before and after it is set.
        out["_url_unset"] = await svc.tracking_url(session, project)
        session.add(Settings(key="external_url", value="https://aito3d.example/ "))
        await session.commit()
        out["_url_set"] = (await svc.tracking_url(session, project)).replace(first, "<TOKEN>")
        out["_build_url_set"] = (await svc.build_tracking_url(session, project)).replace(first, "<TOKEN>")
    await engine.dispose()
    return out


def _pure() -> dict:
    out: dict = {}
    out["normalize_token"] = {
        raw: svc.normalize_token(raw)
        for raw in ["K7F3XQ", "k7f3xq", "k7f-3xq", " K7F 3XQ ", "kof3lq", "KIF3XQ", "K7F3X", "K7F3XQ9", "K7F3XU", "K7F3X!", "", "k7f3xq\n", LEGACY, "x" * 20, "x" * 19]
    }
    grid = {}
    for column in ["devis", "waiting", "scan", "model", "print", "finish", "done", "unknown"]:
        for label, finished, active in [
            ("fresh", None, NOW - timedelta(days=1)),
            ("29d", None, NOW - timedelta(days=29)),
            ("31d", None, NOW - timedelta(days=31)),
            ("179d", None, NOW - timedelta(days=179)),
            ("181d", None, NOW - timedelta(days=181)),
            ("finished_29d_active_200d", NOW - timedelta(days=29), NOW - timedelta(days=200)),
            ("finished_31d_active_1d", NOW - timedelta(days=31), NOW - timedelta(days=1)),
        ]:
            grid[f"{column}/{label}"] = svc.is_expired(column, finished, active, NOW)
    out["is_expired"] = grid
    out["invoice_state"] = {
        str(s): svc.invoice_state(s) for s in [None, "", "paid", "overdue", "sent", "unpaid", "partially_paid", "void", "draft"]
    }
    out["tracking_url_for"] = {
        "empty_base": svc.tracking_url_for("", "ABC123"),
        "no_token": svc.tracking_url_for("https://x.pf", None),
        "both": svc.tracking_url_for("https://x.pf", "ABC123"),
    }
    out["tracking_notes"] = {
        "short": svc.tracking_notes("https://x.pf/t/ABC123", "ABC123"),
        "legacy": svc.tracking_notes(f"https://x.pf/t/{LEGACY}", LEGACY),
    }
    url = "https://x.pf/t/ABC123"
    block = svc.tracking_notes(url, "ABC123")
    org = "Signature du client (précédée de la mention « Bon pour accord »)"
    cases = {
        "none": None,
        "empty": "",
        "org_default": org,
        "org_with_trailing_spaces": org + "   \n\n",
        "already_current": f"{org}\n\n{block}",
        "legacy_2026_09_08": f"{org}\nSuivez votre commande : https://x.pf/track/OLD",
        "legacy_2026_09_18": f"{org}\nLien de suivi de votre projet : https://x.pf/t/OLD\nCode de suivi : OLD123",
        "operator_lines_kept_verbatim": f"{org}\nMerci de votre confiance   \n{block}\nPS: livraison vendredi",
        "regenerated_token": f"{org}\n\n{svc.tracking_notes('https://x.pf/t/OLD123', 'OLD123')}",
    }
    out["with_tracking_notes"] = {k: svc.with_tracking_notes(v, url, "ABC123") for k, v in cases.items()}
    out["with_tracking_sms"] = {
        "signed": svc.with_tracking_sms("Bonjour Jean,\nVos pièces sont prêtes.\nAito3D", url),
        "signed_trailing_ws": svc.with_tracking_sms("Bonjour Jean,\nVos pièces sont prêtes.\nAito3D  \n", url),
        "unsigned": svc.with_tracking_sms("Bonjour Jean, vos pièces sont prêtes.", url),
        "signature_mid_text": svc.with_tracking_sms("Aito3D vous informe : prêt.", url),
        "empty": svc.with_tracking_sms("", url),
    }

    def task(**cols):
        return AitoTask(project_id=0, position=0, title="t", **cols)

    out["task_quantity"] = {
        "no_services": svc.task_quantity(task()),
        "labour_only": svc.task_quantity(task(maindoeuvre_cost=1.0)),
        "one_service_qty_1": svc.task_quantity(task(scan_cost=1.0, scan_quantity=1)),
        "one_service_qty_none": svc.task_quantity(task(scan_cost=1.0)),
        "one_service_qty_4": svc.task_quantity(task(scan_cost=1.0, scan_quantity=4)),
        "two_services_same": svc.task_quantity(task(scan_cost=1.0, scan_quantity=4, usinage_cost=1.0, usinage_quantity=4)),
        "two_services_differ": svc.task_quantity(task(scan_cost=1.0, scan_quantity=4, usinage_cost=1.0, usinage_quantity=2)),
        "unpriced_service_qty_ignored": svc.task_quantity(task(scan_cost=1.0, scan_quantity=4, usinage_quantity=2)),
        "zero_cost_is_priced": svc.task_quantity(task(impression_cost=0.0, impression_quantity=5)),
        "labour_plus_service": svc.task_quantity(task(impression_cost=2.0, impression_quantity=5, maindoeuvre_cost=1.0)),
    }
    out["constants"] = {
        "TOKEN_ALPHABET": svc.TOKEN_ALPHABET,
        "TOKEN_LENGTH": svc.TOKEN_LENGTH,
        "LEGACY_TOKEN_MIN_LENGTH": svc.LEGACY_TOKEN_MIN_LENGTH,
        "TRACKING_TTL_AFTER_DONE_days": svc.TRACKING_TTL_AFTER_DONE / timedelta(days=1),
        "TRACKING_TTL_DORMANT_days": svc.TRACKING_TTL_DORMANT / timedelta(days=1),
        "DORMANT_COLUMNS": sorted(svc.DORMANT_COLUMNS),
        "CLOSED_QUOTE_STATUSES": sorted(svc.CLOSED_QUOTE_STATUSES),
        "NOTES_PREFIX": svc.NOTES_PREFIX,
        "NOTES_CODE_PREFIX": svc.NOTES_CODE_PREFIX,
        "_LEGACY_NOTES_PREFIXES": list(svc._LEGACY_NOTES_PREFIXES),
        "SMS_PREFIX": svc.SMS_PREFIX,
        "SMS_SIGNATURE": svc.SMS_SIGNATURE,
        "SMS_SIGNATURE_SEP": svc.SMS_SIGNATURE_SEP,
        "TASK_FALLBACK": svc.TASK_FALLBACK,
        "VIEW_DEDUP_WINDOW_s": svc.VIEW_DEDUP_WINDOW / timedelta(seconds=1),
        "_INVOICE_STATE": dict(svc._INVOICE_STATE),
        "_SERVICE_COUNTS": [list(pair) for pair in svc._SERVICE_COUNTS],
    }
    out["route_limiter"] = {
        "WINDOW_S": aito_routes._TRACK_RATE_WINDOW_S,
        "MAX_MISSES_PER_IP": aito_routes._TRACK_RATE_MAX_MISSES_PER_IP,
        "MAX_MISSES_PER_NET": aito_routes._TRACK_RATE_MAX_MISSES_PER_NET,
        "MAX_CALLS_PER_IP": aito_routes._TRACK_RATE_MAX_CALLS_PER_IP,
        "SWEEP_ABOVE": aito_routes._TRACK_RATE_SWEEP_ABOVE,
        "net_key": {
            h: aito_routes._track_rate_net_key(h)
            for h in ["1.2.3.4", "10.0.0.5", "203.0.113.200", "2001:db8:1:2:3:4:5:6", "::1", "testclient", "__no_ip_x", ""]
        },
    }
    out["main"] = {
        "is_tracking_page": {
            p: _is_tracking_page(p)
            for p in ["t", "T", "track", "TRACK", "t/", "t/ABC123", "T/abc123", "track/ABC123", "tracker", "tr", "settings", "", "api/v1/aito/track/x", "trackx/1"]
        },
        "tracking_html_headers": dict(_TRACKING_HTML_HEADERS),
        "public_api_prefixes_tracking": [p for p in PUBLIC_API_PREFIXES if "track" in p],
    }
    return out


async def main() -> None:
    out = {
        "lookups": await _lookups(None),
        "lookups_with_deposit": {k: v for k, v in (await _lookups("30")).items() if k in ("print_pending_link", "finish_paid", "deposit_link_current_not_superseded")},
        "pure": _pure(),
    }
    print(json.dumps(out, indent=2, sort_keys=True, default=str, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
