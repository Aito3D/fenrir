import json

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.notification import NotificationProvider
from backend.app.models.notification_template import NotificationTemplate
from backend.app.services.aito_quote_status import accept_quote
from backend.app.services.notification_service import notification_service
from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def no_books(monkeypatch):
    async def ok(db, estimate_id, target, current=None):
        return None

    monkeypatch.setattr(zoho_service, "advance_estimate_status", ok)


@pytest.mark.asyncio
async def test_provider_flag_round_trips_through_the_api(async_client):
    r = await async_client.post(
        "/api/v1/notifications/",
        json={
            "name": "hook",
            "provider_type": "webhook",
            "config": {"webhook_url": "https://example.com/x"},
            "on_aito_payment_received": True,
        },
    )
    assert r.status_code in (200, 201), r.text
    assert r.json()["on_aito_payment_received"] is True
    pid = r.json()["id"]
    r = await async_client.patch(f"/api/v1/notifications/{pid}", json={"on_aito_payment_received": False})
    assert r.json()["on_aito_payment_received"] is False


@pytest.mark.asyncio
async def test_accept_from_a_payment_notifies_subscribed_providers(db_session, monkeypatch):
    db_session.add(
        NotificationProvider(
            name="hook",
            provider_type="webhook",
            enabled=True,
            config=json.dumps({"webhook_url": "https://example.com/x"}),
            on_aito_payment_received=True,
        )
    )
    db_session.add(
        NotificationTemplate(
            event_type="aito_payment_received",
            name="Aito Payment Received",
            title_template="Payment received — {reference}",
            body_template="{client_name} paid {amount} {currency} ({source})\nProject #{project_id}",
        )
    )
    p = AitoProject(
        description="x",
        board_column="devis",
        position=0,
        status="active",
        quote_status="sent",
        client_name="ACME",
        quote_number="DEV-1",
        quote_total=12500.0,
    )
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    sent = []

    async def capture(
        providers,
        title,
        message,
        db,
        event_type="unknown",
        printer_id=None,
        printer_name=None,
        force_immediate=False,
        image_data=None,
        variables=None,
    ):
        sent.append((title, message, event_type, variables))

    monkeypatch.setattr(notification_service, "_send_to_providers", capture)
    await accept_quote(db_session, p, source="payment_link", detail={"amount": 12500, "reference": "DEV-1"})
    assert len(sent) == 1
    title, message, event_type, variables = sent[0]
    assert event_type == "aito_payment_received"
    # _build_message_from_template stamps common "timestamp"/"app_name" keys
    # into the same variables dict before _send_to_providers sees it (every
    # other on_* handler shares that dict too) — assert on the values this
    # event owns rather than exact dict equality.
    assert variables["project_id"] == p.id
    assert variables["client_name"] == "ACME"
    assert variables["reference"] == "DEV-1"
    assert variables["amount"] == 12500
    assert variables["currency"] == "XPF"
    assert variables["source"] == "payment_link"
    assert "DEV-1" in title and "12500" in message


@pytest.mark.asyncio
async def test_manual_accept_does_not_notify(db_session, monkeypatch):
    p = AitoProject(description="x", board_column="devis", position=0, status="active", quote_status="sent")
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    called = []

    async def spy(db, **kw):
        called.append(kw)

    monkeypatch.setattr(notification_service, "on_aito_payment_received", spy)
    from backend.app.services.aito_quote_status import apply_quote_decision

    await apply_quote_decision(db_session, p, "accepted", actor_class="user", actor_name="paul", source="user")
    assert called == []


@pytest.mark.asyncio
async def test_accept_quote_with_user_source_does_not_notify(db_session, monkeypatch):
    """accept_quote itself must gate on source, not just rely on callers never
    passing 'user' — see the docstring's 'Money wins' path for how a
    declined/expired quote can be reopened through here too."""
    p = AitoProject(description="x", board_column="devis", position=0, status="active", quote_status="sent")
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    called = []

    async def spy(db, **kw):
        called.append(kw)

    monkeypatch.setattr(notification_service, "on_aito_payment_received", spy)
    result = await accept_quote(db_session, p, source="user", actor_name="paul")
    assert result is True
    assert called == []
