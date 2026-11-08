"""Notifications campaign golden probe: the notification routes, end to end over HTTP.

Drives the real FastAPI app through httpx's ASGI transport against a throw-away
SQLite file database. Nothing reaches the network: the NotificationService's HTTP
client (its ``_http_client`` seam) is an ``httpx.MockTransport`` that records every
outbound request and answers 200, so provider tests, the webhook / ntfy / gotify
senders and the "test all" route run their real code and print what they would
have sent (method, URL, headers of interest, JSON or form body).

Every step prints the HTTP status and the JSON body (volatile fields scrubbed),
plus ``wire``: the outbound requests made during that step.

Parts, in order:
  A  providers: empty list, create (webhook, ntfy, gotify, telegram, email, notify),
     validation refusals (placeholder secret, bad Notify id, unknown printer, bad
     type, bad quiet hours), get, list, patch (secrets masked, placeholder kept),
     delete, 404s.
  B  provider tests: test-config (fresh and with provider_id), per-provider test,
     test-all; the wire shows exactly what each sender emits.
  C  logs: list / filters / stats / clear, after the tests above logged rows.
  D  templates: list (seeded defaults), variables, get, put, reset, preview, 404.
  E  user email preferences: get default, put, get again (auth-disabled caller).
  F  app-message channels + send (auth disabled: nobody at the door).
  G  the permission gate of every route: no token, a user with no permission,
     read-only, and a full-permission user, with auth enabled.
"""

import asyncio
import json
import re
import sys
from unittest.mock import patch

sys.path.insert(0, ".")
sys.path.insert(0, "tools")
import probe_notif_lib as lib  # noqa: E402

import httpx  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

import backend.app.main  # noqa: E402,F401
from backend.app.core.database import get_db  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.core.database import seed_notification_templates  # noqa: E402
from backend.app.services.notification_service import notification_service  # noqa: E402
from backend.app.services.notify_live_activities import notify_live_activities  # noqa: E402
from backend.app.services.notify_widgets import notify_widgets  # noqa: E402
from backend.app.services.telegram_reactions import telegram_reaction_poller  # noqa: E402

N = "/api/v1/notifications"
T = "/api/v1/notification-templates"
U = "/api/v1/user-notifications"
VOLATILE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?")
BOUNDARY = re.compile(r"[0-9a-f]{32}")

out: list = []
wire: list = []


def scrub(v):
    if isinstance(v, dict):
        return {k: ("<ts>" if k in {"created_at", "updated_at", "last_used", "last_success", "last_error_at"} and v[k] else scrub(v[k])) for k in v}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    if isinstance(v, str):
        v = BOUNDARY.sub("<boundary>", VOLATILE.sub("<ts>", v))
        if len(v) > 300:  # a photo, a long multipart body: pin its length and digest, not the bytes
            import hashlib

            return f"<{len(v)} chars sha256={hashlib.sha256(v.encode()).hexdigest()[:16]}>"
        return v
    return v


async def answer(request: httpx.Request) -> httpx.Response:
    if request.url.path.endswith("/getUpdates"):
        # The Telegram reaction poller is a background task whose long-poll timing depends on
        # scheduling, so it is never recorded; and like real Telegram the call is held open
        # (an instant empty answer would make the poller spin and starve the probe). The probe
        # cancels the poller's tasks at the end, which releases this wait.
        await asyncio.Event().wait()
    body = request.content.decode("utf-8", "replace")
    try:
        body = json.loads(body)
    except Exception:
        body = BOUNDARY.sub("<boundary>", body)
        if "multipart" in request.headers.get("content-type", ""):
            parts = [p.split("\r\n\r\n", 1) for p in body.split("--<boundary>") if "\r\n\r\n" in p]
            body = [{"head": h.strip(), "size": len(b.rstrip("\r\n-")), "text": b.rstrip("\r\n-")[:120] if len(b) < 400 else None} for h, b in parts]
    wire.append({
        "method": request.method, "url": str(request.url),
        "headers": scrub({k: request.headers[k] for k in ("content-type", "authorization", "title", "priority", "tags", "x-priority", "x-title", "markdown", "attach", "filename") if k in request.headers}),
        "body": scrub(body),
    })
    host = request.url.host
    if "telegram" in host:
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})
    if "gotify" in host:
        return httpx.Response(200, json={"id": 1})
    return httpx.Response(200, json={"ok": True})


