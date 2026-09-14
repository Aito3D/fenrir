"""T-243: characterize create_backup_zip's PostgreSQL export branch
(backend/app/api/routes/settings.py ~753-817).

The only prior coverage of this branch was ``test_oidc_icon_blob_roundtrip``'s
``_build_backup_schema()`` helper, whose docstring claims to replicate what
the PostgreSQL branch does — but its body only calls
``Base.metadata.create_all(engine)`` on a fresh engine. It never imports or
calls ``create_backup_zip``, never forces ``is_sqlite()`` to return False, and
never exercises the row-export loop (per-table SELECT, JSON-serializing
list/dict columns, ``sqlite3.executemany``, ``dst.commit()`` / ``close()``).
A regression there (e.g. a broken ``_serialize_row``, or ``dst`` never being
committed/closed before the ZIP is built) would pass every existing test.

This test forces the non-SQLite branch while the *source* engine is still
the test's SQLite engine — the export loop only issues SQLAlchemy Core
SELECTs against ``metadata.sorted_tables``, which work identically on either
dialect, so this exercises the real branch without a live PostgreSQL. It
asserts the OUTPUT contract (which row lands in the exported ``bambuddy.db``,
how a list-typed column is serialized, and the returned ``(zip_path,
filename)`` pair) rather than internal call shapes, so a later refactor that
streams the export in chunks can keep this test green.
"""

from __future__ import annotations

import json
import sqlite3
import zipfile

import pytest


class TestCreateBackupZipPostgresExportBranch:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_seeded_row_and_json_column_round_trip_through_the_export_loop(
        self, db_session, test_engine, monkeypatch, tmp_path
    ):
        from backend.app.api.routes.settings import create_backup_zip
        from backend.app.core.config import settings as app_settings
        from backend.app.models.api_key import APIKey

        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setattr(app_settings, "base_dir", tmp_path)

        # Force the PostgreSQL branch. settings.py does a local
        # `from backend.app.core.db_dialect import is_sqlite` inside
        # create_backup_zip, so patching the name at its source is what
        # takes effect at call time.
        monkeypatch.setattr("backend.app.core.db_dialect.is_sqlite", lambda: False)

        # create_backup_zip's PostgreSQL branch also does a local
        # `from backend.app.core.database import Base, engine` — repoint the
        # module attribute at the test's own (already schema'd, isolated)
        # engine instead of the untouched real app engine, so the export
        # loop's SELECTs see the row seeded below.
        monkeypatch.setattr("backend.app.core.database.engine", test_engine)

        key = APIKey(
            name="T-243 export probe",
            key_hash="hash-value",
            key_prefix="pfx1234",
            printer_ids=[1, 2, 3],
        )
        db_session.add(key)
        await db_session.commit()

        zip_path, filename = await create_backup_zip(output_path=tmp_path)
        try:
            # Output contract: returns (zip_path, filename), zip_path is
            # output_path/filename, and the ZIP contains bambuddy.db.
            assert zip_path == tmp_path / filename
            assert zip_path.exists()
            assert filename.startswith("bambuddy-backup-")
            assert filename.endswith(".zip")

            extract_dir = tmp_path / "extracted"
            with zipfile.ZipFile(zip_path) as zf:
                assert "bambuddy.db" in zf.namelist()
                zf.extract("bambuddy.db", extract_dir)

            conn = sqlite3.connect(str(extract_dir / "bambuddy.db"))
            try:
                row = conn.execute(
                    "SELECT name, key_hash, key_prefix, printer_ids FROM api_keys WHERE name = ?",
                    ("T-243 export probe",),
                ).fetchone()
            finally:
                conn.close()
        finally:
            zip_path.unlink(missing_ok=True)

        assert row is not None, "seeded row did not round-trip through the PostgreSQL export loop"
        name, key_hash, key_prefix, printer_ids_json = row
        assert name == "T-243 export probe"
        assert key_hash == "hash-value"
        assert key_prefix == "pfx1234"
        # list/dict-typed columns go through _serialize_row's
        # json.dumps(v) — the exported column is a JSON string, not a raw
        # Python list.
        assert isinstance(printer_ids_json, str)
        assert json.loads(printer_ids_json) == [1, 2, 3]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_table_larger_than_one_chunk_round_trips_completely_and_in_order(
        self, db_session, test_engine, monkeypatch, tmp_path
    ):
        """T-238: the export loop now streams each table via
        ``AsyncResult.partitions()`` instead of ``fetchall()``. Seed a table
        with more rows than a single partition (1000) to prove every chunk
        gets copied — not just the first — and that row order survives the
        chunk boundary.
        """
        from backend.app.api.routes.settings import create_backup_zip
        from backend.app.core.config import settings as app_settings
        from backend.app.models.api_key import APIKey

        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setattr(app_settings, "base_dir", tmp_path)
        monkeypatch.setattr("backend.app.core.db_dialect.is_sqlite", lambda: False)
        monkeypatch.setattr("backend.app.core.database.engine", test_engine)

        row_count = 1500
        db_session.add_all(
            [
                APIKey(
                    name=f"T-238 export probe {i:04d}",
                    key_hash=f"hash-{i}",
                    key_prefix=f"pfx{i}",
                )
                for i in range(row_count)
            ]
        )
        await db_session.commit()

        zip_path, filename = await create_backup_zip(output_path=tmp_path)
        try:
            extract_dir = tmp_path / "extracted-large"
            with zipfile.ZipFile(zip_path) as zf:
                zf.extract("bambuddy.db", extract_dir)

            conn = sqlite3.connect(str(extract_dir / "bambuddy.db"))
            try:
                names = [
                    row[0]
                    for row in conn.execute(
                        "SELECT name FROM api_keys WHERE name LIKE 'T-238 export probe %' ORDER BY id"
                    ).fetchall()
                ]
            finally:
                conn.close()
        finally:
            zip_path.unlink(missing_ok=True)

        assert len(names) == row_count, "rows past the first partition boundary were dropped"
        assert names == [f"T-238 export probe {i:04d}" for i in range(row_count)]
