"""Order Board campaign (O3) golden probe: the HTTP scenario, end to end through the routes.

Run by pytest (PROBES.json) with the backend test conftest loaded as a plugin, so it gets the
suite's throwaway databases (an in-memory fixture engine and a temp-dir app engine), the ASGI
client and its autouse isolation. Zoho Books and Heimdall are the suite's own recording fakes
(backend/tests/unit/test_order_board_sync.py / test_order_board_actions.py) plus a few here;
every coroutine of ``zoho_service`` / ``heimdall_service`` is additionally wrapped so the call
log records each call (name + arguments) whether faked or not, and httpx's real network
transports raise, so nothing can leave the machine. The sync loop is never started: passes run
explicitly through POST /refresh or ``run_pass``.

Each scenario appends its steps (method, url, request body, status, content type, body; a PDF
as its extracted text) and its service-call log to the JSON file named by $PROBE_OUT.
Loop tooling, not app code. Not collected by the suite (it lives outside backend/tests).
"""

import inspect
import json
import os
import re

import httpx
import pypdfium2 as pdfium
import pytest
from sqlalchemy import select

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.settings import Settings
from backend.app.services import order_board_sync as sync
from backend.app.services.heimdall import LinkView, heimdall_service
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_order_board_actions import (  # noqa: F401  (fixtures by name)
    _packed,
    books,
    handover_order,
    lines_edit,
    parcels,
    voids,
)
from backend.tests.unit.test_order_board_sync import (  # noqa: F401  (fixtures by name)
    no_back_off_left_over,
    order,
    purchase,
    zoho,
)

