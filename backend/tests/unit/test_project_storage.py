"""Projects space: folder naming and path guards (spec §2.1, §2.2)."""

import pytest

from backend.app.services import project_storage
from backend.app.services.project_storage import (
    ensure_project_dir,
    resolve_in_projects,
    sanitize_component,
    slugify,
    storage_dir_name,
)
from backend.app.utils.safe_path import PathTraversalError


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)
    return tmp_path


def test_slugify_strips_accents_and_punctuation():
    assert slugify("Support caméra FX3 !") == "support-camera-fx3"


def test_slugify_falls_back_when_nothing_is_left():
    assert slugify("日本語") == "projet"
    assert slugify("   ") == "projet"


def test_slugify_caps_length_without_trailing_dash():
    slug = slugify("a" * 39 + " bcd")
    assert len(slug) <= 40
    assert not slug.endswith("-")


def test_storage_dir_name_uses_code_and_slug():
    assert storage_dir_name("P-0042", "Support caméra FX3") == "P-0042_support-camera-fx3"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Mesh brut", "Mesh brut"),
        ("../../etc", "etc"),
        ("a/b\\c", "abc"),
        ("CON", "_CON"),
        ("nul.txt", "_nul.txt"),
        ("..", "sans-nom"),
        ("", "sans-nom"),
        ("x" * 150, "x" * 100),
        ("tab\there", "tabhere"),
    ],
)
def test_sanitize_component(raw, expected):
    assert sanitize_component(raw) == expected


def test_resolve_in_projects_accepts_children(root):
    assert resolve_in_projects("P-0001_x", "Scan") == (root / "P-0001_x" / "Scan").resolve()


@pytest.mark.parametrize("parts", [("..",), ("P-0001_x", "..", ".."), ("/etc",), ("a\x00b",)])
def test_resolve_in_projects_rejects_escapes(root, parts):
    with pytest.raises(PathTraversalError):
        resolve_in_projects(*parts)


class _FakeProject:
    def __init__(self, code, name, storage_dir=None, id=7):
        self.code, self.name, self.storage_dir, self.id = code, name, storage_dir, id


def test_ensure_project_dir_assigns_and_creates(root):
    project = _FakeProject("P-0007", "Pièce auto")
    path = ensure_project_dir(project)
    assert project.storage_dir == "P-0007_piece-auto"
    assert path.is_dir()
    assert path == (root / "P-0007_piece-auto").resolve()


def test_ensure_project_dir_keeps_existing_name_after_rename(root):
    project = _FakeProject("P-0007", "Nouveau titre", storage_dir="P-0007_ancien-titre")
    assert ensure_project_dir(project).name == "P-0007_ancien-titre"


def test_projects_root_is_created_under_the_data_dir(tmp_path, monkeypatch):
    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    expected = tmp_path / project_storage.PROJECTS_DIRNAME
    assert not expected.exists()
    assert project_storage.projects_root() == expected
    assert expected.is_dir()
    assert project_storage.projects_root() == expected  # idempotent once it exists
