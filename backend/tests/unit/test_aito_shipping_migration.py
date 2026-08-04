"""The six shipping columns on aito_projects."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject

SHIPPING_COLUMNS = (
    "shipping_island",
    "shipping_service",
    "shipping_first_name",
    "shipping_last_name",
    "shipping_phone",
    "shipping_price",
)


def test_model_declares_every_shipping_column():
    for name in SHIPPING_COLUMNS:
        assert name in AitoProject.__table__.columns, f"{name} missing from the model"
        assert AitoProject.__table__.columns[name].nullable, f"{name} must be nullable"


@pytest.mark.asyncio
async def test_columns_exist_and_default_to_null(db_session):
    project = AitoProject(description="no shipping", board_column="devis", position=0)
    db_session.add(project)
    await db_session.commit()
    stored = (await db_session.execute(select(AitoProject).where(AitoProject.id == project.id))).scalar_one()
    for name in SHIPPING_COLUMNS:
        assert getattr(stored, name) is None


@pytest.mark.asyncio
async def test_columns_round_trip(db_session):
    project = AitoProject(
        description="ship it",
        board_column="devis",
        position=0,
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="Jean-Pierre",
        shipping_last_name="DUPONT",
        shipping_phone="+689-89645864",
        shipping_price=3200.0,
    )
    db_session.add(project)
    await db_session.commit()
    stored = (await db_session.execute(select(AitoProject).where(AitoProject.id == project.id))).scalar_one()
    assert stored.shipping_island == "rangiroa"
    assert stored.shipping_service == "tuamotu"
    assert stored.shipping_price == 3200.0
