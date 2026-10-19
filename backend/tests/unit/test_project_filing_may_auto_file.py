"""T-371: the single projects:update gate for auto-filing uploads by project code."""

from backend.app.core.permissions import Permission
from backend.app.services.project_filing import may_auto_file


class _Actor:
    def __init__(self, granted: set[str]):
        self._granted = granted

    def has_permission(self, permission: str) -> bool:
        return permission in self._granted


def test_no_actor_means_auth_off_and_is_allowed():
    assert may_auto_file(None) is True


def test_actor_with_projects_update_is_allowed():
    assert may_auto_file(_Actor({Permission.PROJECTS_UPDATE.value})) is True


def test_actor_without_projects_update_is_refused():
    assert may_auto_file(_Actor({Permission.PROJECTS_READ.value})) is False
