"""Projects space: item/revision folders, filenames, trash (spec §2.2, §2.3)."""

import pytest

from backend.app.services import project_storage
from backend.app.services.project_storage import (
    SECTION_DIRS,
    item_dir,
    move_to_trash,
    revision_dir,
    unique_file_path,
)
from backend.app.utils.safe_path import PathTraversalError


class _P:
    def __init__(self):
        self.id, self.code, self.name, self.storage_dir = 1, "P-0001", "Support", "P-0001_support"


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)
    return tmp_path


def test_section_dirs_are_french_labels():
    assert SECTION_DIRS == {
        "scan": "Scan",
        "modelisation": "Modélisation",
        "impression": "Impression",
        "usinage": "Usinage",
        "docs": "Docs",
    }


def test_revision_dir_layout_and_creation(root):
    path = revision_dir(_P(), "scan", "Mesh brut", 2)
    assert path == (root / "P-0001_support" / "Scan" / "Mesh brut" / "R2").resolve()
    assert path.is_dir()


def test_revision_dir_rejects_traversal_item_names(root):
    path = revision_dir(_P(), "docs", "../../evil", 1)
    assert root.resolve() in path.parents
    assert path.parent.name == "evil"


def test_item_dir_rejects_unknown_section(root):
    with pytest.raises(KeyError):
        item_dir(_P(), "garage", "x")


def test_unique_file_path_suffixes_before_gcode_3mf(root):
    folder = root / "R1"
    folder.mkdir()
    (folder / "support.step").write_bytes(b"x")
    (folder / "plate.gcode.3mf").write_bytes(b"x")
    assert unique_file_path(folder, "support.step").name == "support (2).step"
    assert unique_file_path(folder, "plate.gcode.3mf").name == "plate (2).gcode.3mf"
    assert unique_file_path(folder, "new.stl").name == "new.stl"
    assert unique_file_path(folder, "../../x.stl").parent == folder.resolve()


def test_unique_file_path_counts_up(root):
    folder = root / "R1"
    folder.mkdir()
    for name in ("a.ply", "a (2).ply"):
        (folder / name).write_bytes(b"x")
    assert unique_file_path(folder, "a.ply").name == "a (3).ply"


def test_move_to_trash_keeps_relative_layout(root):
    project = _P()
    rev = revision_dir(project, "scan", "Mesh", 1)
    (rev / "scan.ply").write_bytes(b"x")
    moved = move_to_trash(project, rev)
    assert not rev.exists()
    assert moved is not None and (moved / "scan.ply").exists()
    assert moved.relative_to(root.resolve()).parts[:4] == ("P-0001_support", "_trash", "Scan", "Mesh")
    assert moved.name.startswith("R1-")


def test_move_to_trash_missing_path_is_noop(root):
    assert move_to_trash(_P(), root / "P-0001_support" / "Scan" / "Nope") is None


def test_move_to_trash_refuses_paths_outside_project(root, tmp_path_factory):
    outside = tmp_path_factory.mktemp("outside")
    with pytest.raises(PathTraversalError):
        move_to_trash(_P(), outside)


@pytest.mark.parametrize("ext", [".stl", ".gcode.3mf"])
def test_unique_file_path_long_names_keep_extension(root, ext):
    folder = root / "R1"
    folder.mkdir()
    name = "a" * 300 + ext
    first = unique_file_path(folder, name)
    assert first.name.endswith(ext) and len(first.name) <= 100
    first.write_bytes(b"x")
    second = unique_file_path(folder, name)
    assert second != first
    assert second.name.endswith(f" (2){ext}") and len(second.name) <= 100


def test_move_to_trash_refuses_project_root(root):
    project = _P()
    revision_dir(project, "scan", "Mesh", 1)
    with pytest.raises(PathTraversalError):
        move_to_trash(project, root / "P-0001_support")


def test_move_to_trash_refuses_paths_already_in_trash(root):
    project = _P()
    rev = revision_dir(project, "scan", "Mesh", 1)
    moved = move_to_trash(project, rev)
    with pytest.raises(PathTraversalError):
        move_to_trash(project, moved)


def test_move_to_trash_twice_same_second_gets_distinct_names(root):
    project = _P()
    first = move_to_trash(project, revision_dir(project, "scan", "Mesh", 1))
    second = move_to_trash(project, revision_dir(project, "scan", "Mesh", 1))
    assert first != second and first.exists() and second.exists()


def test_move_to_trash_refuses_symlink_pointing_outside(root, tmp_path_factory):
    project = _P()
    rev = revision_dir(project, "scan", "Mesh", 1)
    outside = tmp_path_factory.mktemp("outside")
    link = rev / "link"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(PathTraversalError):
        move_to_trash(project, link)
    assert outside.exists()


def test_move_to_trash_keeps_a_files_extension(root):
    project = _P()
    folder = revision_dir(project, "scan", "Mesh", 1)
    plate = folder / "plate.gcode.3mf"
    plate.write_bytes(b"x")
    step = folder / "a.step"
    step.write_bytes(b"x")
    moved_plate = move_to_trash(project, plate)
    moved_step = move_to_trash(project, step)
    assert moved_plate.name.startswith("plate-") and moved_plate.name.endswith(".gcode.3mf")
    assert moved_step.name.startswith("a-") and moved_step.name.endswith(".step")
