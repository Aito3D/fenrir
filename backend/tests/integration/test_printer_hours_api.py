"""Integration tests for /api/v1/maintenance/hours (Maintenance → Hours tab)."""

from datetime import date, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.maintenance import HourMachine

BASE = "/api/v1/maintenance/hours"


async def _machine_for(async_client: AsyncClient, name: str) -> dict:
    data = (await async_client.get(BASE)).json()
    return next(m for m in data["machines"] if m["name"] == name)


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursRead:
    async def test_overview_lists_printers_with_live_counter(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C04", model="X1C", runtime_seconds=3600 * 124, print_hours_offset=10.0)
        response = await async_client.get(BASE)
        assert response.status_code == 200
        data = response.json()
        assert data["today"] == date.today().isoformat()
        [m] = data["machines"]
        assert (m["name"], m["model"], m["retired"], m["current_hours"]) == ("X1C04", "X1C", False, 134.0)
        assert data["readings"] == []


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursSave:
    async def test_backdated_reading_is_stored_without_recalibrating(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C05", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C05")
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-04-25", "entries": [{"machine_id": m["id"], "hours": 3336}]},
        )
        assert response.status_code == 200
        readings = response.json()["readings"]
        assert [(r["reading_date"], r["hours"], r["source"]) for r in readings] == [("2026-04-25", 3336.0, "manual")]
        await db_session.refresh(p)
        assert p.print_hours_offset == 0.0

    async def test_today_reading_recalibrates_and_rewrites_auto(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C06", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C06")
        today = date.today().isoformat()
        response = await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 2629}]}
        )
        assert response.status_code == 200
        data = response.json()
        assert sorted((r["source"], r["hours"]) for r in data["readings"]) == [("auto", 2629.0), ("manual", 2629.0)]
        assert next(x for x in data["machines"] if x["id"] == m["id"])["current_hours"] == 2629.0
        await db_session.refresh(p)
        assert p.print_hours_offset == pytest.approx(2529.0)

    async def test_resaving_unchanged_today_value_does_not_rewind_counter(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C08", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C08")
        today = date.today().isoformat()
        body = {"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 2629}]}
        assert (await async_client.post(f"{BASE}/readings", json=body)).status_code == 200
        await db_session.refresh(p)
        offset = p.print_hours_offset
        p.runtime_seconds = 3600 * 106  # the printer ran 6 more hours
        await db_session.commit()

        response = await async_client.post(f"{BASE}/readings", json=body)
        assert response.status_code == 200
        await db_session.refresh(p)
        assert p.print_hours_offset == offset
        data = response.json()
        assert next(x for x in data["machines"] if x["id"] == m["id"])["current_hours"] == 2635.0

    async def test_clamped_recalibration_writes_actual_counter_to_auto_row(
        self, async_client: AsyncClient, printer_factory
    ):
        await printer_factory(name="X1C09", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C09")
        body = {"reading_date": date.today().isoformat(), "entries": [{"machine_id": m["id"], "hours": 40}]}
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        auto = next(r for r in data["readings"] if r["source"] == "auto")
        assert auto["hours"] == 100.0

    async def test_resave_replaces_and_null_deletes(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C07")
        m = await _machine_for(async_client, "X1C07")
        body = {"reading_date": "2026-01-01", "entries": [{"machine_id": m["id"], "hours": 1629}]}
        await async_client.post(f"{BASE}/readings", json=body)
        body["entries"][0]["hours"] = 1630
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        assert [r["hours"] for r in data["readings"]] == [1630.0]
        body["entries"][0]["hours"] = None
        data = (await async_client.post(f"{BASE}/readings", json=body)).json()
        assert data["readings"] == []

    @pytest.mark.parametrize(
        ("reading_date", "hours", "detail"),
        [
            ((date.today() + timedelta(days=1)).isoformat(), 10, "future"),
            ("2026-01-01", -1, None),
        ],
    )
    async def test_rejects_future_dates_and_negative_hours(
        self, async_client: AsyncClient, printer_factory, reading_date, hours, detail
    ):
        await printer_factory(name="X1C08")
        m = await _machine_for(async_client, "X1C08")
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": reading_date, "entries": [{"machine_id": m["id"], "hours": hours}]},
        )
        assert response.status_code == 422
        if detail:
            assert detail in response.json()["detail"]

    async def test_rejects_retired_unknown_and_duplicate_machines(self, async_client: AsyncClient, db_session):
        retired = HourMachine(name="X1C01", model="X1C", retired=True)
        db_session.add(retired)
        await db_session.commit()
        for entries in (
            [{"machine_id": retired.id, "hours": 1}],
            [{"machine_id": 99999, "hours": 1}],
        ):
            response = await async_client.post(
                f"{BASE}/readings", json={"reading_date": "2026-01-01", "entries": entries}
            )
            assert response.status_code == 422
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-01-01", "entries": [{"machine_id": retired.id, "hours": 1}] * 2},
        )
        assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursDelete:
    async def test_delete_date_removes_manual_only(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C09")
        m = await _machine_for(async_client, "X1C09")
        today = date.today().isoformat()
        await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 5}]}
        )
        response = await async_client.delete(f"{BASE}/readings", params={"reading_date": today})
        assert response.status_code == 200
        assert [r["source"] for r in response.json()["readings"]] == ["auto"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hours_routes_require_auth_when_enabled(async_client: AsyncClient):
    setup = await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "hoursadmin", "admin_password": "TestPass1!"},
    )
    assert setup.status_code == 200
    reading = {"reading_date": "2026-01-01", "entries": [{"machine_id": 1, "hours": 1}]}
    imp = {"new_machines": [], "readings": [{"machine_id": 1, "reading_date": "2026-01-01", "hours": 1}]}
    calls = [
        ("get", BASE, {}),
        ("post", f"{BASE}/readings", {"json": reading}),
        ("delete", f"{BASE}/readings", {"params": {"reading_date": "2026-01-01"}}),
        ("post", f"{BASE}/import", {"json": imp}),
        ("patch", f"{BASE}/machines/1", {"json": {"name": "Renamed"}}),
        ("delete", f"{BASE}/machines/1", {}),
    ]
    for method, url, kwargs in calls:
        response = await async_client.request(method, url, **kwargs)
        assert response.status_code == 401, (method, url)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hours_write_routes_enforce_update_and_delete_permissions(async_client: AsyncClient, db_session):
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))
    group = Group(name="hours-readers", permissions=["maintenance:read"], is_system=False)
    db_session.add(group)
    await db_session.flush()
    user = User(username="hoursreader", password_hash=get_password_hash("password"), is_active=True)
    user.groups.append(group)
    db_session.add(user)
    await db_session.commit()
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}

    assert (await async_client.get(BASE, headers=headers)).status_code == 200
    reading = {"reading_date": "2026-01-01", "entries": [{"machine_id": 1, "hours": 1}]}
    assert (await async_client.post(f"{BASE}/readings", json=reading, headers=headers)).status_code == 403
    response = await async_client.delete(f"{BASE}/readings", params={"reading_date": "2026-01-01"}, headers=headers)
    assert response.status_code == 403
    note = {"event_date": "2026-01-01", "label": "Nozzle swap"}
    assert (await async_client.post(f"{BASE}/machines/1/events", json=note, headers=headers)).status_code == 403
    assert (await async_client.delete(f"{BASE}/events/1", headers=headers)).status_code == 403
    interval = {"reading_interval_days": 30}
    assert (await async_client.patch(f"{BASE}/settings", json=interval, headers=headers)).status_code == 403


