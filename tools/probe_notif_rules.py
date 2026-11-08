"""Notifications campaign golden probe: the pure rules of the notifications stack, fixed inputs.

Module-level helpers of notification_service (telegram escaping, Cloudflare detection,
event priority mapping, opaque failure wording), the NotificationService's pure formatters
(template render, duration, filename, quiet hours at a pinned clock), the Notify client's
credential parsing, the widget content card, the template catalogue (event types, variables,
photo-capable events, sample data, event names) and the ProviderType enum. Any change in
output is a user-visible change in a message, a card or a catalogue.
"""

import datetime as _dt
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, ".")

import httpx  # noqa: E402

import backend.app.main  # noqa: E402,F401
from backend.app.api.routes import notification_templates as tmpl_routes  # noqa: E402
from backend.app.schemas import notification as nschema  # noqa: E402
from backend.app.schemas import notification_template as tschema  # noqa: E402
from backend.app.services import notification_service as ns  # noqa: E402
from backend.app.services import notify_client as nc  # noqa: E402
from backend.app.services import notify_widgets as nw  # noqa: E402

out: dict = {}


def safe(fn):
    try:
        v = fn()
        return "__None__" if v is None else v
    except Exception as e:  # the exception IS the behaviour
        return {"__raised__": f"{type(e).__name__}: {e}"}


svc = ns.NotificationService()

out["telegram_markdown_escape"] = {
    s: safe(lambda s=s: ns.telegram_markdown_escape(s))
    for s in ["plain", "a_b*c[d]e(f)~g`h>i#j+k-l=m|n{o}p.q!r", "", "100% done — été.3mf", "\\already\\escaped_"]
}
out["event_priority_level"] = {
    json.dumps([cfg, ev]): safe(lambda cfg=cfg, ev=ev: ns._event_priority_level(cfg, ev))
    for cfg, ev in [
        ({}, "print_complete"),
        ({"event_priorities": {"print_complete": 5}}, "print_complete"),
        ({"event_priorities": {"print_complete": "4"}}, "print_complete"),
        ({"event_priorities": {"print_complete": 9}}, "print_complete"),
        ({"event_priorities": {"print_complete": 0}}, "print_complete"),
        ({"event_priorities": {"print_complete": "x"}}, "print_complete"),
        ({"event_priorities": {"print_complete": 3}}, None),
        ({"event_priorities": "nope"}, "print_complete"),
        ({"event_priorities": {"print_failed": 2}}, "print_complete"),
    ]
}
out["gotify_priority_by_level"] = ns._GOTIFY_PRIORITY_BY_LEVEL
out["digest_retry_hours"] = ns.DIGEST_RETRY_HOURS
out["telegram_reaction_hint"] = ns.TELEGRAM_REACTION_HINT


def resp(status, body, headers=None, ctype="text/html"):
    h = {"content-type": ctype, **(headers or {})}
    return httpx.Response(status, content=body.encode(), headers=h, request=httpx.Request("POST", "https://x.test/hook"))


cases = {
    "403 cf challenge": resp(403, "<html><title>Just a moment...</title>cf-browser-verification</html>", {"server": "cloudflare"}),
    "403 cf mitigated": resp(403, "<html>blocked</html>", {"server": "cloudflare", "cf-mitigated": "challenge"}),
    "403 plain": resp(403, "forbidden"),
    "503 cf": resp(503, "<title>Attention Required! | Cloudflare</title>", {"server": "cloudflare"}),
    "200 ok": resp(200, "ok"),
    "500 json": resp(500, '{"error":"boom"}', ctype="application/json"),
    "429 text": resp(429, "slow down " * 50),
    "401 empty": resp(401, ""),
}
out["looks_like_cloudflare_challenge"] = {k: safe(lambda r=r: ns._looks_like_cloudflare_challenge(r)) for k, r in cases.items()}
out["opaque_http_failure"] = {k: safe(lambda r=r: ns._opaque_http_failure(r, label="Webhook")) for k, r in cases.items()}
out["assert_safe_provider_url"] = {
    u: safe(lambda u=u: ns._assert_safe_provider_url(u, label="Webhook"))
    for u in ["", "not a url", "ftp://example.com/x", "http://[::1]/x", "http://127.0.0.1:8123/hook", "http://10.0.0.5/hook",
              "http://192.168.1.10/hook", "http://169.254.169.254/latest", "http://localhost/hook", "http://0.0.0.0/hook"]
}

