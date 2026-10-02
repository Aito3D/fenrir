"""T-132: the Zoho error -> HTTP mapping of every ``/zoho`` route that turns a
Books failure into a response, pinned per route and per exception class.

Every Zoho exception except ``ZohoNotConfiguredError`` subclasses
``ZohoUpstreamError``, so a route that only knows the base class still maps a
429, a transport failure, a "not found" or a rejected request to its 502.
Two routes also answer a missing contact with a 404, and two answer a request
Books rejected with a 409 carrying Books' own message; nowhere else may those
arms fire. Pinned twice: through HTTP (status + detail) and by calling the
route function directly (the exception chain: ``from None`` for the
not-configured and not-found arms, ``from e`` for the rest).
"""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.app.api.routes import zoho as zoho_routes
from backend.app.services.zoho import (
    ZohoAmbiguous,
    ZohoAmbiguousReferenceError,
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)

NOT_CONFIGURED = "Zoho is not configured"
CONTACT_NOT_FOUND = "Contact not found in Zoho Books"
CARD_CONTACT = "zMAP1"

# (route id, service method that raises, has a 404 arm, has a rejected arm)
ROUTES = [
    ("search_contacts", "search_contacts", False, False),
    ("get_contact", "get_contact", True, False),
    ("create_contact", "create_contact", False, True),
    ("patch_contact", "update_contact_person", False, False),
    ("list_contact_persons", "list_contact_persons", True, False),
    ("create_contact_person", "create_contact_person", False, True),
    ("search_estimates", "search_estimates", False, False),
    ("preview_estimate", "get_estimate", False, False),
]

ERRORS = [
    ZohoNotConfiguredError("not configured"),
    ZohoUpstreamError("upstream boom"),
    ZohoUnreachable("unreachable boom"),
    ZohoAmbiguous("ambiguous boom"),
    ZohoAmbiguousReferenceError("ambiguous reference boom"),
    ZohoRateLimited("rate limited boom", retry_after=3.0),
    ZohoNotFound("not found boom"),
    ZohoRequestRejected("rejected boom"),
]


def _expected(error: Exception, has_not_found: bool, has_rejected: bool) -> tuple[int, str, bool]:
    """(status, detail, chained from the error) for one route and class."""
    if isinstance(error, ZohoNotConfiguredError):
        return 409, NOT_CONFIGURED, False
    if has_not_found and isinstance(error, ZohoNotFound):
        return 404, CONTACT_NOT_FOUND, False
    if has_rejected and isinstance(error, ZohoRequestRejected):
        return 409, str(error), True
    return 502, str(error), True


def _raiser(error: Exception):
    async def _call(*args, **kwargs):
        raise error

    return _call


def _http_request(route: str) -> tuple[str, str, dict | None]:
    return {
        "search_contacts": ("GET", "/api/v1/zoho/contacts?q=acme", None),
        "get_contact": ("GET", f"/api/v1/zoho/contacts/{CARD_CONTACT}", None),
        "create_contact": ("POST", "/api/v1/zoho/contacts", {"company_name": "ACME SARL"}),
        "patch_contact": ("PATCH", f"/api/v1/zoho/contacts/{CARD_CONTACT}", {"email": "x@y.pf"}),
        "list_contact_persons": ("GET", f"/api/v1/zoho/contacts/{CARD_CONTACT}/persons", None),
        "create_contact_person": (
            "POST",
            f"/api/v1/zoho/contacts/{CARD_CONTACT}/persons",
            {"first_name": "Jean", "email": "jean@example.pf"},
        ),
        "search_estimates": ("GET", "/api/v1/zoho/estimates?q=2467", None),
        "preview_estimate": ("GET", "/api/v1/zoho/estimates/e1/preview", None),
    }[route]


async def _active_card(async_client) -> None:
    """patch_contact is scoped to a contact with an active card (T-039)."""
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Support GoPro",
            "client_id": CARD_CONTACT,
            "client_name": "Jean DUPONT",
            "client_phone": "+689-87000001",
            "client_email": "jean@example.pf",
        },
    )
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
@pytest.mark.parametrize("error", ERRORS, ids=lambda e: type(e).__name__)
@pytest.mark.parametrize(("route", "method", "has_not_found", "has_rejected"), ROUTES, ids=[r[0] for r in ROUTES])
async def test_each_zoho_route_maps_each_books_error_over_http(
    async_client, monkeypatch, route, method, has_not_found, has_rejected, error
):
    if route == "patch_contact":
        await _active_card(async_client)
    monkeypatch.setattr(zoho_service, method, _raiser(error))
    verb, url, body = _http_request(route)
    r = await async_client.request(verb, url, json=body)
    status, detail, _chained = _expected(error, has_not_found, has_rejected)
    assert r.status_code == status
    assert r.json() == {"detail": detail}


class _ScopedDB:
    """Just enough session for patch_contact's T-039 scoping query to find
    an active card."""

    async def execute(self, *args, **kwargs):
        return SimpleNamespace(scalar_one_or_none=lambda: 1)


def _direct_call(route: str):
    db = _ScopedDB()
    return {
        "search_contacts": lambda: zoho_routes.search_contacts(q="acme", db=db, _=None),
        "get_contact": lambda: zoho_routes.get_contact(contact_id=CARD_CONTACT, db=db, _=None),
        "create_contact": lambda: zoho_routes.create_contact(
            payload=zoho_routes.ZohoContactCreate(company_name="ACME SARL"), db=db, _=None
        ),
        "patch_contact": lambda: zoho_routes.patch_contact(
            contact_id=CARD_CONTACT, payload=zoho_routes.ZohoContactPatch(email="x@y.pf"), db=db, _=None
        ),
        "list_contact_persons": lambda: zoho_routes.list_contact_persons(contact_id=CARD_CONTACT, db=db, _=None),
        "create_contact_person": lambda: zoho_routes.create_contact_person(
            contact_id=CARD_CONTACT,
            payload=zoho_routes.ZohoContactPersonCreate(first_name="Jean", email="jean@example.pf"),
            db=db,
            _=None,
        ),
        "search_estimates": lambda: zoho_routes.search_estimates(q="2467", db=db, _=None),
        "preview_estimate": lambda: zoho_routes.preview_estimate(estimate_id="e1", db=db, _=None),
    }[route]()


@pytest.mark.asyncio
@pytest.mark.parametrize("error", ERRORS, ids=lambda e: type(e).__name__)
@pytest.mark.parametrize(("route", "method", "has_not_found", "has_rejected"), ROUTES, ids=[r[0] for r in ROUTES])
async def test_each_zoho_route_chains_each_books_error_the_same_way(
    monkeypatch, route, method, has_not_found, has_rejected, error
):
    async def default_contact(_db):
        return "walk-in", "Client de passage"

    monkeypatch.setattr(zoho_service, "get_default_contact", default_contact)
    monkeypatch.setattr(zoho_service, method, _raiser(error))
    with pytest.raises(HTTPException) as caught:
        await _direct_call(route)
    status, detail, chained = _expected(error, has_not_found, has_rejected)
    exc = caught.value
    assert exc.status_code == status
    assert exc.detail == detail
    # Raised inside the handler either way, so the context is always the error.
    assert exc.__context__ is error
    if chained:
        assert exc.__cause__ is error
        assert exc.__suppress_context__ is True
    else:
        assert exc.__cause__ is None
        assert exc.__suppress_context__ is True
