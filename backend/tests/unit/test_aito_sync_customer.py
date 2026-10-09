"""The sweep follows the estimate's customer.

A card's client fields are a snapshot taken at import. Before this, a quote
re-assigned to another customer in Zoho Books kept the old person on the card
forever — and the invoice poll, invoice list, rating and history all key on
the card's client_id, so the new customer's invoices never attached. Books is
the record for WHO the quote belongs to: the sweep already reads the estimate
every tick, and `customer_id` rides in that same response.
"""

import json

import httpx
import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services.aito_quote_sync import SYNC_FAILURE_LIMIT, sync_project
from backend.app.services.zoho import zoho_service

from .test_aito_quote_sync import _configure_zoho, _project_with_quote, zoho_handler

_ESTIMATE_C2 = {
    "estimate_id": "E1",
    "status": "accepted",
    "total": 5000,
    "customer_id": "C2",
    "customer_name": "Nouveau Client",
    "is_transaction_created": False,
    "invoiced_amount": 0,
}

_CONTACT_C2 = {
    "contact": {
        "contact_id": "C2",
        "contact_name": "Nouveau Client",
        "customer_sub_type": "business",
        "mobile": "+687 12 34 56",
        "phone": "+687 99 99 99",
        "email": "nouveau@example.com",
    }
}


async def _idle_quoted_project(db):
    project = await _project_with_quote(db, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    project.client_phone = "+687 11 11 11"
    project.client_email = "ancien@example.com"
    project.client_is_company = False
    await db.commit()
    await _configure_zoho(db)
    return project


async def _events(db, project_id: int) -> list[AitoEvent]:
    return list(
        (await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id)))
        .scalars()
        .all()
    )


@pytest.mark.asyncio
async def test_the_sweep_adopts_the_estimates_new_customer(db_session):
    project = await _idle_quoted_project(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    assert project.client_name == "Nouveau Client"
    # Mobile first, same as import.
    assert project.client_phone == "+687 12 34 56"
    assert project.client_email == "nouveau@example.com"
    assert project.client_is_company is True
    assert [p for m, p, _ in seen if m == "GET" and "/contacts/" in p] == ["/books/v3/contacts/C2"]


@pytest.mark.asyncio
async def test_the_same_customer_is_a_no_op_with_no_contact_read(db_session):
    """The common case costs nothing: no contact call, and no version bump
    that would 409 an operator mid-edit on the panel."""
    project = await _idle_quoted_project(db_session)
    version_before = project.version
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {**_ESTIMATE_C2, "customer_id": "C1", "customer_name": "Client"}
                },
                ("GET", "/estimates/E1/comments"): {"comments": []},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_id == "C1"
    assert project.client_phone == "+687 11 11 11"
    assert project.version == version_before
    assert not [p for m, p, _ in seen if m == "GET" and "/contacts/" in p]


@pytest.mark.asyncio
async def test_an_estimate_without_a_customer_id_is_a_no_op(db_session):
    """A partial payload is no evidence the quote has no customer."""
    project = await _idle_quoted_project(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}},
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
    finally:
        zoho_service.transport = None

    assert project.client_id == "C1"
    assert project.client_name == "Client"


