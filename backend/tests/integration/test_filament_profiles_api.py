"""Integration tests for /api/v1/filament-profiles CRUD."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession


async def _setup_admin(async_client: AsyncClient, username: str = "fpadmin") -> str:
    """Enable auth + return an admin bearer token. Same pattern used across the suite."""
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": username, "admin_password": "AdminPass1!"},
    )
    login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": "AdminPass1!"},
    )
    return login.json()["access_token"]


async def _create_user_with_perms(
    async_client: AsyncClient,
    admin_token: str,
    *,
    username: str,
    permissions: list[str],
) -> str:
    """Create a non-admin user in a custom group carrying exactly *permissions*.

    Mirrors ``_create_operator_with_perms`` in
    ``test_users_groups_privilege_escalation.py`` — a user gets ONLY the
    listed permission strings, nothing implied by a built-in group.
    """
    headers = {"Authorization": f"Bearer {admin_token}"}
    grp_resp = await async_client.post(
        "/api/v1/groups/",
        headers=headers,
        json={"name": f"fp_test_{username}", "permissions": permissions},
    )
    assert grp_resp.status_code == 201, grp_resp.text
    gid = grp_resp.json()["id"]

    user_resp = await async_client.post(
        "/api/v1/users/",
        headers=headers,
        json={"username": username, "password": "UserPass1!", "role": "user", "group_ids": [gid]},
    )
    assert user_resp.status_code == 201, user_resp.text

    login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": "UserPass1!"},
    )
    assert login.status_code == 200
    return login.json()["access_token"]


def preset_payload(**kw):
    base = {
        "name": "SUNLU PETG - Magenta",
        "brand": "SUNLU",
        "material": "PETG",
        "color": "Magenta",
        "color_hex": "#ff00ff",
        "filename": "SUNLU PETG - Magenta.json",
        "content": "{}",
    }
    base.update(kw)
    return base


class TestFilamentProfilesCrud:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_and_list_sorted(self, async_client: AsyncClient):
        await async_client.post("/api/v1/filament-profiles", json=preset_payload(name="Zeta"))
        await async_client.post("/api/v1/filament-profiles", json=preset_payload(name="Alpha"))
        r = await async_client.get("/api/v1/filament-profiles")
        assert r.status_code == 200
        names = [p["name"] for p in r.json()]
        assert names == sorted(names) and "Alpha" in names

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_defaults_absent_fields_to_empty(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/filament-profiles", json={"name": "Only Name"})
        assert r.status_code == 200
        body = r.json()
        assert body["brand"] == "" and body["content"] == "" and body["id"] > 0
        assert body["created_at"] is not None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_is_partial_and_touches_updated_at(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"brand": "eSUN"})
        assert r.status_code == 200
        body = r.json()
        assert body["brand"] == "eSUN" and body["name"] == created["name"]
        assert body["updated_at"] >= created["updated_at"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_missing_404(self, async_client: AsyncClient):
        assert (await async_client.patch("/api/v1/filament-profiles/99999", json={"name": "x"})).status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_omitted_expected_updated_at_is_unconditional(self, async_client: AsyncClient):
        """T-045: no `expected_updated_at` at all pins the pre-T-045 (legacy) behavior."""
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"brand": "eSUN"})
        assert r.status_code == 200
        assert r.json()["brand"] == "eSUN"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_current_expected_updated_at_succeeds(self, async_client: AsyncClient):
        """A real round trip: the `updated_at` the client actually received back is accepted as-is."""
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(
            f"/api/v1/filament-profiles/{created['id']}",
            json={"brand": "eSUN", "expected_updated_at": created["updated_at"]},
        )
        assert r.status_code == 200
        assert r.json()["brand"] == "eSUN"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_stale_expected_updated_at_409_leaves_row_untouched(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        # Land a concurrent write (e.g. a Zoho price sync) that bumps updated_at.
        mid = (
            await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"brand": "PolyLite"})
        ).json()
        assert mid["updated_at"] >= created["updated_at"]

        r = await async_client.patch(
            f"/api/v1/filament-profiles/{created['id']}",
            json={"brand": "eSUN", "expected_updated_at": created["updated_at"]},
        )
        assert r.status_code == 409

        current = (await async_client.get("/api/v1/filament-profiles")).json()
        row = next(p for p in current if p["id"] == created["id"])
        assert row["brand"] == "PolyLite"
        assert row["updated_at"] == mid["updated_at"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_expected_updated_at_never_stored(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(
            f"/api/v1/filament-profiles/{created['id']}",
            json={"brand": "eSUN", "expected_updated_at": created["updated_at"]},
        )
        assert r.status_code == 200
        assert "expected_updated_at" not in r.json()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_idempotent(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        assert (await async_client.delete(f"/api/v1/filament-profiles/{created['id']}")).json() == {"success": True}
        assert (await async_client.delete(f"/api/v1/filament-profiles/{created['id']}")).json() == {"success": True}

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_appends_copie(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.post(f"/api/v1/filament-profiles/{created['id']}/duplicate")
        assert r.status_code == 200
        dup = r.json()
        assert dup["name"] == created["name"] + " (copie)" and dup["id"] != created["id"]
        assert dup["content"] == created["content"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_missing_404(self, async_client: AsyncClient):
        assert (await async_client.post("/api/v1/filament-profiles/99999/duplicate")).status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_normalises_legacy_path_shaped_filename(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        # T-030: insert a legacy row directly (bypassing the create/update
        # validator, like a row stored before it shipped) with a path-shaped
        # filename, then duplicate it through the API.
        from backend.app.models.filament_profile import FilamentPreset

        legacy = FilamentPreset(**preset_payload(filename="../../evil.json"))
        db_session.add(legacy)
        await db_session.commit()
        await db_session.refresh(legacy)

        r = await async_client.post(f"/api/v1/filament-profiles/{legacy.id}/duplicate")
        assert r.status_code == 200
        dup = r.json()
        assert dup["filename"] == "evil.json"
        assert dup["name"] == legacy.name + " (copie)"
        # The source row itself is untouched.
        again = await async_client.get("/api/v1/filament-profiles")
        source_row = next(p for p in again.json() if p["id"] == legacy.id)
        assert source_row["filename"] == "../../evil.json"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_falls_back_to_preset_id_name_when_nothing_survives(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        from backend.app.models.filament_profile import FilamentPreset

        legacy = FilamentPreset(**preset_payload(filename="../.."))
        db_session.add(legacy)
        await db_session.commit()
        await db_session.refresh(legacy)

        r = await async_client.post(f"/api/v1/filament-profiles/{legacy.id}/duplicate")
        assert r.status_code == 200
        assert r.json()["filename"] == f"preset-{legacy.id}.json"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_bare_filename_copied_unchanged(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.post(f"/api/v1/filament-profiles/{created['id']}/duplicate")
        assert r.status_code == 200
        assert r.json()["filename"] == created["filename"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        "bad_filename",
        # T-046: "foo.sh", ".env" and ".DS_Store" are non-.json filenames that
        # apply_sync would write to disk and never see again (read_disk_state
        # only globs "*.json"); ".json" itself is a bare suffix with no stem.
        ["a/b.json", "a\\b.json", "../b.json", "", "foo.sh", ".env", ".DS_Store", ".json", ".JSON"],
    )
    async def test_create_rejects_non_bare_filename(self, async_client: AsyncClient, bad_filename):
        r = await async_client.post("/api/v1/filament-profiles", json=preset_payload(filename=bad_filename))
        assert r.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        "bad_filename",
        ["a/b.json", "a\\b.json", "../b.json", "", "foo.sh", ".env", ".DS_Store", ".json", ".JSON"],
    )
    async def test_patch_rejects_non_bare_filename(self, async_client: AsyncClient, bad_filename):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"filename": bad_filename})
        assert r.status_code == 422
        # Rejected patch must not have touched the stored row.
        again = await async_client.get("/api/v1/filament-profiles")
        row = next(p for p in again.json() if p["id"] == created["id"])
        assert row["filename"] == created["filename"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_accepts_json_suffix_case_insensitively(self, async_client: AsyncClient):
        # T-046: the suffix check mirrors read_disk_state's own glob, which is
        # case-insensitive on the filesystems Bambu Studio runs on -- an
        # upper-cased suffix must still be accepted, not just lower-case.
        r = await async_client.post("/api/v1/filament-profiles", json=preset_payload(filename="X.JSON"))
        assert r.status_code == 200
        assert r.json()["filename"] == "X.JSON"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_duplicate_normalises_legacy_non_json_filename(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        # T-046: a legacy row stored before the .json suffix was required
        # (e.g. "foo.sh") must come out of duplication with a name that
        # complies -- otherwise the very next save of the duplicate would
        # 422 against the validator this same helper feeds.
        from backend.app.models.filament_profile import FilamentPreset

        legacy = FilamentPreset(**preset_payload(filename="foo.sh"))
        db_session.add(legacy)
        await db_session.commit()
        await db_session.refresh(legacy)

        r = await async_client.post(f"/api/v1/filament-profiles/{legacy.id}/duplicate")
        assert r.status_code == 200
        assert r.json()["filename"] == "foo.json"
        # The source row itself is untouched.
        again = await async_client.get("/api/v1/filament-profiles")
        source_row = next(p for p in again.json() if p["id"] == legacy.id)
        assert source_row["filename"] == "foo.sh"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_accepts_content_at_cap(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/filament-profiles", json=preset_payload(content="x" * 262_144))
        assert r.status_code == 200
        assert len(r.json()["content"]) == 262_144

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_rejects_content_over_cap(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/filament-profiles", json=preset_payload(content="x" * 262_145))
        assert r.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_rejects_content_over_cap(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"content": "x" * 262_145})
        assert r.status_code == 422
        # Rejected patch must not have touched the stored row.
        again = await async_client.get("/api/v1/filament-profiles")
        row = next(p for p in again.json() if p["id"] == created["id"])
        assert row["content"] == created["content"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_accepts_name_at_cap(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/filament-profiles", json=preset_payload(name="n" * 200))
        assert r.status_code == 200
        assert len(r.json()["name"]) == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_rejects_name_over_cap(self, async_client: AsyncClient):
        r = await async_client.post("/api/v1/filament-profiles", json=preset_payload(name="n" * 201))
        assert r.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_rejects_name_over_cap(self, async_client: AsyncClient):
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"name": "n" * 201})
        assert r.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_patch_explicit_null_filename_bypasses_bare_check(self, async_client: AsyncClient):
        # An explicit null is not a path-shaped filename to reject up front — the
        # existing "value if value is not None else \"\"" write path already turns
        # it into "", same as any other explicitly-nulled field.
        created = (await async_client.post("/api/v1/filament-profiles", json=preset_payload())).json()
        r = await async_client.patch(f"/api/v1/filament-profiles/{created['id']}", json={"filename": None})
        assert r.status_code == 200
        assert r.json()["filename"] == ""


class TestFilamentProfilesFilesystem:
    @pytest.fixture
    def bambu_dirs(self, tmp_path):
        from backend.app.core.config import settings

        a, b = tmp_path / "A" / "filament", tmp_path / "B" / "filament"
        bundle = tmp_path / "bundle"
        for d in (a, b, bundle):
            d.mkdir(parents=True)
        old = (settings.bambu_studio_user_dirs, settings.bambu_studio_bundle_dir)
        settings.bambu_studio_user_dirs = [str(a), str(b)]
        settings.bambu_studio_bundle_dir = str(bundle)
        yield a, b, bundle
        settings.bambu_studio_user_dirs, settings.bambu_studio_bundle_dir = old

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_scan_lists_files(self, async_client, bambu_dirs):
        a, _, _ = bambu_dirs
        (a / "one.json").write_text('{"name": "one"}')
        r = await async_client.get("/api/v1/filament-profiles/bambu-scan")
        assert r.status_code == 200
        assert r.json()["files"] == [{"filename": "one.json", "content": '{"name": "one"}'}]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_base_content_traversal_guard(self, async_client, bambu_dirs):
        _, _, bundle = bambu_dirs
        (bundle / "ok.json").write_text("OK")
        assert (
            await async_client.get("/api/v1/filament-profiles/base-content", params={"filename": "ok.json"})
        ).json() == {"content": "OK"}
        for bad in ["", "../secret", "a/b.json", "a\\b.json"]:
            r = await async_client.get("/api/v1/filament-profiles/base-content", params={"filename": bad})
            assert r.status_code == 400, bad
        assert (
            await async_client.get("/api/v1/filament-profiles/base-content", params={"filename": "missing.json"})
        ).status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_sync_base_diffs(self, async_client, bambu_dirs):
        import json as _json

        _, _, bundle = bambu_dirs
        (bundle / "p1.json").write_text(
            _json.dumps({"name": "P1", "filament_vendor": ["Bambu Lab"], "filament_type": ["PLA"]})
        )
        r1 = (await async_client.post("/api/v1/filament-profiles/sync-base")).json()
        assert r1 == {"added": 1, "updated": 0, "unchanged": 0, "total": 1}
        r2 = (await async_client.post("/api/v1/filament-profiles/sync-base")).json()
        assert r2 == {"added": 0, "updated": 0, "unchanged": 1, "total": 1}
        (bundle / "p1.json").write_text(
            _json.dumps({"name": "P1", "inherits": "Root", "filament_vendor": ["Bambu Lab"], "filament_type": ["PLA"]})
        )
        (bundle / "root.json").write_text(_json.dumps({"name": "Root"}))
        r3 = (await async_client.post("/api/v1/filament-profiles/sync-base")).json()
        assert r3 == {"added": 1, "updated": 1, "unchanged": 0, "total": 2}
        presets = (await async_client.get("/api/v1/filament-profiles/base-presets")).json()
        assert [p["name"] for p in presets] == ["P1", "Root"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_dry_run_and_execute(self, async_client, bambu_dirs):
        a, b, _ = bambu_dirs
        (a / "keep.json").write_text("K")
        (b / "keep.json").write_text("K")
        (a / "gone.json").write_text("bye")
        payload = {
            "presets": [{"filename": "keep.json", "content": "K"}, {"filename": "new.json", "content": "N"}],
            "dry_run": True,
        }
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", json=payload)
        assert r.json() == {"stats": {"added": 1, "updated": 0, "removed": 1, "unchanged": 1}}
        assert (a / "gone.json").exists() and not (a / "new.json").exists()  # dry run wrote nothing
        payload["dry_run"] = False
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", json=payload)
        assert r.json()["stats"]["removed"] == 1
        assert not (a / "gone.json").exists() and (b / "new.json").read_text() == "N"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_missing_presets_key_deletes_nothing(self, async_client, bambu_dirs):
        a, _, _ = bambu_dirs
        (a / "precious.json").write_text("P")
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", json={"dry_run": False})
        assert r.status_code == 422  # spec §9.1: omitted key must error, never default to []
        assert (a / "precious.json").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_element_validation(self, async_client, bambu_dirs):
        cases = [
            ([None], "presets[0]: entry must be an object"),
            (["str"], "presets[0]: entry must be an object"),
            ([{"content": "x"}], "presets[0]: filename must be a string"),
            ([{"filename": "a.json"}], "presets[0]: content must be a string"),
            (
                [{"filename": "a.json", "content": "x"}, {"filename": "../b", "content": "x"}],
                "presets[1]: filename must be a bare file name",
            ),
            ([{"filename": "", "content": "x"}], "presets[0]: filename must be a bare file name"),
            ([{"filename": "a/b.json", "content": "x"}], "presets[0]: filename must be a bare file name"),
            # T-046: a non-.json filename is invisible to read_disk_state's
            # glob("*.json") and would be orphaned on disk forever.
            ([{"filename": "foo.sh", "content": "x"}], "presets[0]: filename must be a bare file name"),
        ]
        for presets, msg in cases:
            r = await async_client.post(
                "/api/v1/filament-profiles/bambu-sync", json={"presets": presets, "dry_run": True}
            )
            assert r.status_code == 400 and r.json()["detail"] == msg

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_rejects_stray_camelcase_field(self, async_client, bambu_dirs):
        # A stray camelCase "dryRun" (the JS-native spelling) must 422 rather
        # than being silently ignored and falling through to the field's
        # `dry_run = False` default — which would run the destructive sync
        # path the caller most likely meant to skip.
        a, _, _ = bambu_dirs
        (a / "precious.json").write_text("P")
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", json={"presets": [], "dryRun": True})
        assert r.status_code == 422
        assert (a / "precious.json").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_non_dry_run_requires_delete_permission(self, async_client, bambu_dirs):
        # T-026: the non-dry-run branch unlinks on-disk presets not in the
        # incoming list, so it needs filaments:delete on top of the route's
        # filaments:update gate. A caller holding only filaments:update must
        # be refused with a 403 instead of having their preset folder mirrored.
        a, _, _ = bambu_dirs
        (a / "precious.json").write_text("P")
        admin_token = await _setup_admin(async_client)
        update_only_token = await _create_user_with_perms(
            async_client, admin_token, username="fp_update_only", permissions=["filaments:update"]
        )
        headers = {"Authorization": f"Bearer {update_only_token}"}
        payload = {"presets": [{"filename": "new.json", "content": "N"}], "dry_run": False}
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", headers=headers, json=payload)
        assert r.status_code == 403
        assert "filaments:delete" in r.json()["detail"]
        # Refused, not partially applied: nothing on disk was touched.
        assert (a / "precious.json").exists()
        assert not (a / "new.json").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_non_dry_run_with_delete_permission_still_works(self, async_client, bambu_dirs):
        a, _, _ = bambu_dirs
        (a / "precious.json").write_text("P")
        admin_token = await _setup_admin(async_client, username="fpadmin2")
        full_token = await _create_user_with_perms(
            async_client,
            admin_token,
            username="fp_update_delete",
            permissions=["filaments:update", "filaments:delete"],
        )
        headers = {"Authorization": f"Bearer {full_token}"}
        payload = {"presets": [{"filename": "new.json", "content": "N"}], "dry_run": False}
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", headers=headers, json=payload)
        assert r.status_code == 200
        assert r.json()["stats"]["removed"] == 1
        assert not (a / "precious.json").exists()
        assert (a / "new.json").read_text() == "N"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_non_dry_run_empty_presets_rejected(self, async_client, bambu_dirs):
        # An empty presets list with dry_run=false would otherwise wipe every
        # on-disk preset in every configured directory (apply_sync removes
        # anything not incoming). It must be rejected outright, not treated
        # as "sync to nothing."
        a, _, _ = bambu_dirs
        (a / "precious.json").write_text("P")
        r = await async_client.post("/api/v1/filament-profiles/bambu-sync", json={"presets": [], "dry_run": False})
        assert r.status_code == 400
        assert (a / "precious.json").exists()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bambu_sync_dry_run_empty_presets_still_allowed(self, async_client, bambu_dirs):
        # Dry-run with an empty list touches no files — it only reports what
        # a real sync *would* remove — so it stays allowed even for a caller
        # holding only filaments:update, and even though the equivalent
        # non-dry-run call above is rejected.
        a, _, _ = bambu_dirs
        (a / "precious.json").write_text("P")
        admin_token = await _setup_admin(async_client, username="fpadmin3")
        update_only_token = await _create_user_with_perms(
            async_client, admin_token, username="fp_update_only_dry", permissions=["filaments:update"]
        )
        headers = {"Authorization": f"Bearer {update_only_token}"}
        r = await async_client.post(
            "/api/v1/filament-profiles/bambu-sync",
            headers=headers,
            json={"presets": [], "dry_run": True},
        )
        assert r.status_code == 200
        assert r.json()["stats"]["removed"] == 1
        assert (a / "precious.json").exists()  # dry run wrote nothing


class TestFilamentProfilesZohoSyncPermissions:
    """T-027: /zoho-sync reaches the same Zoho catalogue the calculator's own
    zoho routes gate on calculator:update, so this route requires BOTH
    filaments:update and calculator:update — not filaments:update alone.
    """

    @staticmethod
    def _stub_zoho(monkeypatch):
        from backend.app.services import zoho_filaments
        from backend.app.services.zoho import zoho_service
        from backend.app.services.zoho_filaments import FilamentProduct

        # T-048: the route now refuses (502) on an empty catalogue, so a stub
        # for these permission-gate tests must return a non-empty one — there
        # are no seeded presets in this class, so nothing here is ever
        # matched against it; it only needs to be non-empty to clear the
        # route's new guard and let the 200 test observe the permission gate
        # passing rather than the unrelated empty-catalogue refusal.
        async def fetch_catalogue(_db):
            return [
                FilamentProduct(
                    item_id="stub",
                    name="Stub - PLA - White - 1.75mm - 1kg",
                    sku="STUB",
                    brand="Stub",
                    material="PLA",
                    colour="White",
                    spool_weight_kg=1.0,
                    weight_inferred=False,
                    dealer_price=10.0,
                    cost_per_kg=10.0,
                    has_price=True,
                )
            ]

        async def is_configured(_db):
            return True

        monkeypatch.setattr(zoho_filaments, "fetch_catalogue", fetch_catalogue)
        monkeypatch.setattr(zoho_service, "is_configured", is_configured)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_zoho_sync_requires_calculator_update_on_top_of_filaments_update(self, async_client, monkeypatch):
        self._stub_zoho(monkeypatch)
        admin_token = await _setup_admin(async_client, username="fpadmin_zoho1")
        update_only_token = await _create_user_with_perms(
            async_client, admin_token, username="fp_zoho_update_only", permissions=["filaments:update"]
        )
        headers = {"Authorization": f"Bearer {update_only_token}"}
        r = await async_client.post("/api/v1/filament-profiles/zoho-sync", headers=headers)
        assert r.status_code == 403
        assert "calculator:update" in r.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_zoho_sync_requires_filaments_update_on_top_of_calculator_update(self, async_client, monkeypatch):
        self._stub_zoho(monkeypatch)
        admin_token = await _setup_admin(async_client, username="fpadmin_zoho3")
        update_only_token = await _create_user_with_perms(
            async_client, admin_token, username="fp_zoho_calc_only", permissions=["calculator:update"]
        )
        headers = {"Authorization": f"Bearer {update_only_token}"}
        r = await async_client.post("/api/v1/filament-profiles/zoho-sync", headers=headers)
        assert r.status_code == 403
        assert "filaments:update" in r.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_zoho_sync_works_with_both_permissions(self, async_client, monkeypatch):
        self._stub_zoho(monkeypatch)
        admin_token = await _setup_admin(async_client, username="fpadmin_zoho2")
        both_token = await _create_user_with_perms(
            async_client,
            admin_token,
            username="fp_zoho_both",
            permissions=["filaments:update", "calculator:update"],
        )
        headers = {"Authorization": f"Bearer {both_token}"}
        r = await async_client.post("/api/v1/filament-profiles/zoho-sync", headers=headers)
        assert r.status_code == 200


class TestBaseUpload:
    """POST /filament-profiles/base-upload — browser-side fallback for deploys
    where the backend host has no Bambu Studio install (#sync-base upload)."""

    @pytest.fixture
    def data_dir_fallback(self, tmp_path, monkeypatch):
        from backend.app.core.config import settings
        from backend.app.services import bambu_studio

        # No configured override, and the default app-bundle path is absent —
        # the exact remote-deploy situation. The bundle dir must fall back to
        # <data_dir>/base_presets.
        monkeypatch.setattr(settings, "bambu_studio_bundle_dir", None)
        monkeypatch.setattr(bambu_studio, "DEFAULT_BUNDLE_DIR", str(tmp_path / "no-such-app"))
        monkeypatch.setattr(settings, "base_dir", tmp_path)
        return tmp_path

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_upload_writes_syncs_and_serves_content(self, async_client, data_dir_fallback):
        import json as _json

        files = [
            {
                "filename": "p1.json",
                "content": _json.dumps(
                    {"name": "P1", "inherits": "Root", "filament_vendor": ["Bambu Lab"], "filament_type": ["PLA"]}
                ),
            },
            {"filename": "root.json", "content": _json.dumps({"name": "Root"})},
        ]
        r = await async_client.post("/api/v1/filament-profiles/base-upload", json={"files": files})
        assert r.status_code == 200
        assert r.json() == {"added": 2, "updated": 0, "unchanged": 0, "total": 2}

        # Files persisted into the data-dir fallback…
        assert (data_dir_fallback / "base_presets" / "p1.json").is_file()
        # …the index is queryable…
        presets = (await async_client.get("/api/v1/filament-profiles/base-presets")).json()
        assert [p["name"] for p in presets] == ["P1", "Root"]
        # …and base-content serves the uploaded bytes.
        r = await async_client.get("/api/v1/filament-profiles/base-content", params={"filename": "root.json"})
        assert r.json() == {"content": _json.dumps({"name": "Root"})}

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_upload_is_idempotent_like_sync_base(self, async_client, data_dir_fallback):
        files = [{"filename": "p1.json", "content": '{"name": "P1"}'}]
        first = (await async_client.post("/api/v1/filament-profiles/base-upload", json={"files": files})).json()
        assert first == {"added": 1, "updated": 0, "unchanged": 0, "total": 1}
        second = (await async_client.post("/api/v1/filament-profiles/base-upload", json={"files": files})).json()
        assert second == {"added": 0, "updated": 0, "unchanged": 1, "total": 1}

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_upload_rejects_bad_filenames(self, async_client, data_dir_fallback):
        for bad in ["../evil.json", "a/b.json", "a\\b.json", "", "notjson.txt"]:
            r = await async_client.post(
                "/api/v1/filament-profiles/base-upload",
                json={"files": [{"filename": bad, "content": "{}"}]},
            )
            assert r.status_code == 400, bad
        # Nothing was written for any rejected batch.
        assert not (data_dir_fallback / "base_presets").exists()
