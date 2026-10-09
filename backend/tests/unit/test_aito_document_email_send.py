"""Characterization of the two document-email send routes (T-160).

POST /aito/{id}/retainer-email and POST /aito/{id}/invoice-email share one
send skeleton. These tests pin, for BOTH, the exact order of side effects
(Books calls, record, commit, rollbacks, broadcast), the refusal ladder
(429, 422, 409), the Books-error mapping and the guard release rule, the
send-succeeded-but-record-failed path, the partial re-read degrade, the exact
log lines, and the response bodies.
"""

import logging

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes import aito as aito_routes
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)

pytestmark = pytest.mark.asyncio

# get_db's own tail, outside the route: commit when the handler returns,
# rollback when it raises.
GET_DB_OK = "commit"
GET_DB_RAISED = "rollback"

KINDS = ["retainer", "invoice"]

RECIPIENTS = [
    {"email": "contact@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
    {"email": "compta@example.pf", "name": "Compta", "contact_person_id": "cp-2"},
]
RETAINER = {
    "id": "RET-B",
    "number": "AC-26-0031",
    "date": "2026-09-03",
    "total": 17500.0,
    "balance": 0.0,
    "currency_code": "XPF",
    "status": "draft",
}
INVOICE = {
    "id": "INV-7",
    "number": "INV-00087",
    "date": "2026-08-18",
    "due_date": "2026-09-18",
    "total": 45000.0,
    "balance": 45000.0,
    "currency_code": "XPF",
    "status": "draft",
}
OLDER_INVOICE = {**INVOICE, "id": "INV-6", "number": "INV-00086"}


class _FakeClock:
    def __init__(self, start: float = 1000.0):
        self.now = start

    def monotonic(self) -> float:
        return self.now


class Rig:
    """Books fakes for both kinds plus a trace of every side effect, in order."""

    def __init__(self):
        self.trace: list[str] = []
        self.list_calls = 0
        self.send_error: BaseException | None = None
        self.reread_error: BaseException | None = None  # raised by the 2nd+ list call
        self.url_error: BaseException | None = None
        self.commit_errors = 0  # how many upcoming commits fail
        self.rollback_error: BaseException | None = None

    def clear(self):
        self.trace.clear()


@pytest.fixture
def clock(monkeypatch):
    fake = _FakeClock()
    monkeypatch.setattr(aito_routes, "time", fake)
    return fake


@pytest.fixture
def rig(monkeypatch, clock):
    r = Rig()

    async def content(db, document_id):
        r.trace.append(f"content:{document_id}")
        return {"subject": "S", "body": "<p>B</p>", "recipients": [dict(x) for x in RECIPIENTS]}

    async def email_invoice(db, invoice_id, *, to_mail_ids):
        r.trace.append(f"send:{invoice_id}:{','.join(to_mail_ids)}")
        if r.send_error is not None:
            raise r.send_error

    async def email_retainer(db, retainer_id, *, to_mail_ids):
        r.trace.append(f"send:{retainer_id}:{','.join(to_mail_ids)}")
        if r.send_error is not None:
            raise r.send_error

    async def list_invoices(db, quote_id, client_id):
        r.list_calls += 1
        r.trace.append(f"list:{quote_id}:{client_id}")
        if r.list_calls == 1:
            return [dict(INVOICE)]
        if r.reread_error is not None:
            raise r.reread_error
        return [{**INVOICE, "status": "sent"}, dict(OLDER_INVOICE)]

    async def list_retainers(db, project):
        r.list_calls += 1
        r.trace.append(f"list:{project.quote_id}:{project.quote_number}:{project.client_id}")
        if r.list_calls == 1:
            return [dict(RETAINER)]
        if r.reread_error is not None:
            raise r.reread_error
        return [{**RETAINER, "status": "sent"}]

    async def invoice_url(db, invoice_id):
        r.trace.append(f"url:{invoice_id}")
        if r.url_error is not None:
            raise r.url_error
        return f"https://books/invoices/{invoice_id}"

    async def retainer_url(db, retainer_id):
        r.trace.append(f"url:{retainer_id}")
        if r.url_error is not None:
            raise r.url_error
        return f"https://books/retainerinvoices/{retainer_id}"

    real_record = aito_routes.record

    async def record(db, project_id, kind, **kwargs):
        r.trace.append(f"record:{kind}:{sorted(kwargs['detail'].items())}")
        return await real_record(db, project_id, kind, **kwargs)

    real_commit = AsyncSession.commit
    real_rollback = AsyncSession.rollback

    async def commit(self):
        r.trace.append("commit")
        if r.commit_errors:
            r.commit_errors -= 1
            raise SQLAlchemyError("database is locked")
        return await real_commit(self)

    async def rollback(self):
        r.trace.append("rollback")
        if r.rollback_error is not None:
            raise r.rollback_error
        return await real_rollback(self)

    async def broadcast(*args):
        r.trace.append(f"broadcast:{args}")

    monkeypatch.setattr(zoho_service, "get_invoice_email_content", content)
    monkeypatch.setattr(zoho_service, "get_retainer_email_content", content)
    monkeypatch.setattr(zoho_service, "email_invoice", email_invoice)
    monkeypatch.setattr(zoho_service, "email_retainer", email_retainer)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_invoices)
    monkeypatch.setattr(aito_routes, "list_project_retainers", list_retainers)
    monkeypatch.setattr(zoho_service, "books_invoice_url", invoice_url)
    monkeypatch.setattr(zoho_service, "books_retainer_url", retainer_url)
    monkeypatch.setattr(aito_routes, "record", record)
    monkeypatch.setattr(AsyncSession, "commit", commit)
    monkeypatch.setattr(AsyncSession, "rollback", rollback)
    monkeypatch.setattr(aito_routes, "_broadcast_changed", broadcast)
    return r


