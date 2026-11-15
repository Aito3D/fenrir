"""Shared plumbing of the filament-tree (F1) golden probes (loop tooling, not app code).

IMPORT THIS BEFORE ANY ``backend.app`` MODULE. Importing the app resolves its data
directory at import time (``core/config.py``: DATA_DIR, else the repo root, where it
would point at ./bambuddy.db and create ./archive, ./logs, ./data). This module sets
DATA_DIR / LOG_DIR to a fresh ``tempfile.mkdtemp()`` folder first, so the app's own
engine, archive and log folders all live there. The folder (this process's own temp
folder, nothing else) is removed at exit. No probe deletes or writes a repo path.
"""

import atexit
import os
import shutil
import sys
import tempfile

ROOT = tempfile.mkdtemp(prefix="fenrir-ftree-probe-")
os.environ["DATA_DIR"] = ROOT
os.environ["LOG_DIR"] = os.path.join(ROOT, "logs")
os.environ.pop("DATABASE_URL", None)  # never an external database
atexit.register(shutil.rmtree, ROOT, ignore_errors=True)
sys.path.insert(0, ".")


async def create_schema():
    """Every table, on the app's own engine — after checking that engine sits in the temp folder."""
    import importlib
    import pkgutil

    import backend.app.main  # noqa: F401
    import backend.app.models as models_pkg
    from backend.app.core.database import Base, engine

    db_file = engine.url.database or ""
    if engine.url.get_backend_name() != "sqlite" or not os.path.realpath(db_file).startswith(os.path.realpath(ROOT)):
        raise SystemExit(f"probe refuses to run: the app database is {engine.url!r}, not under {ROOT}")
    # `import backend.app.main` does not register every model; create_all needs them all.
    for mod in pkgutil.iter_modules(models_pkg.__path__):
        importlib.import_module(f"backend.app.models.{mod.name}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine
