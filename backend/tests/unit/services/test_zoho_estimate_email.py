"""Books' estimate-email endpoints: prefill mapping and the send body."""

import httpx
import pytest

from backend.app.services.zoho import ZohoRequestRejected, zoho_service


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
    """Serves the token endpoint, then `api_response` for everything else."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at-1", "expires_in": 3600})
        if seen is not None:
            seen.append(request)
        return api_response

    return httpx.MockTransport(handler)


EMAIL_PAYLOAD = {
    "code": 0,
    "message": "success",
    "data": {
        "subject": "Devis QT-00412 de AITO 3D",
        "body": "<p>Bonjour,</p>",
        "to_contacts": [
            {
                "contact_person_id": "cp-1",
                "email": "jean-pierre@example.pf",
                "first_name": "jean-pierre",
                "last_name": "dupont",
                "selected": True,
            },
            # Books includes contact persons with no address at all. Offering
            # one is offering a send that must fail.
            {"contact_person_id": "cp-2", "email": "", "first_name": "Marie", "last_name": "Tama"},
        ],
    },
}


@pytest.mark.asyncio
async def test_email_content_maps_subject_body_and_recipients(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(httpx.Response(200, json=EMAIL_PAYLOAD))

    content = await zoho_service.get_estimate_email_content(db_session, "EST-9")

    assert content["subject"] == "Devis QT-00412 de AITO 3D"
    assert content["body"] == "<p>Bonjour,</p>"
    assert content["recipients"] == [
        {"email": "jean-pierre@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"}
    ]


@pytest.mark.asyncio
async def test_email_estimate_posts_only_the_recipients(async_client, db_session):
    await _configure(async_client)
    seen: list[httpx.Request] = []
    zoho_service.transport = _transport(httpx.Response(200, json={"code": 0, "message": "sent"}), seen)

    await zoho_service.email_estimate(db_session, "EST-9", to_mail_ids=["jean-pierre@example.pf"])

    request = seen[-1]
    assert request.method == "POST"
    assert "/estimates/EST-9/email" in str(request.url)
    # Subject and body are absent on purpose: Books renders its own default
    # estimate template only when they are omitted.
    assert request.read() == b'{"to_mail_ids":["jean-pierre@example.pf"]}'


@pytest.mark.asyncio
async def test_send_rejection_maps_to_request_rejected(async_client, db_session):
    await _configure(async_client)
    zoho_service.transport = _transport(
        httpx.Response(400, json={"code": 4001, "message": "No email address for this contact"})
    )

    with pytest.raises(ZohoRequestRejected, match="No email address"):
        await zoho_service.email_estimate(db_session, "EST-9", to_mail_ids=["nobody@example.pf"])
