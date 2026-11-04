"""Pure folder-tree helpers of services/project_catalog.py."""

import pytest

from backend.app.models.project_folder import ProjectFolder
from backend.app.services.project_catalog import (
    FOLDER_NAME_MAX,
    ProjectCatalogError,
    _clean_name,
    ancestor_ids,
    subtree_ids,
)


def _folder(folder_id: int, parent_id: int | None) -> ProjectFolder:
    return ProjectFolder(id=folder_id, name=f"f{folder_id}", parent_id=parent_id)


def test_clean_name_refuses_a_name_over_the_limit():
    with pytest.raises(ProjectCatalogError) as exc:
        _clean_name("x" * (FOLDER_NAME_MAX + 1))
    assert exc.value.status_code == 400
    assert exc.value.detail == f"A folder name is at most {FOLDER_NAME_MAX} characters"


def test_subtree_ids_stops_on_a_cycle():
    folders = [_folder(1, 2), _folder(2, 1), _folder(3, 2)]
    assert subtree_ids(folders, 1) == {1, 2, 3}


def test_ancestor_ids_walks_up_to_the_root_nearest_first():
    folders = [_folder(1, None), _folder(2, 1), _folder(3, 2)]
    assert ancestor_ids(folders, 3) == [3, 2, 1]
    assert ancestor_ids(folders, None) == []
    assert ancestor_ids(folders, 99) == []


def test_ancestor_ids_stops_on_a_cycle():
    folders = [_folder(1, 2), _folder(2, 1)]
    assert ancestor_ids(folders, 1) == [1, 2]
