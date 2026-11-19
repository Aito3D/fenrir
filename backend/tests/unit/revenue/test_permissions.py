import pytest

from backend.app.api.routes.groups import _permission_label
from backend.app.core.auth import _APIKEY_DENIED_PERMISSIONS
from backend.app.core.permissions import ALL_PERMISSIONS, DEFAULT_GROUPS, PERMISSION_CATEGORIES, Permission

REVENUE = [
    "REVENUE_READ",
    "REVENUE_EXPORT",
    "REVENUE_MANAGE_SCOPE",
    "REVENUE_MANAGE_TARGETS",
    "REVENUE_MANAGE_NOTES",
    "REVENUE_SYNC",
    "REVENUE_VIEW_CUSTOMERS",
    "REVENUE_VIEW_MARGIN",
]


def _perms():
    return [getattr(Permission, name) for name in REVENUE]


def test_eight_revenue_permissions_have_spec_values():
    assert [p.value for p in _perms()] == [
        "revenue:read",
        "revenue:export",
        "revenue:manage_scope",
        "revenue:manage_targets",
        "revenue:manage_notes",
        "revenue:sync",
        "revenue:view_customers",
        "revenue:view_margin",
    ]


@pytest.mark.parametrize("name", REVENUE)
def test_revenue_permission_registered_and_restricted(name):
    perm = getattr(Permission, name)
    assert perm in ALL_PERMISSIONS
    assert perm in PERMISSION_CATEGORIES["Revenue"]
    assert perm in _APIKEY_DENIED_PERMISSIONS
    for group in ("Operators", "Viewers"):
        assert perm.value not in DEFAULT_GROUPS[group]["permissions"]


def test_revenue_sync_label():
    assert _permission_label(Permission.REVENUE_SYNC) == "Sync revenue from Zoho"