async def _card(async_client, rig):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_email": "contact@example.pf",
        "quote_id": "EST-9",
        "quote_number": "QT-9",
    }
    response = await async_client.post("/api/v1/aito/", json=payload)
    assert response.status_code == 201, response.text
    rig.clear()
    rig.list_calls = 0
    return response.json()["id"]


async def _send(async_client, kind, pid, to="contact@example.pf"):
    body = {"to": to}
    if kind == "retainer":
        body["retainer_id"] = "RET-B"
    return await async_client.post(f"/api/v1/aito/{pid}/{kind}-email", json=body)


def _doc(kind):
    return RETAINER if kind == "retainer" else INVOICE


def _list_step(kind):
    return "list:EST-9:QT-9:z1" if kind == "retainer" else "list:EST-9:z1"


def _record_step(kind):
    doc = _doc(kind)
    detail = {"email": "contact@example.pf", f"{kind}_number": doc["number"]}
    return f"record:{kind}.emailed:{sorted(detail.items())}"


def _broadcast_step(kind, pid):
    return f"broadcast:{(f'{kind}-email', pid, 'Anonymous')}"


def _fresh_body(kind):
    if kind == "retainer":
        return {**RETAINER, "status": "sent", "url": "https://books/retainerinvoices/RET-B"}
    return {**INVOICE, "status": "sent", "url": "https://books/invoices/INV-7", "invoice_count": 2}


async def _events(async_client, pid, kind):
    body = (await async_client.get(f"/api/v1/aito/{pid}/events?depth=detail")).json()
    return [e for e in body["events"] if e["kind"] == f"{kind}.emailed"]


@pytest.fixture(autouse=True)
def _pin_actor(monkeypatch):
    monkeypatch.setattr(aito_routes, "_actor", lambda _user: "Anonymous")


@pytest.mark.parametrize("kind", KINDS)
async def test_success_order_of_effects_and_body(async_client, rig, kind):
    pid = await _card(async_client, rig)

    response = await _send(async_client, kind, pid)

    assert response.status_code == 200, response.text
    assert response.json() == _fresh_body(kind)
    doc_id = _doc(kind)["id"]
    assert rig.trace == [
        _list_step(kind),
        f"content:{doc_id}",
        f"send:{doc_id}:contact@example.pf",
        _record_step(kind),
        "commit",
        _list_step(kind),
        f"url:{doc_id}",
        "rollback",
        _broadcast_step(kind, pid),
        GET_DB_OK,
    ]
    events = await _events(async_client, pid, kind)
    assert len(events) == 1
    assert events[0]["actor_class"] == "user"
    # Kept on success: the identical send is now a 409.
    again = await _send(async_client, kind, pid)
    assert again.status_code == 409
    assert again.json()["detail"] == aito_routes._EMAIL_DUPLICATE_DETAIL


