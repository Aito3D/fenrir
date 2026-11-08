"""Shared plumbing of the notifications golden probes (loop tooling, not app code).

``temp_db()``: a throw-away SQLite FILE database (never ./bambuddy.db, never
:memory: with a shared connection) with every table created.
``set_settings()``: upsert/delete rows of the settings table.
"""

import contextlib
import shutil
import tempfile


@contextlib.asynccontextmanager
async def temp_db():
    """A session factory on a fresh temp-file SQLite database with every table; removed afterwards."""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    import importlib
    import pkgutil

    import backend.app.main  # noqa: F401
    import backend.app.models as models_pkg
    from backend.app.core.database import Base

    # init_db() imports some models (live activities, widgets) that nothing else imports;
    # register every model module so create_all builds the same tables production has.
    for mod in pkgutil.iter_modules(models_pkg.__path__):
        importlib.import_module(f"backend.app.models.{mod.name}")

    folder = tempfile.mkdtemp(prefix="fenrir-notif-probe-")
    engine = create_async_engine(f"sqlite+aiosqlite:///{folder}/probe.db")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        yield async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    finally:
        await engine.dispose()
        shutil.rmtree(folder, ignore_errors=True)


async def set_settings(sessions, values: dict) -> None:
    """Upsert (value) or delete (None) rows of the settings table."""
    from sqlalchemy import select

    from backend.app.models.settings import Settings

    async with sessions() as db:
        for key, value in values.items():
            row = (await db.execute(select(Settings).where(Settings.key == key))).scalar_one_or_none()
            if value is None:
                if row is not None:
                    await db.delete(row)
            elif row is None:
                db.add(Settings(key=key, value=value))
            else:
                row.value = value
        await db.commit()