@pytest.mark.asyncio
@pytest.mark.integration
async def test_delete_note_event_needs_maintenance_delete(async_client: AsyncClient, db_session):
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))
    updater = Group(name="hours-updaters", permissions=["maintenance:read", "maintenance:update"], is_system=False)
    deleter = Group(name="hours-deleters", permissions=["maintenance:read", "maintenance:delete"], is_system=False)
    db_session.add_all([updater, deleter])
    await db_session.flush()
    headers = {}
    for name, group in (("updater", updater), ("deleter", deleter)):
        user = User(username=name, password_hash=get_password_hash("password"), is_active=True)
        user.groups.append(group)
        db_session.add(user)
        headers[name] = {"Authorization": f"Bearer {create_access_token(data={'sub': name})}"}
    await db_session.commit()

    assert (await async_client.delete(f"{BASE}/events/999999", headers=headers["updater"])).status_code == 403
    # Permission passes for the deleter; the missing event is then a 404, not a 403.
    assert (await async_client.delete(f"{BASE}/events/999999", headers=headers["deleter"])).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursImport:
    async def test_import_creates_retired_machines_and_never_recalibrates(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        p = await printer_factory(name="X1C04", runtime_seconds=3600 * 124)
        m = await _machine_for(async_client, "X1C04")
        today = date.today().isoformat()
        body = {
            "new_machines": [{"key": "X1C01", "name": "X1C01", "model": "X1C"}],
            "readings": [
                {"key": "X1C01", "reading_date": "2024-07-19", "hours": 1470},
                {"key": "X1C01", "reading_date": "2026-04-25", "hours": 4102},
                {"machine_id": m["id"], "reading_date": "2026-04-25", "hours": 3803},
                {"machine_id": m["id"], "reading_date": today, "hours": 3900},
            ],
        }
        response = await async_client.post(f"{BASE}/import", json=body)
        assert response.status_code == 200
        assert response.json() == {"machines_created": 1, "readings_written": 4}
        data = (await async_client.get(BASE)).json()
        retired = next(x for x in data["machines"] if x["name"] == "X1C01")
        assert retired["retired"] is True and retired["current_hours"] is None
        assert len([r for r in data["readings"] if r["machine_id"] == retired["id"]]) == 2
        await db_session.refresh(p)
        assert p.print_hours_offset == 0.0  # imports never recalibrate, even for today's date

    async def test_import_replaces_existing_dates(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="H2S01")
        m = await _machine_for(async_client, "H2S01")
        row = {"machine_id": m["id"], "reading_date": "2026-01-01", "hours": 861}
        await async_client.post(f"{BASE}/import", json={"readings": [row]})
        row["hours"] = 862
        await async_client.post(f"{BASE}/import", json={"readings": [row]})
        data = (await async_client.get(BASE)).json()
        assert [r["hours"] for r in data["readings"]] == [862.0]

    async def test_import_batch_semantics(self, async_client: AsyncClient, printer_factory, db_session):
        from sqlalchemy import event

        from backend.app.models.maintenance import HourReading

        await printer_factory(name="H2S02")
        m = await _machine_for(async_client, "H2S02")
        day = date(2026, 1, 1)
        manual = HourReading(machine_id=m["id"], reading_date=day, source="manual", hours=10, raw_hours=9)
        auto = HourReading(machine_id=m["id"], reading_date=day, source="auto", hours=11, raw_hours=8)
        db_session.add_all([manual, auto])
        await db_session.commit()
        manual_id, auto_id = manual.id, auto.id
        selects: list[str] = []

        def count(_conn, _cursor, statement, *_args):
            if statement.lstrip().upper().startswith("SELECT") and "FROM hour_readings" in statement:
                selects.append(statement)

        engine = db_session.bind.sync_engine
        event.listen(engine, "before_cursor_execute", count)
        try:
            rows = [
                {"machine_id": m["id"], "reading_date": "2026-01-01", "hours": 20},
                {"machine_id": m["id"], "reading_date": "2026-01-02", "hours": 30},
                {"machine_id": m["id"], "reading_date": "2026-01-02", "hours": 31},
                {"machine_id": m["id"], "reading_date": "2026-01-01", "hours": 21},
            ]
            response = await async_client.post(f"{BASE}/import", json={"readings": rows})
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert response.json() == {"machines_created": 0, "readings_written": 4}
        assert len(selects) == 1  # one lookup for the whole sheet, not one per cell
        db_session.expire_all()
        got = (await db_session.execute(select(HourReading).order_by(HourReading.id))).scalars().all()
        state = [(r.id, str(r.reading_date), r.source, r.hours, r.raw_hours) for r in got]
        assert state[:2] == [
            (manual_id, "2026-01-01", "manual", 21.0, None),
            (auto_id, "2026-01-01", "auto", 11.0, 8.0),
        ]
        assert [s[1:] for s in state[2:]] == [("2026-01-02", "manual", 31.0, None)]  # duplicates: last wins

    async def test_import_caps_readings_at_20000(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="H2S03")
        m = await _machine_for(async_client, "H2S03")
        row = {"machine_id": m["id"], "reading_date": "2026-01-01", "hours": 1}
        over = await async_client.post(f"{BASE}/import", json={"readings": [row] * 20001})
        assert over.status_code == 422
        assert (await async_client.get(BASE)).json()["readings"] == []
        ok = await async_client.post(f"{BASE}/import", json={"readings": [row] * 20000})
        assert ok.json() == {"machines_created": 0, "readings_written": 20000}

    @pytest.mark.parametrize(
        "body",
        [
            {"readings": [{"reading_date": "2026-01-01", "hours": 1}]},  # neither machine_id nor key
            {"readings": [{"key": "nope", "reading_date": "2026-01-01", "hours": 1}]},  # unknown key
            {"readings": [{"machine_id": 99999, "reading_date": "2026-01-01", "hours": 1}]},  # unknown id
            {
                "new_machines": [{"key": "a", "name": "A"}, {"key": "a", "name": "B"}],
                "readings": [{"key": "a", "reading_date": "2026-01-01", "hours": 1}],
            },
        ],
    )
    async def test_import_validation_rejects_without_writing(self, async_client: AsyncClient, body):
        response = await async_client.post(f"{BASE}/import", json=body)
        assert response.status_code == 422
        assert (await async_client.get(BASE)).json()["machines"] == []

    async def test_import_rejects_new_machine_named_like_existing(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C02")
        body = {
            "new_machines": [{"key": "k", "name": "x1c02"}],
            "readings": [{"key": "k", "reading_date": "2026-01-01", "hours": 1}],
        }
        assert (await async_client.post(f"{BASE}/import", json=body)).status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
class TestRetiredMachines:
    async def _retired(self, db_session) -> HourMachine:
        m = HourMachine(name="H2C03", model="H2C", retired=True)
        db_session.add(m)
        await db_session.commit()
        return m

    async def test_rename_retired_machine(self, async_client: AsyncClient, db_session):
        m = await self._retired(db_session)
        response = await async_client.patch(f"{BASE}/machines/{m.id}", json={"name": "H2C03 (sold)"})
        assert response.status_code == 200
        assert response.json()["name"] == "H2C03 (sold)"

    async def test_delete_retired_machine_removes_readings(self, async_client: AsyncClient, db_session):
        m = await self._retired(db_session)
        await async_client.post(
            f"{BASE}/import", json={"readings": [{"machine_id": m.id, "reading_date": "2026-04-25", "hours": 345}]}
        )
        assert (await async_client.delete(f"{BASE}/machines/{m.id}")).status_code == 200
        data = (await async_client.get(BASE)).json()
        assert data["machines"] == [] and data["readings"] == []

    async def test_linked_machine_cannot_be_renamed_or_deleted(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="H2D01")
        m = await _machine_for(async_client, "H2D01")
        assert (await async_client.patch(f"{BASE}/machines/{m['id']}", json={"name": "x"})).status_code == 409
        assert (await async_client.delete(f"{BASE}/machines/{m['id']}")).status_code == 409

    async def test_unknown_machine_404(self, async_client: AsyncClient):
        assert (await async_client.delete(f"{BASE}/machines/99999")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_status_set_hours_calibrates_machine(async_client: AsyncClient, printer_factory, db_session):
    p = await printer_factory(name="X1C20", runtime_seconds=3600 * 100)
    response = await async_client.patch(f"/api/v1/maintenance/printers/{p.id}/hours?total_hours=3803")
    assert response.status_code == 200
    assert response.json()["runtime_hours"] == pytest.approx(100.0)
    machine = (await db_session.execute(select(HourMachine).where(HourMachine.printer_id == p.id))).scalar_one()
    await db_session.refresh(machine)
    assert machine.calibrated_at is not None


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursOverviewPayload:
    async def test_overview_carries_trust_events_and_due(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C20", runtime_seconds=3600 * 10)
        m = await _machine_for(async_client, "X1C20")
        await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": "2026-04-25", "entries": [{"machine_id": m["id"], "hours": 3336}]},
        )
        data = (await async_client.get(BASE)).json()
        m = next(x for x in data["machines"] if x["name"] == "X1C20")
        assert m["trust"] == "uncalibrated"
        assert m["next_service_hours"] is None
        assert m["counter_raw_hours"] == 10.0
        assert m["added_on"] == "2026-04-25"
        assert m["calibrated_at"] is None
        assert data["reading_interval_days"] == 90
        assert m["id"] in data["due_machine_ids"]
        # the event was first written before the backdated reading existed, then followed added_on
        assert [(e["kind"], e["event_date"]) for e in data["events"] if e["machine_id"] == m["id"]] == [
            ("added", m["added_on"])
        ]
        assert [r["raw_hours"] for r in data["readings"]] == [None]

    async def test_overview_next_service_only_when_calibrated(
        self, async_client: AsyncClient, printer_factory, monkeypatch
    ):
        from backend.app.api.routes import printer_hours as route

        async def fake_next(_db, _printer_id):
            return 4000.0

        monkeypatch.setattr(route, "next_service_hours", fake_next)
        await printer_factory(name="X1C21", runtime_seconds=3600 * 10)
        await printer_factory(name="X1C22", runtime_seconds=3600 * 10)
        m = await _machine_for(async_client, "X1C21")
        today = date.today().isoformat()
        await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m["id"], "hours": 3000}]}
        )
        data = (await async_client.get(BASE)).json()
        calibrated = next(x for x in data["machines"] if x["name"] == "X1C21")
        fresh = next(x for x in data["machines"] if x["name"] == "X1C22")
        assert calibrated["trust"] in ("calibrated", "drifting")
        assert calibrated["calibrated_at"] is not None
        assert calibrated["next_service_hours"] == 4000.0
        assert fresh["trust"] == "uncalibrated"
        assert fresh["next_service_hours"] is None
        assert calibrated["id"] not in data["due_machine_ids"]


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursNotesAndSettings:
    async def test_note_event_create_and_delete(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C10")
        m = await _machine_for(async_client, "X1C10")
        response = await async_client.post(
            f"{BASE}/machines/{m['id']}/events", json={"event_date": "2026-03-01", "label": "Nozzle swap"}
        )
        assert response.status_code == 200
        event = response.json()
        assert (event["machine_id"], event["event_date"], event["kind"], event["label"]) == (
            m["id"],
            "2026-03-01",
            "note",
            "Nozzle swap",
        )
        assert event["id"] in [e["id"] for e in (await async_client.get(BASE)).json()["events"]]
        assert (await async_client.delete(f"{BASE}/events/{event['id']}")).status_code == 204
        assert event["id"] not in [e["id"] for e in (await async_client.get(BASE)).json()["events"]]
        future = (date.today() + timedelta(days=1)).isoformat()
        response = await async_client.post(
            f"{BASE}/machines/{m['id']}/events", json={"event_date": future, "label": "Later"}
        )
        assert response.status_code == 422

    async def test_mirrored_event_cannot_be_deleted(self, async_client: AsyncClient, db_session, printer_factory):
        from backend.app.models.maintenance import HourEvent

        await printer_factory(name="X1C11")
        m = await _machine_for(async_client, "X1C11")
        event = HourEvent(machine_id=m["id"], event_date=date.today(), kind="maintenance", label="Lubrication")
        db_session.add(event)
        await db_session.commit()
        response = await async_client.delete(f"{BASE}/events/{event.id}")
        assert response.status_code == 409
        assert (await async_client.delete(f"{BASE}/events/999999")).status_code == 404

    async def test_interval_setting_bounds(self, async_client: AsyncClient):
        assert (await async_client.patch(f"{BASE}/settings", json={"reading_interval_days": 6})).status_code == 422
        assert (await async_client.patch(f"{BASE}/settings", json={"reading_interval_days": 366})).status_code == 422
        for days in (7, 365):
            response = await async_client.patch(f"{BASE}/settings", json={"reading_interval_days": days})
            assert response.status_code == 200
            assert response.json()["reading_interval_days"] == days
        assert (await async_client.get(BASE)).json()["reading_interval_days"] == 365

    async def test_purchase_fields_on_live_machine(self, async_client: AsyncClient, printer_factory):
        await printer_factory(name="X1C12")
        m = await _machine_for(async_client, "X1C12")
        response = await async_client.patch(
            f"{BASE}/machines/{m['id']}", json={"purchase_price": 1299.5, "purchase_date": "2025-02-03"}
        )
        assert response.status_code == 200
        assert (response.json()["purchase_price"], response.json()["purchase_date"]) == (1299.5, "2025-02-03")
        assert (await _machine_for(async_client, "X1C12"))["purchase_price"] == 1299.5
        response = await async_client.patch(f"{BASE}/machines/{m['id']}", json={"purchase_date": None})
        assert response.status_code == 200
        assert (response.json()["purchase_price"], response.json()["purchase_date"]) == (1299.5, None)
        assert (await async_client.patch(f"{BASE}/machines/{m['id']}", json={"purchase_price": -1})).status_code == 422
        assert (await async_client.patch(f"{BASE}/machines/{m['id']}", json={"name": "Renamed"})).status_code == 409

    async def test_update_machine_unknown_404_and_duplicate_name_422(self, async_client: AsyncClient, db_session):
        a = HourMachine(name="Alpha", model="H2C", retired=True)
        db_session.add_all([a, HourMachine(name="Beta", model="H2C", retired=True)])
        await db_session.commit()
        assert (await async_client.patch(f"{BASE}/machines/99999", json={"purchase_price": 1})).status_code == 404
        assert (await async_client.patch(f"{BASE}/machines/99999", json={"name": "Z"})).status_code == 404
        response = await async_client.patch(f"{BASE}/machines/{a.id}", json={"name": " BETA "})
        assert response.status_code == 422
        assert "already exists" in response.json()["detail"]
        response = await async_client.patch(f"{BASE}/machines/{a.id}", json={"model": "X1C"})
        assert response.status_code == 200
        assert response.json()["model"] == "X1C"

    async def test_note_on_unknown_machine_404(self, async_client: AsyncClient):
        response = await async_client.post(
            f"{BASE}/machines/99999/events", json={"event_date": "2026-01-01", "label": "hello"}
        )
        assert response.status_code == 404

    async def test_today_reading_skips_recalibration_when_printer_vanishes(
        self, async_client: AsyncClient, printer_factory, db_session, monkeypatch
    ):
        from sqlalchemy.ext.asyncio import AsyncSession

        from backend.app.models.printer import Printer

        p = await printer_factory(name="X1C31", runtime_seconds=3600 * 100)
        m = await _machine_for(async_client, "X1C31")
        real_get = AsyncSession.get

        async def get_without_printer(self, entity, *args, **kwargs):
            return None if entity is Printer else await real_get(self, entity, *args, **kwargs)

        monkeypatch.setattr(AsyncSession, "get", get_without_printer)
        response = await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": date.today().isoformat(), "entries": [{"machine_id": m["id"], "hours": 500}]},
        )
        assert response.status_code == 200
        assert [(r["source"], r["hours"]) for r in response.json()["readings"]] == [("manual", 500.0)]
        monkeypatch.undo()
        await db_session.refresh(p)
        assert p.print_hours_offset == 0.0

    async def test_overview_survives_printer_deleted_under_next_service(
        self, async_client: AsyncClient, printer_factory, monkeypatch
    ):
        from fastapi import HTTPException

        from backend.app.api.routes import printer_hours as route

        async def gone(_db, _printer_id):
            raise HTTPException(status_code=404, detail="Printer not found")

        monkeypatch.setattr(route, "next_service_hours", gone)
        await printer_factory(name="X1C32", runtime_seconds=3600 * 10)
        m = await _machine_for(async_client, "X1C32")
        await async_client.post(
            f"{BASE}/readings",
            json={"reading_date": date.today().isoformat(), "entries": [{"machine_id": m["id"], "hours": 3000}]},
        )
        response = await async_client.get(BASE)
        assert response.status_code == 200
        machine = next(x for x in response.json()["machines"] if x["name"] == "X1C32")
        assert machine["trust"] in ("calibrated", "drifting")
        assert machine["next_service_hours"] is None

    async def test_delete_machine_removes_its_events(self, async_client: AsyncClient, db_session):
        from backend.app.models.maintenance import HourEvent

        body = {
            "new_machines": [{"key": "OLD1", "name": "OLD1", "model": "X1C"}],
            "readings": [{"key": "OLD1", "reading_date": "2024-07-19", "hours": 10}],
        }
        assert (await async_client.post(f"{BASE}/import", json=body)).status_code == 200
        m = await _machine_for(async_client, "OLD1")
        response = await async_client.post(
            f"{BASE}/machines/{m['id']}/events", json={"event_date": "2026-03-01", "label": "Sold"}
        )
        assert response.status_code == 200
        assert (await async_client.delete(f"{BASE}/machines/{m['id']}")).status_code == 200
        remaining = (await db_session.execute(select(HourEvent).where(HourEvent.machine_id == m["id"]))).scalars().all()
        assert remaining == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_both_calibration_routes_produce_the_same_state(async_client: AsyncClient, printer_factory, db_session):
    from backend.app.models.maintenance import HourEvent, HourReading

    a = await printer_factory(name="X1C30", runtime_seconds=3600 * 100, print_hours_offset=50.0)
    b = await printer_factory(name="X1C31", runtime_seconds=3600 * 100, print_hours_offset=50.0)
    ma = await _machine_for(async_client, "X1C30")
    today = date.today().isoformat()
    r = await async_client.post(
        f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": ma["id"], "hours": 2629}]}
    )
    assert r.status_code == 200
    assert (await async_client.patch(f"/api/v1/maintenance/printers/{b.id}/hours?total_hours=2629")).status_code == 200

    states = []
    for p in (a, b):
        m = (await db_session.execute(select(HourMachine).where(HourMachine.printer_id == p.id))).scalar_one()
        await db_session.refresh(m)
        auto = (
            await db_session.execute(
                select(HourReading).where(HourReading.machine_id == m.id, HourReading.source == "auto")
            )
        ).scalar_one()
        events = (
            (
                await db_session.execute(
                    select(HourEvent).where(HourEvent.machine_id == m.id, HourEvent.kind == "calibrated")
                )
            )
            .scalars()
            .all()
        )
        assert m.calibrated_at is not None
        assert len(events) == 1
        states.append((m.last_drift_hours, str(auto.reading_date), auto.hours, auto.raw_hours))
    assert states[0] == states[1]


@pytest.fixture
def limited_to():
    """Run the request as a caller limited to some printers (#1727)."""
    from backend.app.core.auth import get_printer_scope_if_auth_enabled
    from backend.app.core.printer_scope import PrinterScope
    from backend.app.main import app

    def _limit(*printer_ids):
        app.dependency_overrides[get_printer_scope_if_auth_enabled] = lambda: PrinterScope(frozenset(printer_ids))

    yield _limit
    app.dependency_overrides.pop(get_printer_scope_if_auth_enabled, None)


@pytest.mark.asyncio
@pytest.mark.integration
class TestHoursPrinterScope:
    """Write routes treat a machine on a printer outside the caller's scope as unknown (T-005)."""

    async def _two(self, async_client, printer_factory):
        mine = await printer_factory(name="SCOPE-IN", runtime_seconds=3600 * 100)
        other = await printer_factory(name="SCOPE-OUT", runtime_seconds=3600 * 100)
        return mine, other, await _machine_for(async_client, "SCOPE-IN"), await _machine_for(async_client, "SCOPE-OUT")

    async def test_save_readings(self, async_client, printer_factory, db_session, limited_to):
        mine, other, m_in, m_out = await self._two(async_client, printer_factory)
        limited_to(mine.id)
        today = date.today().isoformat()
        response = await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m_out["id"], "hours": 500}]}
        )
        assert response.status_code == 422
        assert response.json()["detail"] == f"Unknown machine {m_out['id']}"
        await db_session.refresh(other)
        assert other.print_hours_offset == 0.0
        ok = await async_client.post(
            f"{BASE}/readings", json={"reading_date": today, "entries": [{"machine_id": m_in["id"], "hours": 500}]}
        )
        assert ok.status_code == 200
        await db_session.refresh(mine)
        assert mine.print_hours_offset == 400.0

    async def test_import_readings(self, async_client, printer_factory, limited_to):
        mine, _, m_in, m_out = await self._two(async_client, printer_factory)
        limited_to(mine.id)
        row = {"reading_date": "2026-01-01", "hours": 10}
        out = await async_client.post(f"{BASE}/import", json={"readings": [{"machine_id": m_out["id"], **row}]})
        assert (out.status_code, out.json()["detail"]) == (422, f"Unknown machine {m_out['id']}")
        ok = await async_client.post(f"{BASE}/import", json={"readings": [{"machine_id": m_in["id"], **row}]})
        assert ok.status_code == 200

    async def test_delete_readings_only_touches_in_scope_machines(
        self, async_client, printer_factory, db_session, limited_to
    ):
        from backend.app.models.maintenance import HourReading

        mine, _, m_in, m_out = await self._two(async_client, printer_factory)
        for m in (m_in, m_out):
            await async_client.post(
                f"{BASE}/readings",
                json={"reading_date": "2026-01-01", "entries": [{"machine_id": m["id"], "hours": 7}]},
            )
        limited_to(mine.id)
        response = await async_client.delete(f"{BASE}/readings", params={"reading_date": "2026-01-01"})
        assert response.status_code == 200
        left = (await db_session.execute(select(HourReading.machine_id))).scalars().all()
        assert left == [m_out["id"]]

    async def test_overview_shows_only_in_scope_and_retired_machines(self, async_client, printer_factory, limited_to):
        mine, _, m_in, m_out = await self._two(async_client, printer_factory)
        today = date.today().isoformat()
        for m in (m_in, m_out):
            await async_client.post(f"{BASE}/machines/{m['id']}/events", json={"event_date": today, "label": "n"})
            await async_client.post(
                f"{BASE}/readings",
                json={"reading_date": "2026-01-01", "entries": [{"machine_id": m["id"], "hours": 7}]},
            )
        retired = await async_client.post(
            f"{BASE}/import",
            json={
                "new_machines": [{"key": "k", "name": "OLD-ONE"}],
                "readings": [{"key": "k", "reading_date": "2026-01-01", "hours": 3}],
            },
        )
        assert retired.status_code == 200
        full = (await async_client.get(BASE)).json()
        assert {m["id"] for m in full["machines"]} >= {m_in["id"], m_out["id"]}
        old_id = next(m["id"] for m in full["machines"] if m["name"] == "OLD-ONE")
        limited_to(mine.id)
        visible = {m_in["id"], old_id}
        for body in (
            (await async_client.get(BASE)).json(),
            (await async_client.patch(f"{BASE}/settings", json={"reading_interval_days": 7})).json(),
            (await async_client.delete(f"{BASE}/readings", params={"reading_date": "2030-01-01"})).json(),
        ):
            assert {m["id"] for m in body["machines"]} == visible
            assert {r["machine_id"] for r in body["readings"]} <= visible
            assert {e["machine_id"] for e in body["events"]} <= visible
            assert m_out["id"] not in body["due_machine_ids"]
            assert any(e["machine_id"] == m_in["id"] for e in body["events"])

    async def test_notes_and_machine_edits(self, async_client, printer_factory, limited_to):
        mine, _, m_in, m_out = await self._two(async_client, printer_factory)
        note = {"event_date": "2026-01-01", "label": "hello"}
        event_id = (await async_client.post(f"{BASE}/machines/{m_out['id']}/events", json=note)).json()["id"]
        limited_to(mine.id)
        assert (await async_client.post(f"{BASE}/machines/{m_out['id']}/events", json=note)).status_code == 404
        assert (await async_client.delete(f"{BASE}/events/{event_id}")).status_code == 404
        patch = {"purchase_price": 1.0}
        assert (await async_client.patch(f"{BASE}/machines/{m_out['id']}", json=patch)).status_code == 404
        assert (await async_client.delete(f"{BASE}/machines/{m_out['id']}")).status_code == 404
        assert (await async_client.post(f"{BASE}/machines/{m_in['id']}/events", json=note)).status_code == 200
        assert (await async_client.patch(f"{BASE}/machines/{m_in['id']}", json=patch)).status_code == 200
