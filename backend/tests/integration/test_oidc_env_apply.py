"""Upserting the env-managed OIDC provider (#2593).

Startup applies BAMBUDDY_OIDC_* to the database. The row is updated in place,
never delete-recreated: user_oidc_links.provider_id is FK ON DELETE CASCADE, so
recreating the provider would silently unlink every account bound to it.
"""

from __future__ import annotations

import logging

import pytest
from sqlalchemy import select

from backend.app.core.oidc_env import apply_env_oidc_provider
from backend.app.models.oidc_provider import OIDCProvider

REQUIRED = {
    "BAMBUDDY_OIDC_NAME": "Keycloak",
    "BAMBUDDY_OIDC_ISSUER_URL": "https://sso.example.com/realms/main",
    "BAMBUDDY_OIDC_CLIENT_ID": "bambuddy",
    "BAMBUDDY_OIDC_CLIENT_SECRET": "s3cr3t",
}

ALL_VARS = (
    *REQUIRED,
    "BAMBUDDY_OIDC_SCOPES",
    "BAMBUDDY_OIDC_ENABLED",
    "BAMBUDDY_OIDC_AUTO_CREATE_USERS",
    "BAMBUDDY_OIDC_AUTO_LINK_EXISTING",
    "BAMBUDDY_OIDC_EMAIL_CLAIM",
    "BAMBUDDY_OIDC_REQUIRE_EMAIL_VERIFIED",
    "BAMBUDDY_OIDC_ICON_URL",
    "BAMBUDDY_OIDC_AUTOLOGIN",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in ALL_VARS:
        monkeypatch.delenv(key, raising=False)


def _configure(monkeypatch, **overrides):
    for key, value in REQUIRED.items():
        monkeypatch.setenv(key, value)
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)


async def _env_provider(db_session) -> OIDCProvider | None:
    result = await db_session.execute(select(OIDCProvider).where(OIDCProvider.is_env_managed.is_(True)))
    return result.scalar_one_or_none()


@pytest.mark.asyncio
async def test_creates_the_provider_from_env(db_session, monkeypatch):
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)

    provider = await _env_provider(db_session)
    assert provider is not None
    assert provider.name == "Keycloak"
    assert provider.client_id == "bambuddy"
    assert provider.is_env_managed is True
    assert provider.client_secret == "s3cr3t"  # property decrypts


@pytest.mark.asyncio
async def test_a_changed_var_updates_the_same_row(db_session, monkeypatch):
    """The id must survive: user_oidc_links references it with ON DELETE
    CASCADE, so a delete-recreate would unlink every bound account."""
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)
    original_id = (await _env_provider(db_session)).id

    monkeypatch.setenv("BAMBUDDY_OIDC_CLIENT_ID", "rotated")
    await apply_env_oidc_provider(db_session)

    provider = await _env_provider(db_session)
    assert provider.id == original_id
    assert provider.client_id == "rotated"


@pytest.mark.asyncio
async def test_removing_the_env_config_disables_but_keeps_the_row(db_session, monkeypatch):
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)
    original_id = (await _env_provider(db_session)).id

    for key in ALL_VARS:
        monkeypatch.delenv(key, raising=False)
    await apply_env_oidc_provider(db_session)

    # Looked up by name, not by the flag: releasing the provider clears the flag,
    # and the point of this test is that the ROW survives either way.
    result = await db_session.execute(select(OIDCProvider).where(OIDCProvider.name == "Keycloak"))
    provider = result.scalar_one_or_none()
    assert provider is not None, "deleting would cascade away every account link"
    assert provider.id == original_id
    assert provider.is_enabled is False


@pytest.mark.asyncio
async def test_env_autologin_clears_it_on_other_providers(db_session, monkeypatch):
    """Only one provider may be the autologin target; the env one wins."""
    ui_provider = OIDCProvider(
        name="UI provider",
        issuer_url="https://other.example.com",
        client_id="ui",
        is_autologin=True,
    )
    ui_provider.client_secret = "ui-secret"
    db_session.add(ui_provider)
    await db_session.commit()

    _configure(monkeypatch, BAMBUDDY_OIDC_AUTOLOGIN="true")
    await apply_env_oidc_provider(db_session)

    await db_session.refresh(ui_provider)
    assert (await _env_provider(db_session)).is_autologin is True
    assert ui_provider.is_autologin is False


@pytest.mark.asyncio
async def test_a_ui_provider_is_otherwise_left_alone(db_session, monkeypatch):
    ui_provider = OIDCProvider(name="UI provider", issuer_url="https://other.example.com", client_id="ui")
    ui_provider.client_secret = "ui-secret"
    db_session.add(ui_provider)
    await db_session.commit()

    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)

    await db_session.refresh(ui_provider)
    assert ui_provider.is_env_managed is False
    assert ui_provider.is_enabled is True
    assert ui_provider.client_id == "ui"


@pytest.mark.asyncio
async def test_an_unsafe_auto_link_config_is_skipped_not_raised(db_session, monkeypatch):
    """auto-link + unverified email is the SEC-1 account-takeover shape. The
    schema rejects it for the UI, and env config must not be a way around that
    -- but a bad variable must not stop the app from booting either."""
    _configure(
        monkeypatch,
        BAMBUDDY_OIDC_AUTO_LINK_EXISTING="true",
        BAMBUDDY_OIDC_REQUIRE_EMAIL_VERIFIED="false",
    )

    await apply_env_oidc_provider(db_session)

    assert await _env_provider(db_session) is None