@pytest.mark.asyncio
async def test_a_failed_contact_read_still_moves_the_card_to_the_new_customer(db_session):
    """Same degradation as import: id and name from the estimate itself, no
    phone or email. The invoice poll and rating key on the id, so the card
    must follow even when the contact is unreachable — and the sweep as a
    whole must not fail on it."""
    project = await _idle_quoted_project(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                # No /contacts/C2 route: the handler answers 404.
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    assert project.client_name == "Nouveau Client"
    assert project.client_phone is None
    assert project.client_email is None
    assert project.client_is_company is None
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_a_customer_change_clears_the_old_persons_card_only_facts(db_session):
    """The social handle and the contacted stamp describe the OLD person: the
    new client was never told the job is ready, and Books has no field the
    handle could have come from."""
    from datetime import datetime

    project = await _idle_quoted_project(db_session)
    project.client_social_network = "instagram"
    project.client_social_handle = "@ancien"
    project.client_contacted_at = datetime(2026, 9, 1, 8, 0, 0)
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_social_network is None
    assert project.client_social_handle is None
    assert project.client_contacted_at is None
    events = await _events(db_session, project.id)
    by_kind = {e.kind: e for e in events}
    changed = by_kind["project.client.changed"]
    assert changed.actor_class == "system"
    assert changed.detail == {
        "from_id": "C1",
        "from_name": "Client",
        "to_id": "C2",
        "to_name": "Nouveau Client",
    }
    assert by_kind["project.contacted.cleared"].detail == {"cause": "zoho"}


@pytest.mark.asyncio
async def test_no_contacted_cleared_event_when_there_was_no_stamp(db_session):
    project = await _idle_quoted_project(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    kinds = [e.kind for e in await _events(db_session, project.id)]
    assert "project.client.changed" in kinds
    assert "project.contacted.cleared" not in kinds


class _StatefulBooks:
    """A one-estimate Books whose PUT really changes what the next GET reads,
    so a push that leaves the customer out shows up as the next sweep
    "following" Books straight back to the old one."""

    def __init__(self, customer_id: str = "C1") -> None:
        self.estimate = {
            "estimate_id": "E1",
            "estimate_number": "DEV26-9001",
            "status": "sent",
            "total": 1000,
            "customer_id": customer_id,
            "customer_name": "Client",
            "is_transaction_created": False,
            "invoiced_amount": 0,
            "is_inclusive_tax": True,
            "expiry_date": "2026-12-31",
            "line_items": [],
        }
        self.puts: list[dict] = []
        self.fail_puts = 0  # answer the next N PUTs with a 503, writing nothing

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        path = request.url.path
        if request.method == "GET" and path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": dict(self.estimate)})
        if request.method == "PUT" and path.endswith("/estimates/E1"):
            body = json.loads(request.content)
            self.puts.append(body)
            if self.fail_puts:
                self.fail_puts -= 1
                return httpx.Response(503, json={"message": "down"})
            if "customer_id" in body:
                self.estimate["customer_id"] = body["customer_id"]
                self.estimate["customer_name"] = "PACIFIC MARINE"
            if "line_items" in body:
                self.estimate["line_items"] = body["line_items"]
            return httpx.Response(200, json={"estimate": dict(self.estimate)})
        if request.method == "GET" and path.endswith("/estimates/E1/comments"):
            return httpx.Response(200, json={"comments": []})
        return httpx.Response(404, json={"message": "no route"})


async def _transferred_project(db, *, contact_person_id: str | None):
    """The state transfer_client leaves behind: the card names the new
    customer, Books still names the old one, the card is pending and owes
    Books the customer push."""
    project = await _project_with_quote(db, impression_cost=1000)
    project.quote_status = "sent"
    project.client_id = "C2"
    project.client_name = "PACIFIC MARINE"
    project.client_contact_person_id = contact_person_id
    project.client_push_pending = True
    project.quote_sync_state = "pending"
    await db.commit()
    await _configure_zoho(db)
    return project


@pytest.mark.asyncio
async def test_a_transfer_is_pushed_to_books_and_survives_the_next_sweep(db_session):
    project = await _transferred_project(db_session, contact_person_id="CP9")
    books = _StatefulBooks("C1")
    zoho_service.transport = httpx.MockTransport(books)
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)  # the push
        await db_session.commit()
        assert project.quote_sync_state == "idle"
        await sync_project(db_session, project)  # the next sweep
        await db_session.commit()
    finally:
        zoho_service.transport = None

    line_put = next(p for p in books.puts if "line_items" in p)
    assert line_put["customer_id"] == "C2"
    assert line_put["contact_persons"] == ["CP9"]
    assert books.estimate["customer_id"] == "C2"
    assert project.client_id == "C2"
    assert project.client_name == "PACIFIC MARINE"
    kinds = [e.kind for e in await _events(db_session, project.id)]
    assert "project.client.changed" not in kinds


@pytest.mark.asyncio
async def test_a_push_names_no_contact_person_when_the_card_has_none(db_session):
    project = await _transferred_project(db_session, contact_person_id=None)
    books = _StatefulBooks("C1")
    zoho_service.transport = httpx.MockTransport(books)
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    line_put = next(p for p in books.puts if "line_items" in p)
    assert line_put["customer_id"] == "C2"
    assert "contact_persons" not in line_put


@pytest.mark.asyncio
async def test_a_transfer_survives_a_failure_escalation_and_is_pushed_after_it(db_session):
    """Five failed pushes escalate the card to error. The first good read
    afterwards must not settle it idle (the next sweep would then follow
    Books back to the old customer): it owes the customer push, so it goes
    back to pending, and that push carries the new customer."""
    project = await _transferred_project(db_session, contact_person_id=None)
    books = _StatefulBooks("C1")
    books.fail_puts = SYNC_FAILURE_LIMIT
    zoho_service.transport = httpx.MockTransport(books)
    zoho_service.invalidate_token()
    try:
        for _ in range(SYNC_FAILURE_LIMIT):
            await sync_project(db_session, project)
            await db_session.commit()
        assert project.quote_sync_state == "error"
        assert project.quote_sync_failures == SYNC_FAILURE_LIMIT
        assert project.client_push_pending is True

        await sync_project(db_session, project)  # Books is back: a reconcile read
        await db_session.commit()
        assert project.quote_sync_state == "pending"
        assert project.client_id == "C2"

        await sync_project(db_session, project)  # the owed push
        await db_session.commit()
        assert project.client_push_pending is False
        await sync_project(db_session, project)  # and a sweep after it
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert books.puts[-1]["customer_id"] == "C2"
    assert books.estimate["customer_id"] == "C2"
    assert project.client_id == "C2"
    kinds = [e.kind for e in await _events(db_session, project.id)]
    assert "project.client.changed" not in kinds


@pytest.mark.asyncio
async def test_a_books_reassignment_is_never_overwritten_by_a_local_edit(db_session):
    """Books moved the quote to C3 while the card (unflagged) still names
    C1, and an operator edited the card before the next reconcile. The push
    must not write C1 back into Books; the next reconcile follows Books."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "sent"
    project.quote_sync_state = "pending"  # the local line edit
    await db_session.commit()
    await _configure_zoho(db_session)
    books = _StatefulBooks("C3")
    zoho_service.transport = httpx.MockTransport(books)
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)  # the push
        await db_session.commit()
        await sync_project(db_session, project)  # the next reconcile
        await db_session.commit()
    finally:
        zoho_service.transport = None

    line_put = next(p for p in books.puts if "line_items" in p)
    assert "customer_id" not in line_put and "contact_persons" not in line_put
    assert books.estimate["customer_id"] == "C3"
    assert project.client_id == "C3"
    kinds = [e.kind for e in await _events(db_session, project.id)]
    assert "project.client.changed" in kinds


@pytest.mark.asyncio
async def test_the_flag_clears_only_after_a_put_that_carried_the_customer_succeeded(db_session):
    project = await _transferred_project(db_session, contact_person_id="CP9")
    books = _StatefulBooks("C1")
    books.fail_puts = 1
    zoho_service.transport = httpx.MockTransport(books)
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)  # the PUT fails
        await db_session.commit()
        assert books.puts and books.puts[-1]["customer_id"] == "C2"
        assert project.client_push_pending is True
        assert project.quote_sync_state == "pending"

        await sync_project(db_session, project)  # the retry lands
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert books.puts[-1]["customer_id"] == "C2"
    assert project.client_push_pending is False
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_a_flagged_card_is_not_moved_by_the_sweep(db_session):
    """While the flag is set the card is the side that changed: a reconcile
    read that sees the old customer leaves the card alone."""
    project = await _transferred_project(db_session, contact_person_id=None)
    project.quote_sync_state = "idle"
    await db_session.commit()
    books = _StatefulBooks("C1")
    zoho_service.transport = httpx.MockTransport(books)
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    kinds = [e.kind for e in await _events(db_session, project.id)]
    assert "project.client.changed" not in kinds


def _sweep_c2():
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": _ESTIMATE_C2},
                ("GET", "/contacts/C2"): _CONTACT_C2,
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()


@pytest.mark.asyncio
async def test_a_books_reassignment_rotates_the_public_tracking_token(db_session):
    """The old customer holds the /t/ link: once Books moves the quote to
    another customer, that link stops serving the job (user-approved
    2026-10-03, T-096)."""
    project = await _idle_quoted_project(db_session)
    project.tracking_token = "OLDTOK"
    await db_session.commit()
    _sweep_c2()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    assert project.tracking_token and project.tracking_token != "OLDTOK"


@pytest.mark.asyncio
async def test_a_books_reassignment_mints_no_token_for_a_card_without_one(db_session):
    project = await _idle_quoted_project(db_session)
    assert project.tracking_token is None
    _sweep_c2()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.client_id == "C2"
    assert project.tracking_token is None


@pytest.mark.asyncio
async def test_the_same_customer_keeps_the_tracking_token(db_session):
    project = await _idle_quoted_project(db_session)
    project.tracking_token = "OLDTOK"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {**_ESTIMATE_C2, "customer_id": "C1"}},
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()
    try:
        await sync_project(db_session, project)
        await db_session.commit()
    finally:
        zoho_service.transport = None

    assert project.tracking_token == "OLDTOK"
