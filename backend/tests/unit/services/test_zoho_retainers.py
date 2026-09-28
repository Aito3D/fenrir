"""Books' retainer-invoice endpoints: deep link, PDF, email prefill and send."""

import httpx
import pytest

from backend.app.services.zoho import ZohoNotFound, ZohoUpstreamError, zoho_service


@pytest.fixture(autouse=True)
def reset_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={
            "zoho_client_id": "1000.FAKE",
            "zoho_client_secret": "fake-secret",
            "zoho_refresh_token": "1000.fake.refresh",
            "zoho_organization_id": "999",
        },
    )


def _transport(api_response: httpx.Response, seen: list | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        if seen is not None:
            seen.append(request)
        return api_response

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_books_retainer_url_uses_the_retainerinvoices_fragment(async_client, db_session, monkeypatch):
    async def base(db):
        return "https://books.zoho.eu/app/org1"

    monkeypatch.setattr(zoho_service, "_books_app_base", base)
    assert await zoho_service.books_retainer_url(db_session, "RET-1") == (
        "https://books.zoho.eu/app/org1#/retainerinvoices/RET-1"
    )


@pytest.mark.asyncio
async def test_get_retainer_invoice_pdf_returns_bytes(async_client, db_session):
    await _configure(async_client)
    pdf = b"%PDF-1.4 fake"
    seen: list[httpx.Request] = []
    zoho_service.transport = _transport(
        httpx.Response(200, content=pdf, headers={"Content-Type": "application/pdf"}), seen
    )

    assert await zoho_service.get_retainer_invoice_pdf(db_session, "RET-1") == pdf
    assert seen[-1].url.path.endswith("/retainerinvoices/RET-1")
    assert seen[-1].url.params["accept"] == "pdf"


@pytest.mark.asyncio
async def test_get_retainer_invoice_pdf_maps_not_found(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(httpx.Response(404, json={"message": "Retainer does not exist"}))
    with pytest.raises(ZohoNotFound):
        await zoho_service.get_retainer_invoice_pdf(db_session, "RET-1")


@pytest.mark.asyncio
async def test_get_retainer_invoice_pdf_rejects_a_200_that_is_not_a_pdf(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(httpx.Response(200, content=b"<html>sign in</html>"))
    with pytest.raises(ZohoUpstreamError):
        await zoho_service.get_retainer_invoice_pdf(db_session, "RET-1")


@pytest.mark.asyncio
async def test_get_retainer_email_content_maps_subject_body_and_recipients(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    zoho_service.transport = _transport(
        httpx.Response(
            200,
            json={
                "code": 0,
                "data": {
                    "subject": "Acompte AC-26-0031",
                    "body": "<p>Bonjour</p>",
                    "to_contacts": [
                        {
                            "email": "jp@example.pf",
                            "first_name": "Jean-Pierre",
                            "last_name": "DUPONT",
                            "contact_person_id": "cp-1",
                        },
                        {"email": "", "first_name": "No", "last_name": "Mail", "contact_person_id": "cp-2"},
                    ],
                },
            },
        ),
        seen,
    )

    content = await zoho_service.get_retainer_email_content(db_session, "RET-1")

    assert seen[-1].method == "GET"
    assert "/retainerinvoices/RET-1/email" in str(seen[-1].url)
    assert content["subject"] == "Acompte AC-26-0031"
    assert content["body"] == "<p>Bonjour</p>"
    # The address-less contact is dropped: offering it is offering a send that must fail.
    assert content["recipients"] == [
        {"email": "jp@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"}
    ]


@pytest.mark.asyncio
async def test_email_retainer_posts_only_the_recipients(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    zoho_service.transport = _transport(httpx.Response(200, json={"code": 0, "message": "sent"}), seen)

    await zoho_service.email_retainer(db_session, "RET-1", to_mail_ids=["jp@example.pf"])

    request = seen[-1]
    assert request.method == "POST"
    assert "/retainerinvoices/RET-1/email" in str(request.url)
    assert request.read() == b'{"to_mail_ids":["jp@example.pf"]}'
