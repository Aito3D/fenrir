"""The Bambuddy -> Fenrir rename moved every operator-facing env var from
BAMBUDDY_* to FENRIR_*. An install that has not migrated its compose file,
systemd unit or .env must keep the configuration it already has, so these
pin the fallback rather than the spelling of any one variable.
"""

import os

import pytest

from backend.app.core.env_compat import env_get, legacy_name
from backend.app.core.oidc_env import env_bool, read_env_oidc_config

OIDC_REQUIRED = ("NAME", "ISSUER_URL", "CLIENT_ID", "CLIENT_SECRET")


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    """No FENRIR_/BAMBUDDY_ variable leaks in from the developer's shell."""
    for key in list(os.environ):
        if key.startswith(("FENRIR_", "BAMBUDDY_")):
            monkeypatch.delenv(key, raising=False)


class TestLegacyName:
    def test_maps_current_prefix_to_the_old_one(self):
        assert legacy_name("FENRIR_OIDC_CLIENT_ID") == "BAMBUDDY_OIDC_CLIENT_ID"

    def test_unprefixed_key_has_no_legacy_form(self):
        assert legacy_name("DATA_DIR") is None

    def test_legacy_name_is_not_itself_remapped(self):
        assert legacy_name("BAMBUDDY_OIDC_CLIENT_ID") is None


class TestEnvGet:
    def test_current_name_is_read(self, monkeypatch):
        monkeypatch.setenv("FENRIR_EXTERNAL_ROOTS", "/srv/library")
        assert env_get("FENRIR_EXTERNAL_ROOTS") == "/srv/library"

    def test_legacy_name_is_the_fallback(self, monkeypatch):
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", "/srv/library")
        assert env_get("FENRIR_EXTERNAL_ROOTS") == "/srv/library"

    def test_current_name_wins_when_both_are_set(self, monkeypatch):
        monkeypatch.setenv("FENRIR_EXTERNAL_ROOTS", "/srv/new")
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", "/srv/old")
        assert env_get("FENRIR_EXTERNAL_ROOTS") == "/srv/new"

    def test_blank_current_value_falls_through_to_the_legacy_one(self, monkeypatch):
        # Blank is "unset" everywhere else in the config, and a compose file
        # that expands FENRIR_X to nothing must not shadow a working old value.
        monkeypatch.setenv("FENRIR_EXTERNAL_ROOTS", "   ")
        monkeypatch.setenv("BAMBUDDY_EXTERNAL_ROOTS", "/srv/old")
        assert env_get("FENRIR_EXTERNAL_ROOTS") == "/srv/old"

    def test_default_is_returned_when_neither_is_set(self):
        assert env_get("FENRIR_EXTERNAL_ROOTS", "fallback") == "fallback"

    def test_unprefixed_key_behaves_like_os_environ(self, monkeypatch):
        monkeypatch.setenv("DATA_DIR", "/data")
        assert env_get("DATA_DIR") == "/data"
        assert env_get("NOT_SET_ANYWHERE", "d") == "d"


class TestEnvBoolHonoursLegacyNames:
    def test_legacy_boolean_is_read(self, monkeypatch):
        monkeypatch.setenv("BAMBUDDY_LOCAL_LOGIN", "true")
        assert env_bool("FENRIR_LOCAL_LOGIN", False) is True

    def test_current_boolean_overrides_the_legacy_one(self, monkeypatch):
        monkeypatch.setenv("FENRIR_LOCAL_LOGIN", "false")
        monkeypatch.setenv("BAMBUDDY_LOCAL_LOGIN", "true")
        assert env_bool("FENRIR_LOCAL_LOGIN", True) is False


class TestOIDCFromLegacyEnvironment:
    def test_provider_configures_entirely_from_the_old_names(self, monkeypatch):
        monkeypatch.setenv("BAMBUDDY_OIDC_NAME", "Keycloak")
        monkeypatch.setenv("BAMBUDDY_OIDC_ISSUER_URL", "https://sso.example.com/realms/main")
        monkeypatch.setenv("BAMBUDDY_OIDC_CLIENT_ID", "fenrir")
        monkeypatch.setenv("BAMBUDDY_OIDC_CLIENT_SECRET", "s3cret")
        monkeypatch.setenv("BAMBUDDY_OIDC_SCOPES", "openid email")

        config = read_env_oidc_config()

        assert config is not None
        assert config["name"] == "Keycloak"
        assert config["issuer_url"] == "https://sso.example.com/realms/main"
        assert config["client_id"] == "fenrir"
        assert config["client_secret"] == "s3cret"
        assert config["scopes"] == "openid email"

    def test_mixed_spellings_resolve_per_variable(self, monkeypatch):
        for suffix in OIDC_REQUIRED:
            monkeypatch.setenv(f"BAMBUDDY_OIDC_{suffix}", f"old-{suffix.lower()}")
        monkeypatch.setenv("FENRIR_OIDC_CLIENT_ID", "new-client-id")

        config = read_env_oidc_config()

        assert config is not None
        assert config["client_id"] == "new-client-id"
        assert config["name"] == "old-name"

    def test_unset_under_either_spelling_is_still_unconfigured(self):
        assert read_env_oidc_config() is None

    def test_a_missing_required_var_is_not_rescued_by_the_others(self, monkeypatch):
        for suffix in OIDC_REQUIRED:
            if suffix == "CLIENT_SECRET":
                continue
            monkeypatch.setenv(f"BAMBUDDY_OIDC_{suffix}", f"old-{suffix.lower()}")

        assert read_env_oidc_config() is None
