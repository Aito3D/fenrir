"""``get_current_user_info`` (GET /me) has its own revocation/freshness checks
that duplicate ``app.main``'s ``auth_middleware`` gateway (which runs ahead of
every route and rejects revoked/stale/invalid tokens first). Because the
gateway always wins in HTTP-level tests, the route handler's own copy of
these checks — missing ``sub``, missing/revoked ``jti``, an inactive user, and
a stale ``iat`` — is never actually exercised through ``TestClient``.

These tests call ``get_current_user_info`` directly as a coroutine,
constructing ``HTTPAuthorizationCredentials`` by hand and bypassing both
``TestClient`` and the middleware, so the route's own defense-in-depth logic
is verified independently.
"""

from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from backend.app.api.routes.auth import get_current_user_info
from backend.app.core.auth import ALGORITHM, SECRET_KEY, get_password_hash
from backend.app.models.auth_ephemeral import AuthEphemeralToken
from backend.app.models.user import User


def _mint(payload: dict) -> str:
    """Encode a JWT with exactly the given claims, bypassing create_access_token
    so we can omit sub/jti/iat or backdate iat at will."""
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _bearer(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


async def _make_user(db_session, **overrides) -> User:
    defaults = {
        "username": "t097-user",
        "password_hash": get_password_hash("irrelevant"),
        "is_active": True,
    }
    defaults.update(overrides)
    user = User(**defaults)
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_missing_sub_rejected(db_session):
    """No ``sub`` claim -> 401, hits auth.py:697-701."""
    token = _mint({"jti": "t097-jti-nosub", "iat": int(datetime.now(timezone.utc).timestamp())})

    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_missing_jti_rejected(db_session):
    """No ``jti`` claim -> 401, hits auth.py:703-708 (the "not jti" branch)."""
    await _make_user(db_session, username="t097-user-nojti")
    token = _mint({"sub": "t097-user-nojti", "iat": int(datetime.now(timezone.utc).timestamp())})

    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_revoked_jti_rejected(db_session):
    """A revoked ``jti`` -> 401, hits auth.py:703-708 (the is_jti_revoked branch)."""
    await _make_user(db_session, username="t097-user-revoked")
    jti = "t097-jti-revoked"
    db_session.add(
        AuthEphemeralToken(
            token=jti,
            token_type="revoked_jti",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        )
    )
    await db_session.commit()
    token = _mint({"sub": "t097-user-revoked", "jti": jti, "iat": int(datetime.now(timezone.utc).timestamp())})

    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_garbage_token_rejected(db_session):
    """Undecodable token -> 401, hits auth.py:710-714 (the JWTError branch)."""
    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer("not-a-real-jwt"), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_unknown_user_rejected(db_session):
    """A well-formed token for a username that does not exist -> 401, hits
    auth.py:718-722 (the "user is None" branch)."""
    token = _mint({"sub": "t097-nobody", "jti": "t097-jti-nobody", "iat": int(datetime.now(timezone.utc).timestamp())})

    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_inactive_user_rejected(db_session):
    """A valid token for a deactivated user -> 401, hits auth.py:718-722 (the
    "not user.is_active" branch)."""
    await _make_user(db_session, username="t097-user-inactive", is_active=False)
    token = _mint(
        {
            "sub": "t097-user-inactive",
            "jti": "t097-jti-inactive",
            "iat": int(datetime.now(timezone.utc).timestamp()),
        }
    )

    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_stale_iat_rejected(db_session):
    """A token issued before the user's last password change -> 401, hits
    auth.py:728-733 (the _is_token_fresh branch)."""
    now = datetime.now(timezone.utc)
    await _make_user(db_session, username="t097-user-stale", password_changed_at=now)
    stale_iat = int((now - timedelta(hours=1)).timestamp())
    token = _mint({"sub": "t097-user-stale", "jti": "t097-jti-stale", "iat": stale_iat})

    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"


@pytest.mark.asyncio
async def test_valid_token_returns_user(db_session):
    """The happy path, through the same direct call, hits auth.py:734."""
    await _make_user(db_session, username="t097-user-happy")
    token = _mint(
        {"sub": "t097-user-happy", "jti": "t097-jti-happy", "iat": int(datetime.now(timezone.utc).timestamp())}
    )

    response = await get_current_user_info(credentials=_bearer(token), x_api_key=None, db=db_session)

    assert response.username == "t097-user-happy"
    assert response.is_active is True


@pytest.mark.asyncio
async def test_invalid_bb_api_key_rejected(db_session):
    """A bearer token shaped like an API key (``bb_...``) that doesn't
    resolve to a real key -> 401 "Invalid API key", hits auth.py:686-690."""
    with pytest.raises(HTTPException) as exc:
        await get_current_user_info(credentials=_bearer("bb_not-a-real-key"), x_api_key=None, db=db_session)

    assert exc.value.status_code == 401
    assert exc.value.detail == "Invalid API key"