OUT = os.environ.get("PROBE_OUT", "/tmp/fenrir-orders-probe/http.json")
BASE = "/api/v1/order-board"
RESULTS: list[dict] = []


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Any real HTTP request (an unfaked Zoho/Heimdall call with credentials somehow present) fails loudly."""

    def refuse(*a, **k):
        raise RuntimeError("probe: network blocked")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)


def _plain(value):
    """Arguments as JSON: a db session or other object by its type name only."""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        items = [_plain(v) for v in value]
        return sorted(items, key=json.dumps) if isinstance(value, (set, frozenset)) else items
    if hasattr(value, "__dataclass_fields__"):
        return {"__type__": type(value).__name__, **{k: _plain(getattr(value, k)) for k in value.__dataclass_fields__}}
    return f"<{type(value).__name__}>"


class Recorder:
    def __init__(self, client, monkeypatch, name):
        self.client, self.name, self.steps, self.calls = client, name, [], []
        for service, label in ((zoho_service, "zoho"), (heimdall_service, "heimdall")):
            for attr in sorted(dir(service)):
                fn = getattr(service, attr, None)
                if attr.startswith("_") or not inspect.iscoroutinefunction(fn):
                    continue
                monkeypatch.setattr(service, attr, self._wrap(f"{label}.{attr}", fn))

    def _wrap(self, label, fn):
        async def wrapper(*args, **kwargs):
            entry = {"call": label, "args": _plain([a for a in args if type(a).__name__ != "AsyncSession"]), "kwargs": _plain(kwargs)}
            try:
                result = await fn(*args, **kwargs)
            except Exception as e:  # noqa: BLE001  (recorded, then re-raised)
                entry["raised"] = type(e).__name__
                self.calls.append(entry)
                raise
            self.calls.append(entry)
            return result

        return wrapper

    async def __call__(self, method, url, body=None, label=None):
        kwargs = {} if body is None else {"json": body}
        r = await getattr(self.client, method)(url, **kwargs)
        ctype = r.headers.get("content-type", "")
        if ctype.startswith("application/pdf"):
            doc = pdfium.PdfDocument(r.content)
            shown = {"pages": len(doc), "text": [p.get_textpage().get_text_range().replace("\r\n", "\n") for p in doc]}
        else:
            try:
                shown = r.json()
            except ValueError:
                shown = r.text
        self.steps.append(
            {
                "step": label or f"{method.upper()} {url}",
                "request": body,
                "status": r.status_code,
                "content_type": ctype,
                "headers": {k: r.headers[k] for k in ("cache-control", "content-disposition", "retry-after") if k in r.headers},
                "body": shown,
                "zoho_calls": self.calls[:],
            }
        )
        self.calls.clear()
        return r

    def done(self, extra=None):
        RESULTS.append({"scenario": self.name, "steps": self.steps, **(extra or {})})
        text = json.dumps(RESULTS, indent=1, sort_keys=True, ensure_ascii=False, default=str)
        for token in TOKENS:
            text = text.replace(token, "<TOKEN>")
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(text + "\n")


TOKENS: list[str] = []


async def _setting(db, key, value):
    db.add(Settings(key=key, value=value))
    await db.commit()


# --- 1. the board: refresh passes, read, finished, settings, watch, notes, events --------------------------------


@pytest.mark.asyncio
async def test_board_read_settings_finished_events(async_client, db_session, zoho, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "board")
    zoho.add(order(1, qty=2), order(2, qty=3, item="B"), order(3, shipped=1, paid_status="paid"), purchase(1, item="B", qty=2))
    zoho.stock = {"A": 3, "B": 1}
    await rec("get", BASE, label="board before any pass")
    await rec("post", f"{BASE}/refresh", label="first pass")
    await rec("post", f"{BASE}/refresh", label="second pass")
    await rec("get", BASE)
    await rec("get", f"{BASE}/finished")
    await rec("get", f"{BASE}/finished/so3")
    await rec("get", f"{BASE}/finished/so1", label="an open order is not finished")
    await rec("get", f"{BASE}/settings")
    await rec("put", f"{BASE}/settings", {"sync_enabled": False, "sync_minutes": 60, "max_age_days": 0, "core_brands": [" eSUN ", "esun", "Marlow"], "scan_enabled": True})
    await rec("put", f"{BASE}/settings", {"sync_enabled": True, "sync_minutes": 7, "max_age_days": 0, "core_brands": []}, label="bad minutes")
    await rec("get", f"{BASE}/settings")
    await rec("get", f"{BASE}/orders/so1/watch")
    await rec("put", f"{BASE}/orders/so1/watch")
    await rec("delete", f"{BASE}/orders/so1/watch")
    await rec("get", f"{BASE}/orders/nope/watch", label="unknown order")
    await rec("post", f"{BASE}/orders/so1/events", {"note": "Client called, comes Friday"})
    await rec("post", f"{BASE}/orders/so1/events", {"note": ""}, label="empty note")
    for depth in ("story", "detail", "everything"):
        await rec("get", f"{BASE}/orders/so1/events?depth={depth}")
    await rec("get", f"{BASE}/orders/so1/events?limit=1")
    await rec("get", f"{BASE}/orders/so1/events?before=1", label="half a cursor")
    await rec("post", f"{BASE}/orders/so1/prep-sheet", label="prep sheet, whole order")
    await rec("post", f"{BASE}/prep-sheet/batch", {"ids": ["so1", "so2", "so1", "nope"]})
    await rec("post", f"{BASE}/prep-sheet/batch", {"ids": ["nope"]}, label="batch with nothing to pick")
    await rec("get", BASE, label="board after the prints")
    rec.done()


# --- 2. picklist -> prep sheet of the picklist -> parcel ----------------------------------------------------------


@pytest.mark.asyncio
async def test_picklist_then_parcel(async_client, db_session, parcels, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "picklist_parcel")
    doc = order(1, qty=3)
    doc["line_items"].append({**doc["line_items"][0], "line_item_id": "lb", "item_id": "B", "quantity": 2})
    parcels.stock = {"A": 3, "B": 1}
    parcels.add(doc)
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/orders/so1/picklist")
    await rec("post", f"{BASE}/orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": 9}]}, label="too many")
    r = await rec("post", f"{BASE}/orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": 2}, {"line_id": "lb", "quantity": 1}]})
    picklist = r.json()["picklist"]["id"]
    await rec("post", f"{BASE}/orders/so1/picklists", {"lines": [{"line_id": "l1", "quantity": 1}]}, label="second open picklist")
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/orders/so1/picklists/{picklist}")
    await rec("post", f"{BASE}/orders/so1/prep-sheet?picklist_id={picklist}", label="prep sheet of the picklist")
    await rec("post", f"{BASE}/orders/so1/packages", {"picklist_id": picklist, "lines": [{"line_id": "l1", "quantity": 2}, {"line_id": "lb", "quantity": 1}]})
    await rec("post", f"{BASE}/orders/so1/packages", {"picklist_id": "nope", "lines": [{"line_id": "l1", "quantity": 1}]}, label="unknown picklist")
    await rec("post", f"{BASE}/orders/so1/packages", {"picklist_id": picklist, "lines": [{"line_id": "l1", "quantity": 1}, {"line_id": "l1", "quantity": 1}]}, label="duplicate line")
    await rec("post", f"{BASE}/orders/zz/picklists", {"lines": [{"line_id": "l1", "quantity": 1}]}, label="unknown order")
    rec.done({"zoho_writes": parcels.writes, "zoho_bodies": parcels.bodies})


# --- 3. parcel edit ------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parcel_edit(async_client, db_session, parcels, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "parcel_edit")
    parcels.add(_packed(parcels))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    r = await rec("get", f"{BASE}/orders/so1/packages/p1")
    version = r.json()["version"]
    await rec("put", f"{BASE}/orders/so1/packages/p1", {"version": "stale", "was": [{"line_id": "l1", "quantity": 2}], "lines": [{"line_id": "l1", "quantity": 3}]}, label="stale version")
    await rec("put", f"{BASE}/orders/so1/packages/p1", {"version": version, "was": [{"line_id": "l1", "quantity": 2}], "lines": [{"line_id": "l1", "quantity": 3}, {"line_id": "l2", "quantity": 1}]})
    await rec("get", f"{BASE}/orders/so1/packages/nope", label="unknown parcel")
    rec.done({"zoho_steps": parcels.steps})


# --- 4. order line edit and item search ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_line_edit(async_client, db_session, lines_edit, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "line_edit")
    doc = order(1, qty=2)
    doc["line_items"][0].update(rate=1000, product_type="goods")
    doc["line_items"].append({"line_item_id": "s1", "name": "Labour", "quantity": 1, "rate": 500, "product_type": "service"})
    lines_edit.add(doc)
    lines_edit.item_search = [{"item_id": "B", "name": "Bee", "sku": "B1", "rate": 2900, "product_type": "goods", "stock_on_hand": 4}]
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/items?q=be")
    await rec("get", f"{BASE}/items?q=b", label="query too short")
    version = (await async_client.get(BASE)).json()["rows"][0]["version"]
    await rec("put", f"{BASE}/orders/so1/lines", {"version": "old", "lines": [{"line_id": "l1", "quantity": 3}]}, label="stale version")
    await rec("put", f"{BASE}/orders/so1/lines", {"version": version, "lines": [{"line_id": "l1", "quantity": 3}, {"item_id": "B", "quantity": 1}]})
    await rec("put", f"{BASE}/orders/so1/lines", {"version": version, "lines": [{"line_id": "l1", "item_id": "B", "quantity": 1}]}, label="both targets")
    rec.done({"zoho_writes": lines_edit.writes, "zoho_bodies": lines_edit.bodies})


# --- 5. hand-over (pickup), invoice PDF and invoice e-mail ---------------------------------------------------------


@pytest.mark.asyncio
async def test_handover_and_invoice_email(async_client, db_session, books, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "handover")

    async def get_invoice_pdf(db, invoice_id):
        from reportlab.pdfgen import canvas

        import io

        buf = io.BytesIO()
        c = canvas.Canvas(buf, invariant=1)
        c.drawString(72, 720, f"Facture {invoice_id}")
        c.save()
        return buf.getvalue()

    async def get_invoice_email_content(db, invoice_id):
        return {"subject": f"Facture {invoice_id}", "body": "<p>Bonjour</p>", "recipients": [{"name": "Other", "email": "other@example.test"}, {"name": "Hina", "email": "HINA@example.test"}]}

    async def email_invoice(db, invoice_id, *, to_mail_ids):
        return None

    for fn in (get_invoice_pdf, get_invoice_email_content, email_invoice):
        monkeypatch.setattr(zoho_service, fn.__name__, fn)
    doc = handover_order(books, advance=600)
    doc["contact_person_details"] = [{"first_name": "Hina", "last_name": "T", "email": "hina@example.test", "phone": "", "mobile": "87 11 22 33"}]
    books.unused = [{"payment_id": "p1", "date": "2026-09-01", "unused_amount": 900}]
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/orders/so1/packages/pk1/handover")
    await rec("get", f"{BASE}/orders/so1/invoice")
    await rec("post", f"{BASE}/orders/so1/packages/pk1/handover", {"mode": "pickup", "apply_credit": True})
    await rec("post", f"{BASE}/orders/so1/packages/pk1/handover", {"mode": "pickup", "apply_credit": True}, label="again: nothing left")
    await rec("get", f"{BASE}/invoices/inv-1/pdf")
    await rec("get", f"{BASE}/invoices/unknown/pdf", label="invoice no stored order lists")
    await rec("get", f"{BASE}/invoices/inv-1/email")
    await rec("post", f"{BASE}/invoices/inv-1/email", {"to": "stranger@example.test"}, label="not a recipient")
    await rec("post", f"{BASE}/invoices/inv-1/email", {"to": " hina@example.test "})
    await rec("post", f"{BASE}/invoices/inv-1/email", {"to": "hina@example.test"}, label="second send inside the guard window")
    await rec("get", f"{BASE}/orders/so1/events?depth=everything")
    rec.done()


# --- 6. invoice of shipped units, then cancel of another order -----------------------------------------------------


@pytest.mark.asyncio
async def test_invoice_and_cancel(async_client, db_session, books, voids, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "invoice_cancel")
    handover_order(books, qty=3, box=2, status="shipped", service=True)
    books.add(order(2, qty=1))
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/orders/so1/invoice")
    await rec("post", f"{BASE}/orders/so1/invoice", {"apply_credit": False, "scope": "shipped"})
    await rec("post", f"{BASE}/orders/so1/invoice", {"apply_credit": False, "scope": "everything"}, label="bad scope")
    await rec("post", f"{BASE}/orders/so2/cancel")
    await rec("post", f"{BASE}/orders/so2/cancel", label="already off the board")
    await rec("get", BASE)
    rec.done({"voided": voids.voided})


# --- 7. payments: target, link, pickup SMS with the link, cancel, terminal -----------------------------------------


@pytest.mark.asyncio
async def test_payments_and_pickup_sms(async_client, db_session, zoho, monkeypatch):
    invoice = {"invoice_id": "inv-2", "invoice_number": "FA-2", "date": "2026-11-01", "due_date": "2099-01-01", "total": 1000, "balance": 600, "status": "sent"}
    doc = order(1, qty=1, invoices=[invoice], customer="c1")
    doc["contact_person_details"] = [{"first_name": "Hina", "last_name": "T", "email": "", "phone": "", "mobile": "87 11 22 33"}]
    zoho.add(doc, order(2, qty=1, customer="c2"))
    await _setting(db_session, "external_url", "https://shop.example/")
    created = []

    async def get_invoice_raw(db, invoice_id):
        return {"invoice_number": "FA-2", "customer_id": "c1", "balance": 600, "status": "sent"}

    async def create_link(db, *, idempotency_key, reference, amount, expires_in_days):
        created.append(idempotency_key)
        return LinkView(id=f"h-{len(created)}", status="pending", amount=amount, currency="XPF", reference=reference,
                        url=f"https://pay.example/l/{len(created)}", expires_at=None)

    async def cancel_link(db, heimdall_id):
        return LinkView(id=heimdall_id, status="cancelled", amount=600, currency="XPF", reference="FA-2", url="", expires_at=None)

    async def get_payment(db, heimdall_id):
        return LinkView(id=heimdall_id, status="processing", amount=600, currency="XPF", reference="FA-2", url="", expires_at=None)

    async def create_terminal_payment(db, **kwargs):
        return LinkView(id="t-1", status="processing", amount=kwargs.get("amount"), currency="XPF", reference=kwargs.get("reference", ""), url="", expires_at=None)

    async def is_configured(db):
        return True

    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)
    for fn in (create_link, cancel_link, get_payment, create_terminal_payment, is_configured):
        monkeypatch.setattr(heimdall_service, fn.__name__, fn)
    rec = Recorder(async_client, monkeypatch, "payments_sms")  # after the fakes: it wraps them
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/orders/so1/payment-target")
    await rec("get", f"{BASE}/orders/so2/payment-target", label="order without an invoice")
    await rec("get", f"{BASE}/orders/so1/sms-draft", label="sms draft before any link")
    await rec("post", f"{BASE}/orders/so1/payment-link", {"amount": 601}, label="above what is left")
    await rec("post", f"{BASE}/orders/so1/payment-link", {"amount": 600})
    await rec("post", f"{BASE}/orders/so1/payment-link", {"amount": 600}, label="second link")
    await rec("get", f"{BASE}/orders/so1/payment-target", label="target with the open link")
    r = await rec("get", f"{BASE}/orders/so1/sms-draft", label="sms draft with the link")
    TOKENS.extend(re.findall(r"/t/([A-Za-z0-9]+)", json.dumps(r.json())))
    link_id = (r.json().get("payment_link") or {}).get("id")
    await rec("post", f"{BASE}/orders/so1/sms", {"payment_link_id": link_id})
    await rec("post", f"{BASE}/orders/so1/terminal-payment", {"amount": 600}, label="terminal while a link is open")
    await rec("post", f"{BASE}/orders/so1/payment-link/cancel")
    await rec("post", f"{BASE}/orders/so1/payment-link/cancel", label="nothing open to cancel")
    await rec("post", f"{BASE}/orders/so1/terminal-payment", {"amount": 600})
    await rec("get", f"{BASE}/orders/so1/terminal-payment")
    await rec("get", f"{BASE}/orders/so2/terminal-payment", label="no terminal charge")
    await rec("get", f"{BASE}/orders/so1/events?depth=everything")
    links = (await db_session.execute(select(AitoPaymentLink).order_by(AitoPaymentLink.id))).scalars().all()
    rec.done({"links": [{"id": x.id, "status": x.status, "amount": x.amount, "document_number": x.document_number, "document_kind": x.document_kind, "idempotency_key": x.idempotency_key} for x in links], "heimdall_created": created})


# --- 8. the public tracking page -----------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tracking_link_and_page(async_client, db_session, zoho, monkeypatch):
    rec = Recorder(async_client, monkeypatch, "tracking")
    doc = order(1, qty=3, packed=1)
    doc["reference_number"] = "1079"
    doc["delivery_method"] = "Pick Up"
    doc["packages"] = [{"package_id": "pk1", "package_number": "PKG-1", "status": "not_shipped", "shipment_id": ""}]
    zoho.add(doc, order(2, qty=1, shipped=1))
    zoho.stock = {"A": 1}
    await sync.run_pass(db_session)
    await sync.run_pass(db_session)
    await rec("get", f"{BASE}/orders/so1/tracking-link", label="no external URL yet")
    await _setting(db_session, "external_url", "https://shop.example/")
    r = await rec("get", f"{BASE}/orders/so1/tracking-link")
    token = r.json()["tracking_url"].rsplit("/", 1)[-1]
    TOKENS.append(token)
    await rec("get", f"{BASE}/orders/so1/tracking-link", label="same link again")
    await rec("get", f"{BASE}/orders/nope/tracking-link", label="unknown order")
    await rec("get", f"{BASE}/track/{token}")
    await rec("get", f"{BASE}/track/{token.lower()}", label="code in lower case")
    await rec("get", f"{BASE}/track/ZZZZZZ", label="unknown code")
    await rec("get", f"{BASE}/orders/so1/events?depth=everything", label="the view is logged")
    rec.done()
