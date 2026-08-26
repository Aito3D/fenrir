"""Bambu Studio filesystem service tests (all against tmp dirs)."""

import json

import pytest

from backend.app.core.config import settings
from backend.app.services import bambu_studio as svc


@pytest.fixture
def bambu_dirs(tmp_path):
    a, b = tmp_path / "A" / "filament", tmp_path / "B" / "filament"
    bundle = tmp_path / "bundle"
    for d in (a, b, bundle):
        d.mkdir(parents=True)
    old = (settings.bambu_studio_user_dirs, settings.bambu_studio_bundle_dir)
    settings.bambu_studio_user_dirs = [str(a), str(b)]
    settings.bambu_studio_bundle_dir = str(bundle)
    yield a, b, bundle
    settings.bambu_studio_user_dirs, settings.bambu_studio_bundle_dir = old


def test_effective_user_id_falls_back_on_non_digits(monkeypatch):
    monkeypatch.setattr(settings, "bambu_user_id", "../../etc")
    assert svc.effective_bambu_user_id() == svc.DEFAULT_BAMBU_USER_ID
    monkeypatch.setattr(settings, "bambu_user_id", "42")
    assert svc.effective_bambu_user_id() == "42"


def test_scan_first_folder_wins_and_skips_missing(bambu_dirs):
    a, b, _ = bambu_dirs
    (a / "x.json").write_text("A-content")
    (b / "x.json").write_text("B-content")
    (b / "y.json").write_text("only-b")
    files = {f["filename"]: f["content"] for f in svc.scan_user_presets()}
    assert files == {"x.json": "A-content", "y.json": "only-b"}


def test_scan_missing_folder_is_silent(bambu_dirs, tmp_path):
    settings.bambu_studio_user_dirs = [str(tmp_path / "nope"), settings.bambu_studio_user_dirs[0]]
    assert svc.scan_user_presets() == []


def test_scan_skips_invalid_utf8_file(bambu_dirs):
    a, b, _ = bambu_dirs
    (a / "bad.json").write_bytes(b"\xff\xfe{")
    (a / "good.json").write_text("GOOD")
    files = {f["filename"]: f["content"] for f in svc.scan_user_presets()}
    assert files == {"good.json": "GOOD"}


def test_compute_sync_stats(bambu_dirs):
    a, b, _ = bambu_dirs
    (a / "same.json").write_text("S")
    (b / "same.json").write_text("S")
    (a / "diff.json").write_text("old")
    (b / "diff.json").write_text("old")
    (a / "gone.json").write_text("bye")
    (a / "partial.json").write_text("P")  # missing from b -> updated
    presets = [
        {"filename": "same.json", "content": "S"},
        {"filename": "diff.json", "content": "new"},
        {"filename": "partial.json", "content": "P"},
        {"filename": "added.json", "content": "N"},
        {"filename": "skipme.json", "content": ""},  # empty content skipped
    ]
    stats = svc.compute_sync_stats(presets, svc.read_disk_state(), svc.get_user_filament_dirs())
    assert stats == {"added": 1, "updated": 2, "removed": 1, "unchanged": 1}


def test_apply_sync_mirrors_and_removes(bambu_dirs):
    a, b, _ = bambu_dirs
    (a / "gone.json").write_text("bye")
    stats = svc.apply_sync([{"filename": "new.json", "content": "N"}])
    assert stats["added"] == 1 and stats["removed"] == 1
    assert (a / "new.json").read_text() == "N" and (b / "new.json").read_text() == "N"
    assert not (a / "gone.json").exists()


def test_collect_base_presets_closure_and_unparseable(bambu_dirs):
    _, _, bundle = bambu_dirs
    (bundle / "child.json").write_text(
        json.dumps(
            {
                "name": "Child",
                "inherits": "Parent",
                "filament_vendor": ["V"],
                "filament_type": ["PLA"],
                "filament_colour": ["#112233"],
            }
        )
    )
    (bundle / "parent.json").write_text(json.dumps({"name": "Parent", "inherits": "Child"}))  # cycle
    (bundle / "broken.json").write_text("{not json")
    records = {r["filename"]: r for r in svc.collect_base_presets()}
    assert set(records) == {"child.json", "parent.json", "broken.json"}
    assert records["child.json"]["brand"] == "V" and records["child.json"]["material"] == "PLA"
    assert records["broken.json"]["name"] == "broken" and records["broken.json"]["brand"] == ""


def test_read_bundle_preset(bambu_dirs):
    _, _, bundle = bambu_dirs
    (bundle / "p.json").write_text("CONTENT")
    assert svc.read_bundle_preset("p.json") == "CONTENT"
    assert svc.read_bundle_preset("missing.json") is None


class TestBundleDirFallback:
    """get_bundle_filament_dir precedence: override > app bundle > data dir."""

    def test_falls_back_to_data_dir_when_app_bundle_missing(self, tmp_path, monkeypatch):
        from backend.app.core.config import settings
        from backend.app.services import bambu_studio

        monkeypatch.setattr(settings, "bambu_studio_bundle_dir", None)
        monkeypatch.setattr(bambu_studio, "DEFAULT_BUNDLE_DIR", str(tmp_path / "no-such-app"))
        monkeypatch.setattr(settings, "base_dir", tmp_path)
        assert bambu_studio.get_bundle_filament_dir() == tmp_path / "base_presets"

    def test_prefers_existing_app_bundle(self, tmp_path, monkeypatch):
        from backend.app.core.config import settings
        from backend.app.services import bambu_studio

        app_dir = tmp_path / "app-bundle"
        app_dir.mkdir()
        monkeypatch.setattr(settings, "bambu_studio_bundle_dir", None)
        monkeypatch.setattr(bambu_studio, "DEFAULT_BUNDLE_DIR", str(app_dir))
        monkeypatch.setattr(settings, "base_dir", tmp_path)
        assert bambu_studio.get_bundle_filament_dir() == app_dir

    def test_configured_override_wins(self, tmp_path, monkeypatch):
        from backend.app.core.config import settings
        from backend.app.services import bambu_studio

        monkeypatch.setattr(settings, "bambu_studio_bundle_dir", str(tmp_path / "override"))
        assert bambu_studio.get_bundle_filament_dir() == tmp_path / "override"
