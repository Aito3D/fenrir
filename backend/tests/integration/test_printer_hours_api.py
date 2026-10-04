"""Integration tests for /api/v1/maintenance/hours (Maintenance → Hours tab)."""

from datetime import date, timedelta

import pytest
from httpx import AsyncClient

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