@pytest.mark.parametrize("kind", KINDS)
async def test_rate_limit_is_checked_before_any_lookup(async_client, rig, monkeypatch, kind):
    monkeypatch.setattr(aito_routes, "_ZOHO_EMAIL_MAX_CALLS", 1)
    pid = await _card(async_client, rig)
    assert (await _send(async_client, kind, pid)).status_code == 200
    rig.clear()

    over = await _send(async_client, kind, pid, to="compta@example.pf")

    assert over.status_code == 429
    assert over.json() == {"detail": "Too many email sends. Please wait a moment and try again."}
    assert rig.trace == [GET_DB_RAISED]


@pytest.mark.parametrize("kind", KINDS)
async def test_address_outside_the_allowlist_is_422_and_never_arms_the_guard(async_client, rig, kind):
    pid = await _card(async_client, rig)

    response = await _send(async_client, kind, pid, to="stranger@example.com")

    noun = "retainer invoice" if kind == "retainer" else "invoice"
    assert response.status_code == 422
    assert response.json() == {"detail": f"That address is not a recipient of this {noun}"}
    assert rig.trace == [_list_step(kind), f"content:{_doc(kind)['id']}", GET_DB_RAISED]
    assert aito_routes._recent_emails == {}


@pytest.mark.parametrize("kind", KINDS)
async def test_recipient_is_stripped_and_matched_case_insensitively(async_client, rig, kind):
    pid = await _card(async_client, rig)

    response = await _send(async_client, kind, pid, to="  Contact@Example.PF ")

    assert response.status_code == 200
    assert f"send:{_doc(kind)['id']}:Contact@Example.PF" in rig.trace
    # The guard key lowercases; the identical-but-lowercase send is a 409.
    assert (await _send(async_client, kind, pid)).status_code == 409


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize(
    ("error", "status", "released"),
    [
        (ZohoNotFound("No such invoice"), 404, True),
        (ZohoRequestRejected("This contact has no email address"), 400, True),
        (ZohoUpstreamError("Books answered 500"), 502, True),
        (ZohoNotConfiguredError("missing settings"), 502, True),
        (ZohoUnreachable("Zoho Books unreachable: ReadTimeout"), 502, False),
    ],
)
async def test_books_send_errors_map_and_release_the_guard_except_when_unreachable(
    async_client, rig, caplog, kind, error, status, released
):
    pid = await _card(async_client, rig)
    rig.send_error = error

    with caplog.at_level(logging.WARNING, logger=aito_routes.logger.name):
        response = await _send(async_client, kind, pid)

    assert response.status_code == status
    assert response.json() == {"detail": str(error)}
    doc_id = _doc(kind)["id"]
    assert rig.trace == [
        _list_step(kind),
        f"content:{doc_id}",
        f"send:{doc_id}:contact@example.pf",
        "rollback",
        GET_DB_RAISED,
    ]
    assert f"Aito {kind} email failed for project {pid}: {error}" in caplog.messages
    assert await _events(async_client, pid, kind) == []
    rig.send_error = None
    again = await _send(async_client, kind, pid)
    assert again.status_code == (200 if released else 409)


@pytest.mark.parametrize("kind", KINDS)
async def test_an_unexpected_send_exception_propagates_and_releases_the_guard(async_client, rig, kind):
    pid = await _card(async_client, rig)
    rig.send_error = RuntimeError("bug")

    try:
        response = await _send(async_client, kind, pid)
        assert response.status_code >= 500
    except RuntimeError:
        pass
    doc_id = _doc(kind)["id"]
    assert rig.trace[:3] == [_list_step(kind), f"content:{doc_id}", f"send:{doc_id}:contact@example.pf"]
    assert not any(s.startswith(("record:", "broadcast:")) for s in rig.trace)
    assert aito_routes._recent_emails == {}


