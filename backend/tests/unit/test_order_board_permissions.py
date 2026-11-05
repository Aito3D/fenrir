"""The Order Board's two permissions: who holds them by default, on a fresh
install and after an upgrade, and that API keys never do."""

import pytest
from sqlalchemy import select

from backend.app.core import database as _database_module
from backend.app.core.auth import _APIKEY_DENIED_PERMISSIONS
from backend.app.core.database import seed_default_groups
from backend.app.core.permissions import DEFAULT_GROUPS, PERMISSION_CATEGORIES, Permission
from backend.app.models.group import Group
from backend.app.models.settings import Settings

_ORDERS = {"orders:read", "orders:update"}
_FLAG = "_backfill_orders_permissions_done"


def test_operators_and_administrators_hold_both_orders_permissions():
    for group in ("Administrators", "Operators"):
        perms = DEFAULT_GROUPS[group]["permissions"]
        assert "orders:read" in perms and "orders:update" in perms


def test_viewers_hold_neither():
    assert not _ORDERS & set(DEFAULT_GROUPS["Viewers"]["permissions"])


def test_orders_permissions_are_categorised_and_denied_to_api_keys():
    assert PERMISSION_CATEGORIES["Orders"] == [Permission.ORDERS_READ, Permission.ORDERS_UPDATE]
    assert {Permission.ORDERS_READ, Permission.ORDERS_UPDATE} <= _APIKEY_DENIED_PERMISSIONS


async def _strip_orders(*group_names: str) -> None:
    async with _database_module.async_session() as session:
        for name in group_names:
            group = (await session.execute(select(Group).where(Group.name == name))).scalar_one()
            group.permissions = [p for p in group.permissions if p not in _ORDERS]
        await session.commit()


async def _perms() -> dict[str, set[str]]:
    async with _database_module.async_session() as session:
        return {g.name: set(g.permissions or []) for g in (await session.execute(select(Group))).scalars()}


# ``async_client`` is depended upon (unused) so async_session() shares the
# fixture's event loop, as in test_read_permission_backfill_migration.py.
@pytest.mark.asyncio
async def test_upgrade_grants_both_to_operators_and_to_no_other_group(async_client):
    """An install from before the order board: nobody has the permissions and
    the backfill has never run."""
    await seed_default_groups()
    await _strip_orders("Administrators", "Operators")
    async with _database_module.async_session() as session:
        session.add(Group(name="order-board-custom", permissions=["printers:read"], is_system=False))
        flag = (await session.execute(select(Settings).where(Settings.key == _FLAG))).scalar_one_or_none()
        if flag is not None:
            await session.delete(flag)
        await session.commit()

    await seed_default_groups()

    groups = await _perms()
    assert groups["Operators"] >= _ORDERS
    assert groups["Administrators"] >= _ORDERS
    assert not _ORDERS & groups["order-board-custom"]
    assert not _ORDERS & groups["Viewers"]


@pytest.mark.asyncio
async def test_a_revoked_orders_permission_stays_revoked_after_a_restart(async_client):
    """Rows carry customer names and order values: an admin who takes the
    board away from Operators must not get it back on the next start."""
    await seed_default_groups()
    await _strip_orders("Operators")

    await seed_default_groups()

    assert not _ORDERS & (await _perms())["Operators"]
