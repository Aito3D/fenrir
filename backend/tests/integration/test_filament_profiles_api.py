"""Integration tests for /api/v1/filament-profiles CRUD."""

import pytest
from httpx import AsyncClient


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