@pytest.mark.parametrize("kind", KINDS)
async def test_record_commit_failure_after_a_real_send_still_200_and_logs(async_client, rig, caplog, kind):
    pid = await _card(async_client, rig)
    rig.commit_errors = 1

    with caplog.at_level(logging.WARNING, logger=aito_routes.logger.name):
        response = await _send(async_client, kind, pid)

    assert response.status_code == 200
    assert response.json() == _fresh_body(kind)
    doc_id = _doc(kind)["id"]
    assert rig.trace == [
        _list_step(kind),
        f"content:{doc_id}",
        f"send:{doc_id}:contact@example.pf",
        _record_step(kind),
        "commit",
        "rollback",
        _list_step(kind),
        f"url:{doc_id}",
        "rollback",
        _broadcast_step(kind, pid),
        GET_DB_OK,
    ]
    assert (
        f"Aito {kind} email for project {pid} WAS SENT via Books but recording the local "
        f"{kind}.emailed event failed — no event exists for this send: database is locked"
    ) in caplog.messages
    assert await _events(async_client, pid, kind) == []
    assert (await _send(async_client, kind, pid)).status_code == 409


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize(
    "error", [ZohoUpstreamError("Books down"), ZohoNotConfiguredError("gone"), SQLAlchemyError("locked")]
)
async def test_re_read_failure_degrades_to_the_pre_send_document(async_client, rig, caplog, kind, error):
    pid = await _card(async_client, rig)
    rig.reread_error = error

    with caplog.at_level(logging.WARNING, logger=aito_routes.logger.name):
        response = await _send(async_client, kind, pid)

    assert response.status_code == 200
    expected = {**_doc(kind), "url": ""}
    if kind == "invoice":
        expected["invoice_count"] = 1
    assert response.json() == expected
    doc_id = _doc(kind)["id"]
    assert rig.trace == [
        _list_step(kind),
        f"content:{doc_id}",
        f"send:{doc_id}:contact@example.pf",
        _record_step(kind),
        "commit",
        _list_step(kind),
        "rollback",
        "rollback",
        _broadcast_step(kind, pid),
        GET_DB_OK,
    ]
    assert f"Aito {kind} re-read after emailing project {pid} failed: {error}" in caplog.messages
    assert len(await _events(async_client, pid, kind)) == 1


@pytest.mark.parametrize("kind", KINDS)
async def test_a_url_failure_keeps_what_the_re_read_already_got(async_client, rig, kind):
    """Partial degrade: the list succeeded, so the body is the FRESH row (and,
    for an invoice, the fresh count) with only the url left empty."""
    pid = await _card(async_client, rig)
    rig.url_error = ZohoUpstreamError("no org")

    response = await _send(async_client, kind, pid)

    assert response.status_code == 200
    expected = {**_fresh_body(kind), "url": ""}
    assert response.json() == expected
    doc_id = _doc(kind)["id"]
    assert rig.trace[-6:] == [
        _list_step(kind),
        f"url:{doc_id}",
        "rollback",
        "rollback",
        _broadcast_step(kind, pid),
        GET_DB_OK,
    ]


@pytest.mark.parametrize("kind", KINDS)
async def test_both_failures_log_the_compounding_suffix(async_client, rig, caplog, kind):
    pid = await _card(async_client, rig)
    rig.commit_errors = 1
    rig.reread_error = ZohoUpstreamError("Books down")

    with caplog.at_level(logging.WARNING, logger=aito_routes.logger.name):
        response = await _send(async_client, kind, pid)

    assert response.status_code == 200
    assert (
        f"Aito {kind} re-read after emailing project {pid} failed "
        f"({kind}.emailed event was also not recorded — see the error above): Books down"
    ) in caplog.messages
    assert rig.trace[-7:] == [
        "commit",
        "rollback",
        _list_step(kind),
        "rollback",
        "rollback",
        _broadcast_step(kind, pid),
        GET_DB_OK,
    ]


@pytest.mark.parametrize("kind", KINDS)
async def test_every_rollback_failing_after_the_send_is_swallowed(async_client, rig, kind):
    pid = await _card(async_client, rig)
    rig.commit_errors = 1
    rig.reread_error = ZohoUpstreamError("Books down")
    rig.rollback_error = RuntimeError("connection already closed")

    response = await _send(async_client, kind, pid)

    assert response.status_code == 200
    assert rig.trace.count("rollback") == 3
    assert rig.trace[-2:] == [_broadcast_step(kind, pid), GET_DB_OK]


@pytest.mark.parametrize("kind", KINDS)
async def test_an_unlisted_re_read_exception_propagates_without_broadcast(async_client, rig, kind):
    pid = await _card(async_client, rig)
    rig.reread_error = RuntimeError("bug in the re-read")

    try:
        response = await _send(async_client, kind, pid)
        assert response.status_code >= 500
    except RuntimeError:
        pass
    assert not any(s.startswith("broadcast:") for s in rig.trace)
    # The mail went out, so the guard stays armed.
    assert len(aito_routes._recent_emails) == 1
