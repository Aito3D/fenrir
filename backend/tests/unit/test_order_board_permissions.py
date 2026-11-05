"""The Order Board's two permissions: who holds them by default, on a fresh
install and after an upgrade, and that API keys never do."""

import pytest
from sqlalchemy import select

from backend.app.core import database as _database_module
from backend.app.core.auth import _APIKEY_DENIED_PERMISSIONS
from backend.app.core.database import seed_default_groups
from backend.app.core.permissions import DEFAULT_GROUPS, PERMISSION_CATEGORIES, Permission
from backend.app.models.group import Group

_ORDERS = {"orders:read", "orders:update"}


def test_operators_and_administrators_hold_both_orders_permissions():
    for group in ("Administrators", "Operators"):
        perms = DEFAULT_GROUPS[group]["permissions"]
        assert "orders:read" in perms and "orders:update" in perms


def test_viewers_hold_neither():
    assert not _ORDERS & set(DEFAULT_GROUPS["Viewers"]["permissions"])


def test_orders_permissions_are_categorised_and_denied_to_api_keys():
    assert PERMISSION_CATEGORIES["Orders"] == [Permission.ORDERS_READ, Permission.ORDERS_UPDATE]
    assert {Permission.ORDERS_READ, Permission.ORDERS_UPDATE} <= _APIKEY_DENIED_PERMISSIONS


# ``async_client`` is depended upon (unused) so async_session() shares the
# fixture's event loop, as in test_read_permission_backfill_migration.py.
@pytest.mark.asyncio
async def test_upgrade_grants_both_to_operators_and_to_no_other_group(async_client):
    await seed_default_groups()
    async with _database_module.async_session() as session:
        operators = (await session.execute(select(Group).where(Group.name == "Operators"))).scalar_one()
        operators.permissions = [p for p in operators.permissions if p not in _ORDERS]
        session.add(Group(name="order-board-custom", permissions=["printers:read"], is_system=False))
        await session.commit()

    await seed_default_groups()

    async with _database_module.async_session() as session:
        groups = {g.name: set(g.permissions or []) for g in (await session.execute(select(Group))).scalars()}
    assert groups["Operators"] >= _ORDERS
    assert not _ORDERS & groups["order-board-custom"]
    assert not _ORDERS & groups["Viewers"]