@pytest.mark.asyncio
async def test_a_rejected_config_never_logs_the_client_secret(db_session, monkeypatch, caplog):
    """client_secret has max_length=512, so an over-long value raises
    string_too_long. The rejection must be logged without the value: str(exc)
    embeds input_value=..., which would leak the secret (no-secrets-in-logs)."""
    secret = "S3CR3T" * 100  # > 512 chars -> ValidationError on client_secret
    _configure(monkeypatch, BAMBUDDY_OIDC_CLIENT_SECRET=secret)

    with caplog.at_level(logging.ERROR):
        await apply_env_oidc_provider(db_session)

    assert await _env_provider(db_session) is None  # rejected, not booted-through
    assert "rejected" in caplog.text  # the rejection was actually logged
    assert secret not in caplog.text
    assert "S3CR3T" not in caplog.text  # not even a fragment of the value


@pytest.mark.asyncio
async def test_a_non_validation_error_is_survivable_and_leaks_nothing(db_session, monkeypatch, caplog):
    """The generic except branch handles anything that isn't a ValidationError
    (e.g. a library call raising mid-construction). It must not stop boot and,
    since such a message could carry a configured value, must log only the
    exception class -- never str(exc)."""
    # oidc_env imports OIDCProviderCreate inside the function (to avoid an
    # import cycle), so patch it at its source module, not on oidc_env.
    import backend.app.schemas.auth as auth_schemas

    def _raise(**_kwargs):
        raise RuntimeError("boom leaked-secret")

    monkeypatch.setattr(auth_schemas, "OIDCProviderCreate", _raise)
    _configure(monkeypatch, BAMBUDDY_OIDC_CLIENT_SECRET="leaked-secret")

    with caplog.at_level(logging.ERROR):
        await apply_env_oidc_provider(db_session)  # must not raise

    assert await _env_provider(db_session) is None
    assert "could not be applied" in caplog.text
    assert "RuntimeError" in caplog.text  # class is logged...
    assert "leaked-secret" not in caplog.text  # ...but nothing from the message


@pytest.mark.asyncio
async def test_applying_twice_without_changes_is_a_no_op(db_session, monkeypatch):
    """Every boot re-applies; the second run must not create a second row."""
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)
    await apply_env_oidc_provider(db_session)

    result = await db_session.execute(select(OIDCProvider).where(OIDCProvider.is_env_managed.is_(True)))
    assert len(result.scalars().all()) == 1


# --- identity is the name, not the flag ---------------------------------------
# The provider is looked up by BAMBUDDY_OIDC_NAME, which is unique on the table.
# Matching on is_env_managed instead made three things impossible: adopting a
# provider that already carries the name (the insert hit the unique constraint
# and took startup down with it), releasing the provider when the config goes
# away, and finding it again afterwards.


@pytest.mark.asyncio
async def test_a_name_collision_adopts_the_existing_provider(db_session, monkeypatch):
    """An operator who names the env provider after one they created in the UI
    must not end up with an app that refuses to boot."""
    ui_provider = OIDCProvider(name="Keycloak", issuer_url="https://old.example.com", client_id="ui-client")
    ui_provider.client_secret = "ui-secret"
    db_session.add(ui_provider)
    await db_session.commit()
    original_id = ui_provider.id

    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)

    provider = await _env_provider(db_session)
    assert provider is not None
    assert provider.id == original_id, "adopted, not duplicated"
    assert provider.client_id == "bambuddy"

    result = await db_session.execute(select(OIDCProvider).where(OIDCProvider.name == "Keycloak"))
    assert len(result.scalars().all()) == 1


@pytest.mark.asyncio
async def test_removing_the_config_releases_the_provider_to_the_ui(db_session, monkeypatch):
    """Nothing manages it any more, so the API must stop refusing edits and
    deletes -- otherwise the row is a dead end only reachable via the database."""
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)

    for key in ALL_VARS:
        monkeypatch.delenv(key, raising=False)
    await apply_env_oidc_provider(db_session)

    result = await db_session.execute(select(OIDCProvider).where(OIDCProvider.name == "Keycloak"))
    provider = result.scalar_one()
    assert provider.is_enabled is False
    assert provider.is_env_managed is False


@pytest.mark.asyncio
async def test_restoring_the_config_finds_the_same_row_again(db_session, monkeypatch):
    """The account links hang off this row; a second provider would orphan them."""
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)
    original_id = (await _env_provider(db_session)).id

    for key in ALL_VARS:
        monkeypatch.delenv(key, raising=False)
    await apply_env_oidc_provider(db_session)

    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)

    provider = await _env_provider(db_session)
    assert provider.id == original_id
    assert provider.is_enabled is True


@pytest.mark.asyncio
async def test_the_issuer_and_client_can_change_under_the_same_name(db_session, monkeypatch):
    _configure(monkeypatch)
    await apply_env_oidc_provider(db_session)
    original_id = (await _env_provider(db_session)).id

    monkeypatch.setenv("BAMBUDDY_OIDC_ISSUER_URL", "https://sso.example.com/realms/other")
    monkeypatch.setenv("BAMBUDDY_OIDC_CLIENT_ID", "rotated")
    await apply_env_oidc_provider(db_session)

    provider = await _env_provider(db_session)
    assert provider.id == original_id
    assert provider.issuer_url == "https://sso.example.com/realms/other"
    assert provider.client_id == "rotated"