class FakeSMTP:
    """smtplib stand-in: records the conversation on the wire, never opens a socket."""

    def __init__(self, host, port, timeout=None, **kw):
        wire.append({"smtp": f"{type(self).__name__} {host}:{port} timeout={timeout}"})

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __getattr__(self, name):
        def call(*args, **kwargs):
            shown = list(args)
            if name == "sendmail":
                import email

                msg = email.message_from_string(args[2])
                shown = [args[0], args[1], {"subject": msg["Subject"], "from": msg["From"], "to": msg["To"],
                                            "parts": [(p.get_content_type(), len(p.get_payload())) for p in msg.walk()]}]
            wire.append({"smtp": name, "args": scrub(shown)})
            return (250, b"ok")
        return call


class FakeSMTPSSL(FakeSMTP):
    pass


def rec(step, r, *, keep=None):
    ct = r.headers.get("content-type", "")
    entry = {"step": step, "status": r.status_code}
    if not r.content:
        entry["body"] = None
    elif ct.startswith("application/json"):
        body = r.json()
        entry["body"] = scrub(body if keep is None else keep(body))
    else:
        entry["body"] = f"### {ct}: {r.text[:200]}"
    entry["wire"] = wire[:]
    wire.clear()
    out.append(entry)
    return r


def provider(name, ptype, config, **flags):
    return {"name": name, "provider_type": ptype, "config": config, **flags}


