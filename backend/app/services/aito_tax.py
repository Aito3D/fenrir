"""A card's Books tax: the rates an operator may pick, the price rescale, and a customer account's default.

Aito prices are tax-inclusive (the quote is ``is_inclusive_tax``), so changing a card's tax either keeps the price
before tax (every price is rescaled by the ratio of the two rates) or keeps what the client pays (nothing moves).
"""

import json
import re

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services.zoho import zoho_service

CUSTOMER_DEFAULTS_KEY = "aito_customer_tax_defaults"
COST_FIELDS = ("scan_cost", "modelisation_cost", "impression_cost", "usinage_cost", "maindoeuvre_cost")
# shortcut: purchase taxes are told apart by name ("TVA déductible …"); a Books tax type would be sturdier if one
# ever distinguishes them (the 2026-11 probe shows tax_type "tax" for all).
_PURCHASE = re.compile(r"d[ée]ductible", re.IGNORECASE)


async def sales_taxes(db: AsyncSession) -> tuple[str, list[dict]]:
    """The services tax id from settings and the active sales taxes, default first then by rate."""
    default_id = (await zoho_service.get_catalogue(db)).tax_id
    taxes = [
        {
            "tax_id": str(t["tax_id"]),
            "name": (t.get("tax_name") or "").strip(),
            "pct": float(t.get("tax_percentage") or 0),
        }
        for t in await zoho_service.list_taxes(db)
        if t.get("tax_id")
        and (t.get("status") or "Active").lower() == "active"
        and (str(t["tax_id"]) == default_id or not _PURCHASE.search(t.get("tax_name") or ""))
    ]
    taxes.sort(key=lambda t: (t["tax_id"] != default_id, -t["pct"], t["name"]))
    return default_id, taxes


def rescale(cost: float | None, old_pct: float, new_pct: float) -> float | None:
    """A tax-inclusive price at ``old_pct`` with the same price before tax at ``new_pct``, to the whole franc."""
    if cost is None:
        return None
    return float(round(cost / (1 + old_pct / 100) * (1 + new_pct / 100)))


def apply_tax(project: AitoProject, tasks: list[AitoTask], tax: dict, default: dict, *, keep_price_before_tax: bool):
    """Point the card at ``tax`` (the default tax clears the override); rescale its prices when the price before
    tax is kept. ``default`` is the services tax, the rate of a card with no override."""
    old_pct = (project.tax_pct or 0.0) if project.tax_id else default["pct"]
    if keep_price_before_tax and old_pct != tax["pct"]:
        for task in tasks:
            for field in COST_FIELDS:
                setattr(task, field, rescale(getattr(task, field), old_pct, tax["pct"]))
        project.shipping_price = rescale(project.shipping_price, old_pct, tax["pct"])
    is_default = tax["tax_id"] == default["tax_id"]
    project.tax_id = None if is_default else tax["tax_id"]
    project.tax_pct = None if is_default else tax["pct"]


async def customer_defaults(db: AsyncSession) -> dict[str, dict]:
    """Customer account id -> its default tax ``{"tax_id", "pct"}``."""
    try:
        value = json.loads(await get_setting(db, CUSTOMER_DEFAULTS_KEY) or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


async def remember_for_customer(db: AsyncSession, customer_id: str, tax: dict | None) -> None:
    """Save (or with ``None`` forget) a customer account's default tax for its next cards."""
    defaults = await customer_defaults(db)
    if tax is None:
        defaults.pop(customer_id, None)
    else:
        defaults[customer_id] = {"tax_id": tax["tax_id"], "pct": tax["pct"]}
    await set_setting(db, CUSTOMER_DEFAULTS_KEY, json.dumps(defaults, sort_keys=True))
