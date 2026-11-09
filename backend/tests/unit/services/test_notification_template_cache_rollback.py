"""The template cache must survive a rollback/close of the session that loaded it (T-043)."""

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.notification_template import NotificationTemplate
from backend.app.services.notification_service import NotificationService


@pytest.mark.asyncio
async def test_cached_template_renders_on_new_session_after_rollback(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'tpl-cache.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as s:
        s.add(
            NotificationTemplate(
                event_type="print_complete", name="Done", title_template="T {printer}", body_template="B {printer}"
            )
        )
        await s.commit()

    service = NotificationService()
    async with maker() as session_a:
        first = await service._build_message_from_template(session_a, "print_complete", {"printer": "X1"})
        await session_a.rollback()
    async with maker() as session_b:
        second = await service._build_message_from_template(session_b, "print_complete", {"printer": "X1"})

    assert first[0] == second[0] == "T X1"
    assert second[1] == "B X1"
    await engine.dispose()
