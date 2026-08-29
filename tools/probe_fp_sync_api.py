"""Golden probe: the POST /filament-profiles/zoho-sync route body, end to end.

Runs the real route coroutine against a real (in-memory) database with a
stubbed Zoho catalogue, and prints the response DTO plus the resulting preset
contents. This is the whole user-visible contract of the feature in one place:
which profiles get priced, which are reported and with what reason and
candidates, whether the counts are disjoint and sum, whether unmatched presets
are left BYTE-IDENTICAL, and what the operator sees when Zoho is unconfigured,
unreachable, or returns something unmappable.

Deliberately calls the coroutine directly rather than going over HTTP: the
permission gate and the URL are frozen separately (SURFACE.md sections
"Permission gates..." and "...HTTP routes", plus the fp-openapi probe), and
skipping the client keeps this probe free of auth fixtures and event-loop
plumbing that would flake for reasons unrelated to the sync.
"""

import asyncio
import json
import sys

sys.path.insert(0, ".")

from fastapi import HTTPException  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.api.routes import filament_profiles as route_mod  # noqa: E402
from backend.app.core.database import Base  # noqa: E402
from backend.app.models.filament_profile import FilamentPreset  # noqa: E402
from backend.app.services import zoho_filaments  # noqa: E402
from backend.app.services.zoho import zoho_service  # noqa: E402
from backend.app.services.zoho_filaments import FilamentProduct  # noqa: E402


def product(brand, material, colour, price=19.9, has_price=True):
    return FilamentProduct(
        item_id=f"{brand}|{material}|{colour}",
        name=f"{brand} - {material} - {colour} - 1.75mm - 1kg",
        sku=f"SKU-{brand[:3]}",
        brand=brand,
        material=material,
        colour=colour,
        spool_weight_kg=1.0,
        weight_inferred=False,
        dealer_price=price,
        cost_per_kg=price,
        has_price=has_price,
    )


CATALOGUE = [
    product("Polymaker", "PETG", "Electric Blue", 19.9),
    product("Polymaker", "PETG", "Black", 21.5),
    product("Bambu Lab", "PLA Basic", "Jade White", 24.99),
    product("eSUN", "PETG", "Grey", 0.0, has_price=False),
]

# (name, brand, material, colour, content) — one per outcome the sync can reach.
PRESETS = [
    ("priced-fresh", "Polymaker", "PLA", "Any", json.dumps({"name": "priced-fresh"}, indent=4)),
    ("priced-changed", "Bambu Lab", "PLA Basic", "Jade White", json.dumps({"filament_cost": ["1.00"]}, indent=4)),
    ("already-correct", "Polymaker", "PETG", "Black", json.dumps({"filament_cost": ["21.50"]}, indent=4)),
    ("ambiguous", "Polymaker", "PETG", "Pink", json.dumps({"name": "ambiguous"}, indent=4)),
    ("no-price", "eSUN", "PETG", "Grey", json.dumps({"name": "no-price"}, indent=4)),
    ("no-match", "Nobody", "PLA", "Red", json.dumps({"name": "no-match"}, indent=4)),
    ("unparseable-content", "Polymaker", "PLA", "Any", "{not json"),
    ("empty-content", "Polymaker", "PLA", "Any", ""),
    ("blank-brand", "", "PETG", "Electric Blue", json.dumps({"name": "blank-brand"}, indent=4)),
]

# "Polymaker - PLA" is not in the catalogue, so priced-fresh would report
# no_match; give it a real single match instead by adding the row here.
CATALOGUE.append(product("Polymaker", "PLA", "Grey", 15.0))


class _Stub:
    """Minimal stand-ins so the route's two collaborators are deterministic."""

    def __init__(self, configured=True, catalogue=None, raises=None):
        self.configured = configured
        self.catalogue = catalogue
        self.raises = raises

    async def is_configured(self, _db):
        return self.configured

    async def fetch_catalogue(self, _db):
        if self.raises is not None:
            raise self.raises
        return list(self.catalogue or [])


async def seed(session):
    for name, brand, material, colour, content in PRESETS:
        session.add(
            FilamentPreset(
                name=name,
                brand=brand,
                material=material,
                color=colour,
                color_hex="#3E8CE4",
                filename=f"{name}.json",
                content=content,
            )
        )
    await session.commit()


async def run_case(label, stub, runs=1):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    orig_is_configured = zoho_service.is_configured
    orig_fetch = zoho_filaments.fetch_catalogue
    zoho_service.is_configured = stub.is_configured
    zoho_filaments.fetch_catalogue = stub.fetch_catalogue
    try:
        async with maker() as session:
            await seed(session)
            print(f"\n=== {label} ===")
            for run in range(1, runs + 1):
                if runs > 1:
                    print(f"-- run {run}")
                try:
                    response = await route_mod.sync_filament_presets_from_zoho(db=session)
                    print("status=200")
                    print(json.dumps(response.model_dump(), sort_keys=True, indent=1))
                except HTTPException as exc:
                    print(f"status={exc.status_code} detail={exc.detail!r}")

            rows = (await session.execute(__import__("sqlalchemy").select(FilamentPreset).order_by(FilamentPreset.id))).scalars().all()
            print("--- presets after ---")
            for row in rows:
                before = dict((p[0], p[4]) for p in PRESETS)[row.name]
                print(f"{row.name}: {'UNCHANGED' if row.content == before else 'REWRITTEN'} {row.content!r}")
    finally:
        zoho_service.is_configured = orig_is_configured
        zoho_filaments.fetch_catalogue = orig_fetch
        await engine.dispose()


async def main():
    await run_case("happy path — full catalogue", _Stub(catalogue=CATALOGUE))
    # Two syncs against the SAME database: the second must report every profile
    # as unchanged and rewrite nothing. A regression here re-writes every user
    # preset file on every sync.
    await run_case("sync twice on one database — second run must be a no-op", _Stub(catalogue=CATALOGUE), runs=2)
    await run_case("empty catalogue", _Stub(catalogue=[]))
    await run_case("zoho not configured", _Stub(configured=False))
    await run_case(
        "catalogue unreachable",
        _Stub(raises=RuntimeError("Zoho page 3 of 20 failed")),
    )
    await run_case(
        "catalogue unmappable",
        _Stub(raises=zoho_filaments.ZohoFilamentMappingError("every item failed to map")),
    )


asyncio.run(main())
