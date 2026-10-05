"""`_assert_totp_not_replayed` records the time-step the code BELONGS to.

`verify(valid_window=1)` accepts the previous and next 30-second steps too, so
the stored counter must be the matched step, not the wall-clock one. The
helper used to pass a counter to `TOTP.at()`, which takes a Unix timestamp:
the lookup never matched, it fell back to `timecode(now)`, and a code used in
the last seconds of its window was accepted again in the next window
(CI: test_mfa_api.py::TestTOTPReplay::test_totp_replay_rejected_on_disable).
"""

from datetime import datetime, timezone
from types import SimpleNamespace

import pyotp
import pytest
from fastapi import HTTPException

from backend.app.api.routes import mfa
from backend.app.models.user_totp import UserTOTP

SECRET = pyotp.random_base32()
TOTP = pyotp.TOTP(SECRET)
STEP = 59_000_000  # an arbitrary time-step counter


def _frozen_at(counter: int, seconds_into_step: int):
    instant = datetime.fromtimestamp(counter * TOTP.interval + seconds_into_step, tz=timezone.utc)

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant if tz else instant.replace(tzinfo=None)

    return SimpleNamespace(datetime=_Frozen)


def _record(last_counter):
    return UserTOTP(user_id=1, last_totp_counter=last_counter)


@pytest.mark.parametrize("offset", [-1, 0, 1])
def test_stores_the_counter_the_code_belongs_to(monkeypatch, offset):
    monkeypatch.setattr(mfa, "datetime", _frozen_at(STEP, 5).datetime)
    record = _record(None)
    mfa._assert_totp_not_replayed(TOTP, record, TOTP.generate_otp(STEP + offset))
    assert record.last_totp_counter == STEP + offset


def test_a_code_used_at_the_end_of_its_window_is_refused_in_the_next(monkeypatch):
    code = TOTP.generate_otp(STEP)
    monkeypatch.setattr(mfa, "datetime", _frozen_at(STEP, 29).datetime)
    record = _record(None)
    mfa._assert_totp_not_replayed(TOTP, record, code)

    monkeypatch.setattr(mfa, "datetime", _frozen_at(STEP + 1, 1).datetime)
    with pytest.raises(HTTPException) as exc:
        mfa._assert_totp_not_replayed(TOTP, record, code)
    assert exc.value.status_code == 400
    assert record.last_totp_counter == STEP


def test_the_next_steps_code_is_still_accepted(monkeypatch):
    monkeypatch.setattr(mfa, "datetime", _frozen_at(STEP + 1, 1).datetime)
    record = _record(STEP)
    mfa._assert_totp_not_replayed(TOTP, record, TOTP.generate_otp(STEP + 1))
    assert record.last_totp_counter == STEP + 1