out["render_template"] = {
    json.dumps([t, v]): safe(lambda t=t, v=v: svc._render_template(t, v))
    for t, v in [
        ("{printer_name}: {file_name} done in {duration}", {"printer_name": "X1C", "file_name": "cat.3mf", "duration": "1h 2m"}),
        ("{printer_name} {missing} {printer_name}", {"printer_name": "P1S"}),
        ("{ok} {Mixed_Case} {with-dash} {{double}}", {"ok": 1, "Mixed_Case": "m"}),
        ("", {"a": "b"}),
        ("no placeholders", {}),
        ("{none}", {"none": None}),
    ]
}
out["format_duration"] = {str(s): safe(lambda s=s: svc._format_duration(s)) for s in [None, 0, 1, 59, 60, 61, 3599, 3600, 3661, 86399, 86400, 90061, -5, 12.7]}
out["clean_filename"] = {f: safe(lambda f=f: svc._clean_filename(f)) for f in [
    "/data/Metadata/plate_1.gcode", "cat.gcode.3mf", "Benchy.3MF", "dir/sub/file", "noext", "", "a.b.c.d.gcode.3mf", "weird name (1).3mf", "/cache/é.3mf"]}

quiet = {}
for start, end, now in [
    ("22:00", "07:00", (23, 30)), ("22:00", "07:00", (6, 59)), ("22:00", "07:00", (7, 0)), ("22:00", "07:00", (12, 0)),
    ("09:00", "17:00", (12, 0)), ("09:00", "17:00", (17, 0)), ("09:00", "17:00", (8, 59)), ("09:00", "09:00", (9, 0)),
    (None, None, (12, 0)), ("bad", "07:00", (12, 0)), ("22:00", None, (23, 0)),
]:
    prov = SimpleNamespace(quiet_hours_enabled=True, quiet_hours_start=start, quiet_hours_end=end, name="p")
    fixed = _dt.datetime(2026, 3, 14, *now)

    class FakeDT(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed if tz is None else fixed.replace(tzinfo=tz)

    with patch.object(ns, "datetime", FakeDT, create=True):
        quiet[f"{start}-{end} @ {now[0]:02d}:{now[1]:02d}"] = safe(lambda p=prov: svc._is_in_quiet_hours(p))
quiet["disabled"] = safe(lambda: svc._is_in_quiet_hours(SimpleNamespace(quiet_hours_enabled=False, quiet_hours_start="00:00", quiet_hours_end="23:59", name="p")))
out["is_in_quiet_hours"] = quiet

out["notify_credentials"] = {
    json.dumps(c): safe(lambda c=c: list(nc.notify_credentials(c)))
    for c in [{}, {"device_id": "ABCDEFGH1234", "token": "t"}, {"device_id": "ABCDEFGH1234", "token": ""}, {"device_id": "GRP12345", "token": "t"},
              {"device_id": "WB123456", "token": "t"}, {"device_id": "MC123456", "token": "t", "live_activities": True},
              {"device_id": "GRP12345", "token": "t", "lock_screen_widgets": True}, {"device_id": "ABCDEFGH1234", "token": "t", "live_activities": True},
              {"token": "t"}, {"device_id": " ABCDEFGH1234 ", "token": " t "}, {"device_id": 12, "token": "t"}, {"device_id": "short", "token": "t"},
              {"device_id": "A" * 33, "token": "t"}, {"device_id": "ABCDEFGH1234", "token": "t", "button": "x" * 513},
              {"device_id": "ABCDEFGH1234", "token": "t", "tint": "#12345"}, {"device_id": "ABCDEFGH1234", "token": "t", "tint": "#AABBCC"},
              {"device_id": "ABCDEFGH1234", "token": "t", "symbol": "a\x00b"}, {"device_id": "ABCDEFGH1234", "token": "t", "metrics": list("abcdefg")}]
}
out["notify_supports_photos"] = {str(d): safe(lambda d=d: nc.notify_supports_photos(d)) for d in ["ABC", "wb1", " WB", "GRP1", "grp", None, 5, ""]}

from backend.app.services.bambu_mqtt import PrinterState  # noqa: E402


def S(**k):
    st = PrinterState(connected=True, state="IDLE")
    for a, v in k.items():
        setattr(st, a, v)
    return st


widget_cases = {
    "disconnected": None,
    "not_connected": PrinterState(),
    "idle": S(),
    "printing": S(state="RUNNING", progress=42.5, remaining_time=95, layer_num=12, total_layers=240, subtask_name="cat.3mf"),
    "preparing": S(state="PREPARE", progress=0, stg_cur=2, subtask_name="warm"),
    "printing_no_layers": S(state="RUNNING", progress=100, remaining_time=0, subtask_name="x"),
    "paused": S(state="PAUSE", progress=10, remaining_time=5, subtask_name="y.3mf"),
    "failed": S(state="FAILED", hms_errors=[{"code": "0300_0D00_0001_0002", "attr": 0x03000D00, "msg": "Nozzle clog"}]),
    "hms_advisory_only": S(state="RUNNING", progress=5, hms_errors=[{"code": "0700_2000_0002_0001", "attr": 0x07002000}]),
    "finished": S(state="FINISH", progress=100, subtask_name="done.3mf"),
    "long_name": S(state="RUNNING", progress=1, subtask_name="n" * 300, temperatures={"nozzle": 220.4, "bed": 60}),
}
out["widget_content"] = {k: safe(lambda v=v, k=k: nw.widget_content("Printer \x00Name" if k == "idle" else ("" if k == "finished" else "X1C"), v)) for k, v in widget_cases.items()}

from backend.app.services.notify_live_activities import PrintSnapshot  # noqa: E402

snaps = {}
for k, v in widget_cases.items():
    if v is None:
        continue
    def one(v=v):
        snap = PrintSnapshot.from_state(v)
        d = {f: getattr(snap, f) for f in ("key", "connected", "state", "filename", "progress", "remaining_seconds", "layer", "layers", "job_key", "fault", "temperatures", "stage")}
        d["content"] = snap.content("X1C")
        d["content_cfg"] = snap.content("X1C", {"metrics": ["nozzle", "bed", "layer", "eta"], "tint": "#AABBCC", "symbol": "cube", "button": "Open"})
        return d
    snaps[k] = safe(one)
out["print_snapshot"] = snaps

import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402

from backend.app.utils import notification_photos as photos  # noqa: E402

with tempfile.TemporaryDirectory(prefix="fenrir-notif-photos-") as tmp:
    with patch.object(photos.settings, "base_dir", Path(tmp)):
        names = {}
        for ev, data in [("print_complete", b"\xff\xd8\xff jpeg"), ("print_failed", b""), ("weird/../event", b"x"), ("", b"x")]:
            names[ev] = safe(lambda ev=ev, data=data: photos.save_notification_photo(data, ev))
        import re as _re

        saved = [v for v in names.values() if isinstance(v, str)]
        norm = lambda n: _re.sub(r"[A-Za-z0-9_-]{30,}", "<token>", _re.sub(r"\d{8}[_-]?\d{6}", "<stamp>", n))  # noqa: E731
        shape = {n: norm(n) for n in saved}
        finds = {}
        for f in [*saved, "nope.jpg", "../etc/passwd", "a/b.jpg", "", (saved[0] + ".png") if saved else "x.png", saved[0].upper() if saved else "X"]:
            r = safe(lambda f=f: photos.find_notification_photo(f))
            finds[norm(f)] = ("found" if isinstance(r, Path) and r.exists() else ("path-not-existing" if isinstance(r, Path) else r))
        out["notification_photos"] = {"saved_name_shapes": sorted(set(shape.values())), "save_errors": {k: v for k, v in names.items() if not isinstance(v, str)}, "find": finds}

from backend.app.models.notification_template import DEFAULT_TEMPLATES  # noqa: E402

out["default_templates"] = DEFAULT_TEMPLATES
out["provider_types"] = [e.value for e in nschema.ProviderType]
out["event_types"] = [e.value for e in tschema.EventType]
out["event_variables"] = tschema.EVENT_VARIABLES
out["photo_capable_events"] = sorted(tschema.PHOTO_CAPABLE_EVENTS)
out["sample_data"] = tschema.SAMPLE_DATA
out["event_names"] = getattr(tmpl_routes, "EVENT_NAMES", "__missing__")
out["template_schema_public"] = sorted(n for n in dir(tschema) if not n.startswith("_") and n[0].isupper())

print(json.dumps(out, indent=1, sort_keys=True, default=str))
