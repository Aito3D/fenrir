"""Fenrir: the media token is also handed over as a cookie.

A thumbnail URL carrying ``?token=`` changes whenever the token rotates, so
the browser cache never reuses it. With the token in a cookie the URL stays
stable. These tests pin that the cookie grants exactly what the query token
grants, and nothing more.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.core.auth import MEDIA_COOKIE_NAME
from backend.tests.integration.test_media_token_3025 import (
    NO_CAMERA_PERMISSIONS,
    _admin_token,
    _clean_thumbs,  # noqa: F401  (autouse fixture: removes the thumbnails written here)
    _library_file,
    _make_user,
    _mint_media_token,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def test_the_cookie_alone_serves_the_owners_thumbnail(async_client: AsyncClient, db_session):
    admin = await _admin_token(async_client, "_ck_own")
    jwt, user_id = await _make_user(async_client, admin, username="ck_owner", permissions=NO_CAMERA_PERMISSIONS)
    file_id = await _library_file(db_session, user_id, "ck_own")

    token = await _mint_media_token(async_client, jwt)
    assert async_client.cookies.get(MEDIA_COOKIE_NAME) == token

    response = await async_client.get(f"/api/v1/library/files/{file_id}/thumbnail")
    assert response.status_code == 200


async def test_the_cookie_cannot_read_another_users_thumbnail(async_client: AsyncClient, db_session):
    admin = await _admin_token(async_client, "_ck_cross")
    _, alice_id = await _make_user(async_client, admin, username="ck_alice", permissions=NO_CAMERA_PERMISSIONS)
    bob_jwt, _ = await _make_user(async_client, admin, username="ck_bob", permissions=NO_CAMERA_PERMISSIONS)
    alice_file = await _library_file(db_session, alice_id, "ck_alice")
    await _mint_media_token(async_client, bob_jwt)

    response = await async_client.get(f"/api/v1/library/files/{alice_file}/thumbnail")
    assert response.status_code == 404


async def test_explicit_credentials_win_over_the_cookie(async_client: AsyncClient, db_session):
    """A fetch() with a bearer token is answered as that user, not the cookie's."""
    admin = await _admin_token(async_client, "_ck_hdr")
    alice_jwt, alice_id = await _make_user(
        async_client, admin, username="ck_alice_hdr", permissions=NO_CAMERA_PERMISSIONS
    )
    bob_jwt, _ = await _make_user(async_client, admin, username="ck_bob_hdr", permissions=NO_CAMERA_PERMISSIONS)
    alice_file = await _library_file(db_session, alice_id, "ck_hdr")
    await _mint_media_token(async_client, bob_jwt)  # the jar now holds Bob's cookie

    response = await async_client.get(
        f"/api/v1/library/files/{alice_file}/thumbnail",
        headers={"Authorization": f"Bearer {alice_jwt}"},
    )
    assert response.status_code == 200


async def test_no_cookie_and_no_token_is_refused(async_client: AsyncClient, db_session):
    admin = await _admin_token(async_client, "_ck_none")
    _, user_id = await _make_user(async_client, admin, username="ck_none", permissions=NO_CAMERA_PERMISSIONS)
    file_id = await _library_file(db_session, user_id, "ck_none")

    response = await async_client.get(f"/api/v1/library/files/{file_id}/thumbnail")
    assert response.status_code == 401


async def test_logout_removes_the_cookie(async_client: AsyncClient, db_session):
    admin = await _admin_token(async_client, "_ck_out")
    jwt, user_id = await _make_user(async_client, admin, username="ck_out", permissions=NO_CAMERA_PERMISSIONS)
    file_id = await _library_file(db_session, user_id, "ck_out")
    await _mint_media_token(async_client, jwt)

    await async_client.post("/api/v1/auth/logout", headers={"Authorization": f"Bearer {jwt}"})
    assert async_client.cookies.get(MEDIA_COOKIE_NAME) is None

    response = await async_client.get(f"/api/v1/library/files/{file_id}/thumbnail")
    assert response.status_code == 401
