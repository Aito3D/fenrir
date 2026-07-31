"""The poll interval is an API-quota decision, not a taste one.

Zoho Books allows 1,000-10,000 requests/day per organisation depending on
plan, and run_sync_once spends one estimate call per active quoted project
per tick. At 60s that is 1,440 calls/day/project, which exhausts a Standard
plan at roughly 1.5 concurrent quotes. 300s brings it to 288/day/project.
Lowering this default again silently reintroduces 429s on a busy board.
"""

from backend.app.services.aito_quote_sync import _DEFAULT_INTERVAL_SECONDS


def test_default_poll_interval_is_five_minutes():
    assert _DEFAULT_INTERVAL_SECONDS == 300