async def main() -> None:
    async with lib.temp_db() as sm:

        async def override_get_db():
            async with sm() as session:
                try:
                    yield session
                    await session.commit()
                except BaseException:
                    await session.rollback()
                    raise

        app.dependency_overrides[get_db] = override_get_db
        mock = httpx.AsyncClient(transport=httpx.MockTransport(answer))
        notification_service._http_client = mock
        telegram_reaction_poller._http_client = mock
        notify_live_activities._http = mock
        notify_widgets._http = mock
        notify_live_activities._session = sm
        notify_widgets._session = sm

        with (
            patch("smtplib.SMTP", FakeSMTP),
            patch("smtplib.SMTP_SSL", FakeSMTPSSL),
            patch("backend.app.core.database.async_session", sm),
            patch("backend.app.core.auth.async_session", sm),
            patch("backend.app.main.async_session", sm),
        ):
            await seed_notification_templates()  # what startup does: the default templates
            async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as c:
                # === A: providers ==================================================================================
                rec("A01-empty", await c.get(f"{N}/"))
                hook = provider("Hook", "webhook", {"webhook_url": "https://hooks.example.test/fenrir", "auth_header": "Bearer secret-1", "payload_format": "json"})
                r = rec("A02-create-webhook", await c.post(f"{N}/", json=hook))
                hook_id = r.json().get("id")
                r = rec("A03-create-ntfy", await c.post(f"{N}/", json=provider("Ntfy", "ntfy", {"server": "https://ntfy.example.test", "topic": "fenrir", "auth_token": "tk_abc"}, on_print_start=True, attach_photo=True, quiet_hours_enabled=True, quiet_hours_start="22:00", quiet_hours_end="07:00")))
                ntfy_id = r.json().get("id")
                r = rec("A04-create-gotify", await c.post(f"{N}/", json=provider("Gotify", "gotify", {"server": "https://gotify.example.test", "app_token": "AbCdEf", "event_priorities": {"print_complete": 5, "print_failed": 2}})))
                gotify_id = r.json().get("id")
                r = rec("A05-create-telegram", await c.post(f"{N}/", json=provider("TG", "telegram", {"bot_token": "123456:ABC-DEF", "chat_id": "-100123"}, on_print_confirm_request=True, telegram_verdict_mode="both")))
                tg_id = r.json().get("id")
                r = rec("A06-create-email", await c.post(f"{N}/", json=provider("Mail", "email", {"smtp_server": "smtp.example.test", "smtp_port": 587, "username": "u", "password": "pw", "from_email": "a@example.test", "to_email": "b@example.test", "security": "starttls", "auth_enabled": "true"})))
                mail_id = r.json().get("id")
                r = rec("A07-create-notify", await c.post(f"{N}/", json=provider("Notify", "notify", {"device_id": "ABCDEFGH1234", "token": "tok", "live_activities": True})))
                notify_id = r.json().get("id")
                rec("A08-refuse-placeholder-secret", await c.post(f"{N}/", json=provider("Bad", "gotify", {"server": "https://g.example.test", "app_token": "********"})))
                rec("A09-refuse-bad-notify-id", await c.post(f"{N}/", json=provider("Bad", "notify", {"device_id": "short", "token": "t"})))
                rec("A10-refuse-unknown-printer", await c.post(f"{N}/", json={**hook, "printer_id": 999}))
                rec("A11-refuse-unknown-type", await c.post(f"{N}/", json=provider("Bad", "carrier-pigeon", {})))
                rec("A12-refuse-empty-name", await c.post(f"{N}/", json=provider("", "webhook", {"webhook_url": "https://x.example.test"})))
                rec("A13-refuse-bad-quiet-hours", await c.post(f"{N}/", json=provider("Q", "webhook", {"webhook_url": "https://x.example.test"}, quiet_hours_enabled=True, quiet_hours_start="25:99", quiet_hours_end="x")))
                rec("A14-refuse-bad-verdict-mode", await c.post(f"{N}/", json=provider("Q", "telegram", {"bot_token": "1:a", "chat_id": "1"}, telegram_verdict_mode="smoke")))
                rec("A15-refuse-missing-config", await c.post(f"{N}/", json={"name": "x", "provider_type": "webhook"}))
                rec("A16-list", await c.get(f"{N}/"))
                rec("A17-get-ntfy", await c.get(f"{N}/{ntfy_id}"))
                rec("A18-get-404", await c.get(f"{N}/9999"))
                rec("A19-patch-flags", await c.patch(f"{N}/{ntfy_id}", json={"enabled": False, "on_print_complete": False, "name": "Ntfy 2"}))
                rec("A20-patch-config-keeps-masked-secret", await c.patch(f"{N}/{gotify_id}", json={"config": {"server": "https://gotify2.example.test", "app_token": "********"}}))
                rec("A21-patch-config-new-secret", await c.patch(f"{N}/{gotify_id}", json={"config": {"server": "https://gotify2.example.test", "app_token": "NewTok"}}))
                rec("A22-patch-null-required", await c.patch(f"{N}/{ntfy_id}", json={"name": None, "enabled": None}))
                rec("A23-patch-404", await c.patch(f"{N}/9999", json={"enabled": True}))
                rec("A24-patch-type-change", await c.patch(f"{N}/{hook_id}", json={"provider_type": "ntfy", "config": {"server": "https://n.example.test", "topic": "t"}}))
                rec("A25-patch-type-back", await c.patch(f"{N}/{hook_id}", json={"provider_type": "webhook", "config": {"webhook_url": "https://hooks.example.test/fenrir", "auth_header": "Bearer secret-1", "payload_format": "json"}}))

                # === B: tests ======================================================================================
                rec("B01-test-config-webhook", await c.post(f"{N}/test-config", json={"provider_type": "webhook", "config": {"webhook_url": "https://hooks.example.test/t", "payload_format": "json"}}))
                rec("B02-test-config-webhook-get", await c.post(f"{N}/test-config", json={"provider_type": "webhook", "config": {"webhook_url": "https://hooks.example.test/t?x=1", "payload_format": "form", "field_title": "subject", "field_message": "text"}}))
                rec("B03-test-config-ntfy", await c.post(f"{N}/test-config", json={"provider_type": "ntfy", "config": {"server": "https://ntfy.example.test", "topic": "fenrir", "auth_token": "tk"}, "attach_photo": True}))
                rec("B04-test-config-gotify", await c.post(f"{N}/test-config", json={"provider_type": "gotify", "config": {"server": "https://gotify.example.test", "app_token": "T", "event_priorities": {"test": 4}}}))
                rec("B05-test-config-telegram", await c.post(f"{N}/test-config", json={"provider_type": "telegram", "config": {"bot_token": "123456:ABC", "chat_id": "42"}}))
                rec("B06-test-config-discord", await c.post(f"{N}/test-config", json={"provider_type": "discord", "config": {"webhook_url": "https://discord.com/api/webhooks/1/abc"}}))
                rec("B07-test-config-pushover", await c.post(f"{N}/test-config", json={"provider_type": "pushover", "config": {"user_key": "u" * 30, "app_token": "a" * 30, "priority": 1}}))
                rec("B08-test-config-bark", await c.post(f"{N}/test-config", json={"provider_type": "bark", "config": {"server": "https://bark.example.test", "device_key": "key1", "level": "timeSensitive", "group": "fenrir"}}))
                rec("B09-test-config-homeassistant", await c.post(f"{N}/test-config", json={"provider_type": "homeassistant", "config": {"service": "notify.mobile_app", "data": {"x": 1}}}))
                rec("B10-test-config-callmebot", await c.post(f"{N}/test-config", json={"provider_type": "callmebot", "config": {"phone": "+68987000000", "apikey": "123456"}}))
                rec("B11-test-config-notify", await c.post(f"{N}/test-config", json={"provider_type": "notify", "config": {"device_id": "ABCDEFGH1234", "token": "tok"}}))
                rec("B12-test-config-private-url-refused", await c.post(f"{N}/test-config", json={"provider_type": "webhook", "config": {"webhook_url": "http://169.254.169.254/latest"}}))
                rec("B13-test-config-placeholder-no-id", await c.post(f"{N}/test-config", json={"provider_type": "gotify", "config": {"server": "https://g.example.test", "app_token": "********"}}))
                rec("B14-test-config-placeholder-with-id", await c.post(f"{N}/test-config", json={"provider_type": "gotify", "config": {"server": "https://gotify2.example.test", "app_token": "********"}, "provider_id": gotify_id}))
                rec("B15-test-config-with-unknown-id", await c.post(f"{N}/test-config", json={"provider_type": "gotify", "config": {"server": "https://g.example.test", "app_token": "x"}, "provider_id": 9999}))
                rec("B16-test-provider-ntfy", await c.post(f"{N}/{ntfy_id}/test"))
                rec("B17-test-provider-telegram", await c.post(f"{N}/{tg_id}/test"))
                rec("B18-test-provider-404", await c.post(f"{N}/9999/test"))
                rec("B19-test-all", await c.post(f"{N}/test-all"))

                # === C: logs =======================================================================================
                rec("C01-logs", await c.get(f"{N}/logs"), keep=lambda b: [{k: v for k, v in e.items() if k != "id"} for e in b])
                rec("C02-logs-filter-provider", await c.get(f"{N}/logs", params={"provider_id": ntfy_id}), keep=lambda b: [{k: v for k, v in e.items() if k != "id"} for e in b])
                rec("C03-logs-filter-event", await c.get(f"{N}/logs", params={"event_type": "test"}), keep=lambda b: len(b))
                rec("C04-logs-filter-success", await c.get(f"{N}/logs", params={"success": False}), keep=lambda b: len(b))
                rec("C05-logs-bad-limit", await c.get(f"{N}/logs", params={"limit": 0}))
                rec("C06-logs-bad-days", await c.get(f"{N}/logs", params={"days": 91}))
                rec("C07-logs-stats", await c.get(f"{N}/logs/stats"))
                rec("C08-logs-stats-days", await c.get(f"{N}/logs/stats", params={"days": 1}))
                rec("C09-logs-clear-old", await c.delete(f"{N}/logs", params={"older_than_days": 30}))
                rec("C10-logs-clear-all", await c.delete(f"{N}/logs", params={"older_than_days": 0}))
                rec("C11-logs-after-clear", await c.get(f"{N}/logs"), keep=len)
                rec("C12-photo-404", await c.get(f"{N}/photos/nope.jpg"))
                rec("C13-photo-traversal", await c.get(f"{N}/photos/..%2F..%2Fetc%2Fpasswd"))

                # === D: templates ==================================================================================
                r = rec("D01-templates", await c.get(T), keep=lambda b: [{k: v for k, v in e.items() if k != "id"} for e in b])
                templates = {t["event_type"]: t["id"] for t in r.json()} if r.status_code == 200 else {}
                rec("D02-templates-slash", await c.get(f"{T}/"), keep=len)
                rec("D03-variables", await c.get(f"{T}/variables"))
                pc = templates.get("print_complete")
                rec("D04-get", await c.get(f"{T}/{pc}"), keep=lambda b: {k: v for k, v in b.items() if k != "id"})
                rec("D05-put", await c.put(f"{T}/{pc}", json={"title_template": "{printer_name} fini", "body_template": "{file_name} en {duration} {unknown}"}), keep=lambda b: {k: v for k, v in b.items() if k != "id"})
                rec("D06-put-empty-title", await c.put(f"{T}/{pc}", json={"title_template": "", "body_template": "x"}))
                rec("D07-reset", await c.post(f"{T}/{pc}/reset"), keep=lambda b: {k: v for k, v in b.items() if k != "id"})
                rec("D08-get-404", await c.get(f"{T}/99999"))
                rec("D09-put-404", await c.put(f"{T}/99999", json={"title_template": "a", "body_template": "b"}))
                rec("D10-reset-404", await c.post(f"{T}/99999/reset"))
                rec("D11-preview", await c.post(f"{T}/preview", json={"event_type": "print_complete", "title_template": "{printer_name}: {file_name}", "body_template": "{duration} {filament_used} {nope} {Upper}"}))
                rec("D12-preview-unknown-event", await c.post(f"{T}/preview", json={"event_type": "nope", "title_template": "{printer_name}", "body_template": "b"}))

                # === E: user email preferences (auth disabled) =====================================================
                rec("E01-prefs-get", await c.get(f"{U}/preferences"))
                rec("E02-prefs-put", await c.put(f"{U}/preferences", json={"notify_print_start": True, "notify_print_complete": False, "notify_print_failed": True, "notify_print_stopped": False}))
                rec("E03-prefs-get-again", await c.get(f"{U}/preferences"))

                # === F: app messages ===============================================================================
                rec("F01-app-message-channels", await c.get(f"{N}/app-message/channels"))
                rec("F02-app-message-send-no-provider", await c.post(f"{N}/app-message", json={"title": "Hello", "message": "from a probe"}))
                rec("F03-enable-app-message-on-hook", await c.patch(f"{N}/{hook_id}", json={"on_app_message": True}))
                rec("F04-app-message-channels-again", await c.get(f"{N}/app-message/channels"))
                rec("F05-app-message-send", await c.post(f"{N}/app-message", json={"title": "Hello", "message": "from a probe", "priority": "high"}))
                rec("F06-app-message-bad", await c.post(f"{N}/app-message", json={"title": ""}))

                # === A-end: delete =================================================================================
                rec("A26-delete", await c.delete(f"{N}/{mail_id}"))
                rec("A27-delete-404", await c.delete(f"{N}/{mail_id}"))
                rec("A28-list-after-delete", await c.get(f"{N}/"), keep=lambda b: [p["name"] for p in b])

                # === G: who may call what ==========================================================================
                from backend.app.core.auth import create_access_token, get_password_hash
                from backend.app.models.group import Group
                from backend.app.models.settings import Settings
                from backend.app.models.user import User

                principals = {
                    "none": [],
                    "read": ["notifications:read", "notification_templates:read"],
                    "full": ["notifications:read", "notifications:create", "notifications:update", "notifications:delete",
                             "notification_templates:read", "notification_templates:update", "notifications:user_email"],
                }
                async with sm() as db:
                    db.add(Settings(key="auth_enabled", value="true"))
                    for name, perms in principals.items():
                        user = User(username=f"notif-{name}", password_hash=get_password_hash("password"), is_active=True)
                        user.groups.append(Group(name=f"notif-{name}", permissions=perms, is_system=False))
                        db.add(user)
                    await db.commit()
                tokens = {name: {"Authorization": f"Bearer {create_access_token(data={'sub': f'notif-{name}'})}"} for name in principals}
                tokens["no token"] = {}
                tokens["bad token"] = {"Authorization": "Bearer not-a-token"}
                gate = {}
                for method, path, body in (
                    ("GET", f"{N}/", None),
                    ("POST", f"{N}/", provider("G", "webhook", {"webhook_url": "https://hooks.example.test/g"})),
                    ("GET", f"{N}/{hook_id}", None),
                    ("PATCH", f"{N}/{hook_id}", {"enabled": True}),
                    ("DELETE", f"{N}/{notify_id}", None),
                    ("POST", f"{N}/test-config", {"provider_type": "webhook", "config": {"webhook_url": "https://hooks.example.test/g"}}),
                    ("POST", f"{N}/test-config", {"provider_type": "webhook", "config": {"webhook_url": "https://hooks.example.test/g"}, "provider_id": hook_id}),
                    ("POST", f"{N}/{hook_id}/test", None),
                    ("POST", f"{N}/test-all", None),
                    ("GET", f"{N}/logs", None),
                    ("GET", f"{N}/logs/stats", None),
                    ("DELETE", f"{N}/logs", None),
                    ("GET", f"{N}/photos/x.jpg", None),
                    ("GET", f"{N}/app-message/channels", None),
                    ("POST", f"{N}/app-message", {"title": "t", "message": "m"}),
                    ("GET", T, None),
                    ("GET", f"{T}/variables", None),
                    ("GET", f"{T}/{pc}", None),
                    ("PUT", f"{T}/{pc}", {"title_template": "a", "body_template": "b"}),
                    ("POST", f"{T}/{pc}/reset", None),
                    ("POST", f"{T}/preview", {"event_type": "print_complete", "title_template": "a", "body_template": "b"}),
                    ("GET", f"{U}/preferences", None),
                    ("PUT", f"{U}/preferences", {"notify_print_start": True, "notify_print_complete": True, "notify_print_failed": True, "notify_print_stopped": True}),
                ):
                    row = {}
                    for who, headers in tokens.items():
                        r = await c.request(method, path, json=body, headers=headers)
                        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") and isinstance(r.json(), dict) else None
                        row[who] = [r.status_code, detail if r.status_code >= 400 else "ok"]
                        wire.clear()
                    gate[f"{method} {path}"] = row
                out.append({"step": "G01-permission-gate", "gate": gate})

        for t in telegram_reaction_poller.stop():
            t.cancel()
        await telegram_reaction_poller.aclose()
        await mock.aclose()
        app.dependency_overrides.clear()


try:
    asyncio.run(main())
finally:
    print(json.dumps(out, indent=1, sort_keys=True, default=str))
