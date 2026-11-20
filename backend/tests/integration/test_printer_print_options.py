"""Route tests for print-options (AI detection), ams-backup and drying start/stop validation."""

from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient

PM = "backend.app.services.printer_manager.printer_manager"


def _client(connected=True, ok=True):
    client = MagicMock()
    client.state.connected = connected
    client.set_xcam_option.return_value = ok
    client.set_ams_filament_backup.return_value = ok
    return client


@pytest.fixture
def get_client():
    with patch(f"{PM}.get_client", new=MagicMock()) as m:
        yield m


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    "path,query",
    [("print-options", "module_name=spaghetti_detector&enabled=true"), ("ams-backup", "enabled=true")],
)
async def test_option_routes_error_matrix(async_client: AsyncClient, printer_factory, get_client, path, query):
    resp = await async_client.post(f"/api/v1/printers/999999/{path}?{query}")
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Printer not found"

    printer = await printer_factory()
    url = f"/api/v1/printers/{printer.id}/{path}?{query}"

    get_client.return_value = None
    resp = await async_client.post(url)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Printer not connected"

    get_client.return_value = _client(connected=False)
    resp = await async_client.post(url)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Printer not connected"

    get_client.return_value = _client(ok=False)
    resp = await async_client.post(url)
    assert resp.status_code == 500
    assert resp.json()["detail"] == "Failed to send command to printer"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_print_options_invalid_module_and_sensitivity(async_client: AsyncClient, printer_factory, get_client):
    printer = await printer_factory()
    client = _client()
    get_client.return_value = client
    base = f"/api/v1/printers/{printer.id}/print-options"

    resp = await async_client.post(f"{base}?module_name=bogus&enabled=true")
    assert resp.status_code == 400
    assert resp.json()["detail"].startswith("Invalid module_name. Must be one of:")

    resp = await async_client.post(f"{base}?module_name=spaghetti_detector&enabled=true&sensitivity=extreme")
    assert resp.status_code == 400
    assert resp.json()["detail"].startswith("Invalid sensitivity. Must be one of:")
    client.set_xcam_option.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_print_options_success_passes_exact_args(async_client: AsyncClient, printer_factory, get_client):
    printer = await printer_factory()
    client = _client()
    get_client.return_value = client

    resp = await async_client.post(
        f"/api/v1/printers/{printer.id}/print-options"
        "?module_name=first_layer_inspector&enabled=false&print_halt=false&sensitivity=high"
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "success": True,
        "module_name": "first_layer_inspector",
        "enabled": False,
        "print_halt": False,
        "sensitivity": "high",
    }
    client.set_xcam_option.assert_called_once_with(
        module_name="first_layer_inspector", enabled=False, print_halt=False, sensitivity="high"
    )

    client.set_xcam_option.reset_mock()
    resp = await async_client.post(
        f"/api/v1/printers/{printer.id}/print-options?module_name=printing_monitor&enabled=true"
    )
    assert resp.status_code == 200
    client.set_xcam_option.assert_called_once_with(
        module_name="printing_monitor", enabled=True, print_halt=True, sensitivity="medium"
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_ams_backup_success(async_client: AsyncClient, printer_factory, get_client):
    printer = await printer_factory()
    client = _client()
    get_client.return_value = client

    resp = await async_client.post(f"/api/v1/printers/{printer.id}/ams-backup?enabled=true")
    assert resp.status_code == 200
    assert resp.json() == {"success": True, "ams_filament_backup": True}
    client.set_ams_filament_backup.assert_called_once_with(True)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_stop_drying_success_forgets_auto_dry_cycle(async_client: AsyncClient, printer_factory):
    printer = await printer_factory(model="X1C")
    with (
        patch(f"{PM}.send_drying_command", new=MagicMock(return_value=True)) as send,
        patch("backend.app.services.print_scheduler.scheduler.forget_auto_dry_cycle") as forget,
    ):
        resp = await async_client.post(f"/api/v1/printers/{printer.id}/drying/stop?ams_id=2")
    assert resp.status_code == 200
    assert resp.json() == {"status": "drying_stopped", "ams_id": 2}
    send.assert_called_once_with(printer.id, 2, temp=0, duration=0, mode=0)
    forget.assert_called_once_with(printer.id, 2)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_stop_drying_not_connected_and_unknown_printer(async_client: AsyncClient, printer_factory):
    resp = await async_client.post("/api/v1/printers/999999/drying/stop?ams_id=0")
    assert resp.status_code == 404

    printer = await printer_factory(model="X1C")
    with (
        patch(f"{PM}.send_drying_command", new=MagicMock(return_value=False)),
        patch("backend.app.services.print_scheduler.scheduler.forget_auto_dry_cycle") as forget,
    ):
        resp = await async_client.post(f"/api/v1/printers/{printer.id}/drying/stop?ams_id=0")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Printer not connected"
    forget.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    "query,detail",
    [
        ("temp=44", "Temperature must be 45-85°C"),
        ("temp=86", "Temperature must be 45-85°C"),
        ("duration=0", "Duration must be 1-24 hours"),
        ("duration=25", "Duration must be 1-24 hours"),
    ],
)
async def test_start_drying_range_400s(async_client: AsyncClient, printer_factory, query, detail):
    printer = await printer_factory(model="X1C")
    state = MagicMock()
    state.firmware_version = "01.10.00.00"
    with (
        patch(f"{PM}.get_status", new=MagicMock(return_value=state)),
        patch(f"{PM}.send_drying_command", new=MagicMock(return_value=True)) as send,
    ):
        resp = await async_client.post(f"/api/v1/printers/{printer.id}/drying/start?ams_id=0&{query}")
    assert resp.status_code == 400
    assert resp.json()["detail"] == detail
    send.assert_not_called()
