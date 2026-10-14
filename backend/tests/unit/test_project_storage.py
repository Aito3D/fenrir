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
from backend.tests.project_fixtures import projects_root_fixture

root = projects_root_fixture()


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


# --- T-323: path components are capped at the filesystem's 255-byte NAME_MAX -----------------


def _utf8(text: str) -> int:
    return len(text.encode("utf-8"))


@pytest.mark.parametrize(
    "raw",
    [
        "a" * 255,  # ASCII is capped at 100 characters, as before
        "a" * 100,
        "é" * 100,  # 200 bytes
        "漢" * 85,  # exactly 255 bytes
        "Pièce de rechange – 支架 v2",
        "CON." + "é" * 90,
        "ends with dot.",
        "",
    ],
)
def test_sanitize_component_keeps_every_name_that_fit_before(raw):
    """EXISTING FOLDERS MUST STAY RESOLVABLE: a component of at most 255 bytes is unchanged."""
    before = project_storage._sanitize_chars(raw, "sans-nom")
    assert _utf8(before) <= 255
    assert sanitize_component(raw) == before


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("漢" * 150, "漢" * 85),  # 3-byte characters: 85 x 3 = 255
        ("a" + "漢" * 99, "a" + "漢" * 84),  # 253 bytes: a 3-byte character no longer fits
        ("😀" * 100, "😀" * 63),  # 4-byte characters: 63 x 4 = 252
        ("漢" * 84 + "  ." + "漢" * 13, "漢" * 84),  # the cut lands on trailing spaces/dots, which go
        ("CON." + "漢" * 96, "_CON." + "漢" * 83),  # the reserved-name prefix counts too
    ],
)
def test_sanitize_component_caps_multibyte_names_at_255_bytes(raw, expected):
    result = sanitize_component(raw)
    assert result == expected
    assert _utf8(result) <= 255
    assert project_storage._sanitize_chars(raw, "sans-nom").startswith(result)  # a prefix: no broken code point


def test_sanitize_component_counts_a_lone_surrogate_without_raising():
    assert sanitize_component("a\ud800") == "a\ud800"
    assert project_storage._fit_bytes("\ud800" * 100, 255) == "\ud800" * 85


@pytest.mark.parametrize(
    ("stem", "suffix", "ext", "expected"),
    [
        ("stem", " (2)", ".3mf", "stem (2).3mf"),
        ("s" * 200, " (12)", ".gcode.3mf", "s" * 85 + " (12).gcode.3mf"),
        ("é" * 200, "", ".3mf", "é" * 96 + ".3mf"),  # 196 bytes: only the character cap applies
        ("漢" * 150, "", ".3mf", "漢" * 83 + ".3mf"),  # 249 + 4 bytes
        ("漢" * 150, " (2)", ".gcode.3mf", "漢" * 80 + " (2).gcode.3mf"),  # 240 + 14 bytes
        ("😀" * 100, " (10)", ".bgcode", "😀" * 60 + " (10).bgcode"),  # 240 + 12 bytes
        ("", " (2)", ".3mf", "f (2).3mf"),
    ],
)
def test_fit_name_keeps_suffix_and_extension_within_255_bytes(stem, suffix, ext, expected):
    result = project_storage._fit_name(stem, suffix, ext)
    assert result == expected
    assert _utf8(result) <= 255
    assert result.endswith(f"{suffix}{ext}")


def test_fit_name_falls_back_when_not_even_one_character_fits(monkeypatch):
    monkeypatch.setattr(project_storage, "MAX_COMPONENT_BYTES", 10)
    assert project_storage._fit_name("漢漢", " (2)", ".3mf") == "f (2).3mf"


def test_claim_unique_file_path_writes_long_multibyte_names(root):
    """The 300-byte name that used to raise ENAMETOOLONG on ext4 is claimed, and so is its collision."""
    first = project_storage.claim_unique_file_path(root, "漢" * 150 + ".3mf")
    second = project_storage.claim_unique_file_path(root, "漢" * 150 + ".3mf")
    assert first.name == "漢" * 83 + ".3mf"
    assert second.name == "漢" * 82 + " (2).3mf"
    assert first.is_file() and second.is_file()
    assert all(_utf8(p.name) <= 255 for p in (first, second))


def test_revision_dir_and_trash_of_a_255_byte_item(root):
    project = _FakeProject("P-0008", "Pièce")
    name = "漢" * 150
    folder = project_storage.revision_dir(project, "impression", name, 1)
    assert folder.parent.name == "漢" * 85
    assert folder.is_dir()
    assert project_storage.item_dir(project, "impression", name) == folder.parent

    trashed = project_storage.move_to_trash(project, folder.parent)
    assert trashed is not None and trashed.is_dir()
    assert _utf8(trashed.name) <= 255
    assert trashed.parent.name == "Impression"
    assert (trashed / "R1").is_dir()


def test_item_dir_keeps_using_a_folder_made_under_the_character_cap(root, monkeypatch):
    """A folder named before the byte cap (APFS accepts over-255-byte names) stays the item's
    folder, so its files are not left behind. The cap is lowered so any filesystem can hold it."""
    monkeypatch.setattr(project_storage, "MAX_COMPONENT_BYTES", 20)
    project = _FakeProject("P-0009", "Pièce")
    name = "漢" * 10  # 30 bytes; the capped component is 漢 x 6 (18 bytes)

    assert project_storage.item_dir(project, "impression", name).name == "漢" * 6  # no legacy folder yet

    legacy = ensure_project_dir(project) / "Impression" / ("漢" * 10)
    legacy.mkdir(parents=True)
    assert project_storage.item_dir(project, "impression", name) == legacy.resolve()
    assert project_storage.revision_dir(project, "impression", name, 2) == (legacy / "R2").resolve()
    assert not (legacy.parent / ("漢" * 6)).exists()


def test_item_dir_still_refuses_an_unknown_section(root):
    with pytest.raises(KeyError):
        project_storage.item_dir(_FakeProject("P-0010", "Pièce"), "nope", "漢" * 150)
