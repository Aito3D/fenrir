"""Tests for NotificationService.send_user_print_email (per-user print emails)."""

from unittest.mock import patch

import pytest
from sqlalchemy import select

from backend.app.models.notification_template import NotificationTemplate
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.models.user_email_pref import UserEmailPreference
from backend.app.services.notification_service import NotificationService

PHOTO_URL = "https://example.test/photo.jpg"
SEND_EMAIL = "backend.app.services.email_service.send_email"


@pytest.fixture
def service():
    return NotificationService()


@pytest.fixture
async def world(db_session):
    """Advanced auth on, SMTP configured, one user with an email, one template per event."""
    for key, value in {
        "advanced_auth_enabled": "true",
        "smtp_host": "smtp.example.test",
        "smtp_port": "587",
        "smtp_from_email": "from@example.test",
    }.items():
        db_session.add(Settings(key=key, value=value))
    user = User(username="alice", email="alice@example.test")
    db_session.add(user)
    db_session.add(
        NotificationTemplate(
            event_type="user_print_complete",
            name="done",
            title_template="Done on {printer}",
            body_template="{filename} finished",
        )
    )
    await db_session.commit()
    await db_session.refresh(user)
    return user


async def _setting(db, key):
    return (await db.execute(select(Settings).where(Settings.key == key))).scalar_one()


async def _call(service, db, user_id, event="user_print_complete", **kw):
    await service.send_user_print_email(event, user_id, "P1", "Cube.gcode.3mf", db, **kw)


class TestSendUserPrintEmail:
    @pytest.mark.asyncio
    async def test_no_created_by_id_sends_nothing(self, service, db_session, world):
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, None)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_user_without_email_sends_nothing(self, service, db_session, world):
        world.email = None
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_unknown_user_sends_nothing(self, service, db_session, world):
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id + 99)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_preference_off_sends_nothing(self, service, db_session, world):
        db_session.add(UserEmailPreference(user_id=world.id, notify_print_complete=False))
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_preference_off_for_other_event_still_sends(self, service, db_session, world):
        db_session.add(UserEmailPreference(user_id=world.id, notify_print_failed=False))
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_called_once()

    @pytest.mark.asyncio
    async def test_unknown_event_type_sends_nothing(self, service, db_session, world):
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id, event="user_print_bogus")
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_advanced_auth_off_sends_nothing(self, service, db_session, world):
        setting = await _setting(db_session, "advanced_auth_enabled")
        setting.value = "false"
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_admin_toggle_off_sends_nothing(self, service, db_session, world):
        db_session.add(Settings(key="user_notifications_enabled", value="false"))
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_smtp_settings_sends_nothing(self, service, db_session, world):
        await db_session.delete(await _setting(db_session, "smtp_host"))
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_not_called()

    @pytest.mark.asyncio
    async def test_preference_on_sends_once_with_rendered_template(self, service, db_session, world):
        db_session.add(UserEmailPreference(user_id=world.id, notify_print_complete=True))
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_called_once()
        args = send.call_args.args
        assert args[1] == "alice@example.test"
        assert args[2] == "Done on P1"
        assert args[3] == f"{service._clean_filename('Cube.gcode.3mf')} finished"
        assert send.call_args.kwargs["image_data"] is None

    @pytest.mark.asyncio
    async def test_no_preference_row_defaults_to_send(self, service, db_session, world):
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id)
        send.assert_called_once()

    @pytest.mark.asyncio
    async def test_photo_not_inlined_when_template_lacks_url(self, service, db_session, world):
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id, image_data=b"jpeg", finish_photo_url=PHOTO_URL)
        send.assert_called_once()
        assert send.call_args.kwargs["image_data"] is None

    @pytest.mark.asyncio
    async def test_photo_inlined_when_template_references_url(self, service, db_session, world):
        template = await db_session.get(NotificationTemplate, 1)
        template.body_template = "{filename} finished {finish_photo_url}"
        await db_session.commit()
        with patch(SEND_EMAIL) as send:
            await _call(service, db_session, world.id, image_data=b"jpeg", finish_photo_url=PHOTO_URL)
        send.assert_called_once()
        assert send.call_args.kwargs["image_data"] == b"jpeg"
        assert "cid:fenrir-user-print-photo" in send.call_args.args[4]

    @pytest.mark.asyncio
    async def test_send_failure_is_swallowed(self, service, db_session, world):
        with patch(SEND_EMAIL, side_effect=RuntimeError("smtp down")):
            await _call(service, db_session, world.id)
