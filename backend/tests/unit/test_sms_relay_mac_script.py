"""scripts/sms_relay_mac.py: origin check and body validation (the part that runs without a Mac)."""

import importlib.util
import json
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[3] / "scripts" / "sms_relay_mac.py"
_FENRIR = "https://app.aito3d.fr"


@pytest.fixture
def relay():
    spec = importlib.util.spec_from_file_location("sms_relay_mac", _PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _body(**kw):
    return json.dumps({"phone": "87 12 34 56", "text": "Ia Ora na", **kw}).encode()


@pytest.mark.parametrize("origin", ["https://app.aito3d.fr", "http://192.168.50.60:8000"])
def test_fenrir_origins_are_accepted(relay, origin):
    assert relay.parse_request(origin, _body()) == (200, "ok", ("87 12 34 56", "Ia Ora na"))


@pytest.mark.parametrize("origin", [None, "", "https://evil.example", "https://app.aito3d.fr.evil.example", "null"])
def test_any_other_origin_is_refused(relay, origin):
    """No Origin (curl, local scripts) or a foreign site never sends."""
    assert relay.parse_request(origin, _body())[0] == 403


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b"[]",
        json.dumps({"phone": "87"}).encode(),
        _body(phone="87; rm -rf /"),
        _body(text="  "),
        _body(text="x" * 1601),
    ],
)
def test_bad_body_is_refused(relay, body):
    assert relay.parse_request(_FENRIR, body)[0] == 400


async def test_page_csp_lets_the_browser_reach_the_local_relay(async_client):
    """Without it the browser blocks the relay call before it leaves the page."""
    r = await async_client.get("/")
    assert "http://localhost:8765" in r.headers["content-security-policy"]
