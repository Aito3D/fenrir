"""Order-board campaign golden probe: every Order Board route, end to end over HTTP.

Drives the real FastAPI app through httpx's ASGI transport against a throw-away
SQLite file database. Zoho Books is a FAKE at the wire: ``zoho_service.transport``
(the service's test seam) is an ``httpx.MockTransport`` answered by the small
stateful ``Books`` below, so the real ZohoService and every order module run
unchanged and nothing can reach Books. The clock of the order modules is pinned
(see tools/probe_orders_lib.py): local day 2026-03-14, UTC day 2026-03-15.

Every step prints the HTTP status, the JSON body (or, for a PDF, its headers,
page count, text and sha256) and ``wire``: the ordered requests Books received
during that step (method, path, query, JSON body). A board in a body is cut down
to one line per order; steps that act on an order add that order's full row.

Parts, in order:
  A  the sync side: empty board, not connected, bounded passes, changed /
     shipped / deleted orders, stock, settings and their refusals, upstream
     failure, 429 back-off, the call ceiling.
  B  finished orders (list, detail stored / not stored / stale / not finished)
     and the invoice PDF.
  C  prep sheet, picklist preview / create / content, parcel, hand-over preview,
     hand-over (pickup and delivery, with and without credit), invoice (with and
     without credit), with their refusals, a concurrent write (409), upstream
     failures mid-sequence, a late failure (Books acted, then timed out), a
     429 during a hand-over, the shared call budget, Zoho not configured.
  D  the permission gate of all 15 routes: no token, a user without the orders
     permissions, a read-only user.
"""

import asyncio
import copy
import hashlib
import json
import re
import sys
from unittest.mock import patch

sys.path.insert(0, ".")
sys.path.insert(0, "tools")
import probe_orders_lib as lib  # noqa: E402

import pypdfium2 as pdfium  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from reportlab import rl_config  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.core.database import get_db  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.services.zoho import zoho_service  # noqa: E402

rl_config.invariant = 1  # a PDF without its creation time and random id: the bytes can be hashed

B = "/api/v1/order-board"
DAYS = (0, 1, 3, 5, 8, 12, 30, 60, 200, 400)
DETAIL_ONLY = ("line_items", "packages", "picklists", "invoices", "contact", "contact_person_details", "billing_address")


def ln(line_id, item, qty, *, rate=0.0, shipped=0, packed=0, invoiced=0, name=None, sku=None, **extra):
    return {
        "line_item_id": line_id, "item_id": item, "name": name or f"Thing {item}", "sku": f"SKU-{item}" if sku is None else sku,
        "rate": rate, "quantity": qty, "quantity_shipped": shipped, "quantity_packed": packed, "quantity_picked": 0,
        "quantity_cancelled": 0, "quantity_invoiced": invoiced, **extra,
    }


def so(n, lines, *, age=5, status="open", customer=None, **extra):
    return {
        "salesorder_id": f"so{n}", "salesorder_number": f"SO-{n:05d}", "customer_name": f"Customer {n}",
        "customer_id": customer or f"c{n}", "date": lib.day(-age), "status": status,
        "total": float(sum(x.get("rate", 0) * x["quantity"] for x in lines)) or 1000.0 * n, "currency_code": "XPF",
        "paid_status": "unpaid", "invoiced_status": "not_invoiced", "is_inclusive_tax": True,
        "line_items": lines, "packages": [], "picklists": [], "invoices": [], **extra,
    }


def order(n, *, age=5, status="open", qty=1, shipped=0, packed=0, invoiced=0, item="A", extra_lines=(), packages=()):
    """Part A's plain order: one line of ``item``."""
    doc = so(n, [ln(f"l{n}", item, qty, shipped=shipped, packed=packed, invoiced=invoiced), *extra_lines], age=age, status=status)
    doc["packages"] = list(packages)
    return doc


def purchase(n, *, status="open", item="B", qty=5):
    return {
        "purchaseorder_id": f"po{n}", "purchaseorder_number": f"PO-{n:04d}", "status": status,
        "billed_status": "to_be_billed", "received_status": "to_be_received", "quantity_yet_to_receive": qty,
        "last_modified_time": "2026-03-10T08:00:00-1000",
        "line_items": [{"item_id": item, "quantity": qty, "quantity_billed": 0, "quantity_received": 0, "quantity_cancelled": 0}],
    }


class Books:
    """Zoho Books, as far as the Order Board talks to it. Writes change the documents the way Books does."""

    def __init__(self):
        self.orders, self.purchases, self.picklists, self.packages, self.payments = {}, {}, {}, {}, {}
        self.items = {
            "A": {"stock_on_hand": 6, "brand": "eSUN", "track_inventory": True},
            "B": {"stock_on_hand": 0, "brand": "Marlow", "track_inventory": True},
            "C": {"stock_on_hand": 2.5, "brand": "Bambu Lab", "track_inventory": True},
            "S": {"stock_on_hand": 0, "brand": "", "track_inventory": False},
        }
        self.changed_payments: list[dict] = []
        self.meter = 0  # what zoho_service.calls_in_last_minute() answers
        self.down = None  # an answer every request gets (an outage, a 429)
        self.failures: list[dict] = []  # one-shot answers for the first request matching "on"
        self.hold = None  # a request (regex) parked until release()
        self.entered, self.gate = asyncio.Event(), asyncio.Event()
        self.serial = {"touch": 0, "pl": 0, "pk": 0, "sh": 0, "inv": 0}
        self.routes = [(m, re.compile(p), getattr(self, f)) for m, p, f in (
            ("GET", r"/salesorders", "_list_orders"),
            ("GET", r"/purchaseorders", "_list_purchases"),
            ("GET", r"/salesorders/([^/]+)", "_order"),
            ("GET", r"/purchaseorders/([^/]+)", "_purchase"),
            ("GET", r"/items", "_items"),
            ("GET", r"/customerpayments", "_payments"),
            ("GET", r"/picklists/editpage", "_picklist_prefill"),
            ("GET", r"/picklists/([^/]+)", "_picklist"),
            ("POST", r"/picklists", "_create_picklist"),
            ("PUT", r"/picklists/([^/]+)", "_update_picklist"),
            ("POST", r"/picklists/([^/]+)/setstatus", "_complete_picklist"),
            ("POST", r"/packages", "_create_package"),
            ("GET", r"/packages/([^/]+)", "_package"),
            ("POST", r"/shipmentorders", "_create_shipment"),
            ("POST", r"/shipmentorders/([^/]+)/status/delivered", "_delivered"),
            ("GET", r"/invoices/editpage/fromsalesorder", "_invoice_prefill"),
            ("POST", r"/invoices", "_create_invoice"),
            ("POST", r"/invoices/([^/]+)/status/sent", "_sent"),
            ("POST", r"/invoices/([^/]+)/credits", "_credits"),
            ("GET", r"/invoices/([^/]+)", "_invoice_pdf"),
        )]

    # --- probe controls ---------------------------------------------------------------------------------------

    def add(self, *docs):
        for doc in docs:
            if "salesorder_id" in doc:
                self.orders[doc["salesorder_id"]] = self.touch(doc)
            else:
                self.purchases[doc["purchaseorder_id"]] = doc

    def touch(self, doc):
        """Books keeps the order-level sums and stamps the change."""
        self.serial["touch"] += 1
        for field in ("quantity", "quantity_shipped", "quantity_packed", "quantity_invoiced"):
            doc[field] = sum(x.get(field) or 0 for x in doc["line_items"])
        n = self.serial["touch"]
        doc["last_modified_time"] = f"2026-03-12T{n // 3600:02d}:{n // 60 % 60:02d}:{n % 60:02d}-1000"
        return doc

    def fail(self, on, status, payload, headers=None, *, late=False):
        """The first request matching ``on`` ("METHOD path-regex") gets this answer: before Books acts, or
        (``late``) after it did, as when a timeout hits on the way back."""
        self.failures.append({"on": re.compile(on), "answer": (status, payload, headers or {}), "late": late})

    def park(self, on):
        self.hold, self.entered, self.gate = re.compile(on), asyncio.Event(), asyncio.Event()

    # --- the wire ---------------------------------------------------------------------------------------------

    async def __call__(self, method, path, query, body):
        if self.down:
            return self.down
        key = f"{method} {path}"
        failure = next((f for f in self.failures if f["on"].fullmatch(key)), None)
        if failure:
            self.failures.remove(failure)
            if not failure["late"]:
                return failure["answer"]
        if self.hold and self.hold.fullmatch(key):
            self.hold = None
            self.entered.set()
            await self.gate.wait()
        for route_method, pattern, handler in self.routes:
            found = pattern.fullmatch(path) if route_method == method else None
            if found:
                answer = handler(*found.groups(), query=query, body=body)
                return failure["answer"] if failure else answer
        return 599, {"message": f"### PROBE: Books has no route for {key}"}

    @staticmethod
    def _missing(what):
        return 404, {"code": 1002, "message": f"{what} does not exist."}

    def _list_orders(self, query, body):
        rows = [{k: v for k, v in d.items() if k not in DETAIL_ONLY} for d in self.orders.values()]
        return 200, {"salesorders": rows, "page_context": {"has_more_page": False}}

    def _list_purchases(self, query, body):
        rows = [{k: v for k, v in d.items() if k != "line_items"} for d in self.purchases.values()]
        return 200, {"purchaseorders": rows, "page_context": {"has_more_page": False}}

    def _order(self, order_id, query, body):
        return (200, {"salesorder": copy.deepcopy(self.orders[order_id])}) if order_id in self.orders else self._missing("Sales order")

    def _purchase(self, purchase_id, query, body):
        return 200, {"purchaseorder": copy.deepcopy(self.purchases[purchase_id])}

    def _items(self, query, body):
        return 200, {"items": [{"item_id": i, **self.items[i]} for i in query["item_ids"].split(",") if i in self.items]}

    def _payments(self, query, body):
        if "last_modified_time" in query:
            return 200, {"customerpayments": copy.deepcopy(self.changed_payments), "page_context": {"has_more_page": False}}
        return 200, {"customerpayments": copy.deepcopy(self.payments.get(query.get("customer_id"), []))}

    def _listed(self, line_id):
        return sum(r["quantity_to_be_picked"] for p in self.picklists.values() for r in p["line_items"] if r["so_line_item_id"] == line_id)

    def _picklist_prefill(self, query, body):
        doc = self.orders.get(query["salesorder_ids"])
        if doc is None:
            return self._missing("Sales order")
        rows = [
            {"salesorder_id": doc["salesorder_id"], "so_line_item_id": x["line_item_id"], "name": x["name"],
             "quantity_to_be_picked": x["quantity"] - x["quantity_cancelled"] - self._listed(x["line_item_id"]), "quantity_picked": 0}
            for x in doc["line_items"] if x.get("item_id")
        ]
        rows = [r for r in rows if r["quantity_to_be_picked"] > 0]
        if not rows:
            return 400, {"code": 36005, "message": "Nothing left to pick."}
        return 200, {"picklist": {"location_id": "loc1", "line_items": rows}}

    def _mirror_picklist(self, picklist):
        for doc in self.orders.values():
            for entry in doc["picklists"]:
                if entry["picklist_id"] == picklist["picklist_id"]:
                    entry["status"] = picklist["status"]
                    self.touch(doc)

    def _picklist(self, picklist_id, query, body):
        return (200, {"picklist": copy.deepcopy(self.picklists[picklist_id])}) if picklist_id in self.picklists else self._missing("Picklist")

    def _create_picklist(self, query, body):
        self.serial["pl"] += 1
        pid = f"pl{self.serial['pl']}"
        picklist = {
            "picklist_id": pid, "picklist_number": f"PL-{self.serial['pl']:05d}", "status": "yet_to_start", "date": body["date"],
            "location_id": body.get("location_id"), "group_by": body.get("group_by"),
            "line_items": [{**row, "line_item_id": f"{pid}-{row['so_line_item_id']}", "quantity_packed": 0} for row in body["line_items"]],
        }
        self.picklists[pid] = picklist
        doc = self.orders[body["line_items"][0]["salesorder_id"]]
        doc["picklists"].append({k: picklist[k] for k in ("picklist_id", "picklist_number", "status", "date")})
        self.touch(doc)
        return 201, {"picklist": copy.deepcopy(picklist)}

    def _update_picklist(self, picklist_id, query, body):
        picklist = self.picklists[picklist_id]
        sent = {row["line_item_id"]: row for row in body["line_items"]}
        picklist["line_items"] = [{**row, **sent[row["line_item_id"]]} for row in picklist["line_items"] if row["line_item_id"] in sent]
        picklist["status"] = "in_progress"
        self._mirror_picklist(picklist)
        return 200, {"picklist": copy.deepcopy(picklist)}

    def _complete_picklist(self, picklist_id, query, body):
        picklist = self.picklists[picklist_id]
        if picklist["status"] != "completed":
            for row in picklist["line_items"]:
                for doc in self.orders.values():
                    for x in doc["line_items"]:
                        if x["line_item_id"] == row["so_line_item_id"]:
                            x["quantity_picked"] += row["quantity_picked"]
        picklist["status"] = query.get("status")
        self._mirror_picklist(picklist)
        return 200, {"code": 0, "message": "Picklist status updated."}

    def _mirror_packages(self, doc):
        doc["packages"] = [
            {"package_id": p["package_id"], "package_number": p["package_number"], "status": p["status"], "shipment_id": p["shipment_id"],
             "date": p["date"], "quantity": sum(x["quantity"] for x in p["line_items"])}
            for p in self.packages.values() if p["salesorder_id"] == doc["salesorder_id"]
        ]
        self.touch(doc)

    def _create_package(self, query, body):
        doc = self.orders[query["salesorder_id"]]
        self.serial["pk"] += 1
        package = {
            "package_id": f"pk{self.serial['pk']}", "package_number": f"PKG-{self.serial['pk']:05d}", "salesorder_id": doc["salesorder_id"],
            "status": "not_shipped", "shipment_id": "", "date": body["date"],
            "line_items": [{"so_line_item_id": x["so_line_item_id"], "quantity": x["quantity"]} for x in body["line_items"]],
        }
        self.packages[package["package_id"]] = package
        for item in body["line_items"]:
            for x in doc["line_items"]:
                if x["line_item_id"] == item["so_line_item_id"]:
                    x["quantity_packed"] += item["quantity"]
            for picklist in self.picklists.values():
                for row in picklist["line_items"]:
                    if row["line_item_id"] == item.get("picklist_item_id"):
                        row["quantity_packed"] += item["quantity"]
        self._mirror_packages(doc)
        return 201, {"package": copy.deepcopy(package)}

    def _package(self, package_id, query, body):
        return (200, {"package": copy.deepcopy(self.packages[package_id])}) if package_id in self.packages else self._missing("Package")

    def _create_shipment(self, query, body):
        doc, package = self.orders[query["salesorder_id"]], self.packages[query["package_ids"]]
        self.serial["sh"] += 1
        package.update(status="shipped", shipment_id=f"sh{self.serial['sh']}")
        for item in package["line_items"]:
            for x in doc["line_items"]:
                if x["line_item_id"] == item["so_line_item_id"]:
                    x["quantity_shipped"] += item["quantity"]
        self._mirror_packages(doc)
        return 201, {"shipmentorder": {"shipment_id": package["shipment_id"], "shipment_number": f"SHP-{self.serial['sh']:05d}", **body}}

    def _delivered(self, shipment_id, query, body):
        package = next((p for p in self.packages.values() if p["shipment_id"] == shipment_id), None)
        if package is None:
            return self._missing("Shipment")
        package["status"] = "delivered"
        self._mirror_packages(self.orders[package["salesorder_id"]])
        return 200, {"code": 0, "message": "Shipment marked delivered."}

    def _invoice_prefill(self, query, body):
        doc = self.orders[query["salesorder_id"]]
        lines = [
            {"line_item_id": "", "salesorder_item_id": x["line_item_id"], "item_id": x.get("item_id") or "", "name": x["name"], "description": "",
             "rate": x.get("rate", 0), "quantity": x["quantity"] - x["quantity_invoiced"], "unit": "pcs", "tax_id": "t1",
             "discount": x.get("discount", 0), "item_total": 0}
            for x in doc["line_items"] if x["quantity"] - x["quantity_invoiced"] > 0
        ]
        if not lines:
            return 400, {"code": 36012, "message": "Nothing left to invoice."}
        return 200, {"invoice": {
            "customer_id": doc["customer_id"], "is_inclusive_tax": doc.get("is_inclusive_tax", True), "date": "2020-01-01",
            "discount": doc.get("discount", 0), "shipping_charge": doc.get("shipping_charge", 0), "adjustment": 0,
            "reference_number": doc.get("reference_number", ""), "notes": "", "terms": "", "template_id": "tpl",
            "salesorder_id": doc["salesorder_id"], "line_items": lines,
        }}

    def _create_invoice(self, query, body):
        first = body["line_items"][0]["salesorder_item_id"]
        doc = next(d for d in self.orders.values() if any(x["line_item_id"] == first for x in d["line_items"]))
        self.serial["inv"] += 1
        for item in body["line_items"]:
            for x in doc["line_items"]:
                if x["line_item_id"] == item["salesorder_item_id"]:
                    x["quantity_invoiced"] += item["quantity"]
        total = sum(item["rate"] * item["quantity"] for item in body["line_items"]) + float(body.get("shipping_charge") or 0)
        invoice = {
            "invoice_id": f"inv{self.serial['inv']}", "invoice_number": f"INV-{self.serial['inv']:05d}", "status": "draft",
            "date": body["date"], "due_date": lib.day(30), "total": total, "balance": total,
        }
        doc["invoices"].append(invoice)
        doc["invoiced_status"] = "invoiced" if all(x["quantity_invoiced"] >= x["quantity"] for x in doc["line_items"]) else "partially_invoiced"
        self.touch(doc)
        return 201, {"invoice": copy.deepcopy(invoice)}

    def _find_invoice(self, invoice_id):
        return next(((d, i) for d in self.orders.values() for i in d["invoices"] if i["invoice_id"] == invoice_id), (None, None))

    def _sent(self, invoice_id, query, body):
        doc, invoice = self._find_invoice(invoice_id)
        if invoice is None:
            return self._missing("Invoice")
        invoice["status"] = "sent"
        self.touch(doc)
        return 200, {"code": 0, "message": "Invoice status has been changed to Sent."}

    def _credits(self, invoice_id, query, body):
        doc, invoice = self._find_invoice(invoice_id)
        for applied in body["invoice_payments"]:
            for payment in self.payments.get(doc["customer_id"], []):
                if payment["payment_id"] == applied["payment_id"]:
                    payment["unused_amount"] = round(payment["unused_amount"] - applied["amount_applied"], 2)
            invoice["balance"] = round(invoice["balance"] - applied["amount_applied"], 2)
            for other in self.orders.values():  # the customer's pool, as every one of their orders states it
                if other["customer_id"] == doc["customer_id"] and other.get("contact"):
                    other["contact"]["unused_customer_credits"] = round(other["contact"]["unused_customer_credits"] - applied["amount_applied"], 2)
        if invoice["balance"] <= 0:
            invoice["status"] = "paid"
        doc["paid_status"] = "paid" if all(i["balance"] <= 0 for i in doc["invoices"]) else "partially_paid"
        self.touch(doc)
        return 200, {"code": 0, "message": "Credits have been applied to the invoice(s)."}

    def _invoice_pdf(self, invoice_id, query, body):
        if self._find_invoice(invoice_id)[1] is None:
            return self._missing("Invoice")
        return 200, f"%PDF-1.4 probe invoice {invoice_id} accept={query.get('accept')}\n%%EOF\n".encode()


def brief(row: dict) -> str:
    """One board row on one line: enough to see an order move through the steps."""
    pay = row.get("payment")
    return " ".join((
        row["number"], row["status"], f"age={row['age_days']}", f"core={row['is_core']}", f"ready={row['ready_ratio']:.3f}",
        "lines=" + ",".join(f"{x['id']}:{x['state']}:{x['remaining']:g}/{x['packable']:g}/{x['packed_waiting']:g}" for x in row["lines"]),
        f"picked={row['picked']:g}", f"packed={row['packed']:g}", f"unbilled={row['unbilled_units']:g}",
        "picklists=" + ",".join(f"{p['number']}:{p['status']}" for p in row["picklists"]),
        "packages=" + ",".join(f"{p['number']}:{p['status']}" for p in row["packages"]),
        "pay=" + (f"{pay['state']}/advance {pay['advance']:g}/left {pay['left']:g}" if pay else "none"),
        "prep=" + (f"by '{row['prep']['by']}'" if row.get("prep") else "none"),
    ))


def pdf_summary(content: bytes) -> dict:
    if not content.startswith(b"%PDF-"):
        return {"not_a_pdf": content[:80].decode("latin-1")}
    out = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    try:
        doc = pdfium.PdfDocument(content)
        out["pages"] = len(doc)
        out["text"] = [[t for t in (re.sub(r"\s+", " ", x).strip() for x in page.get_textpage().get_text_range().splitlines()) if t] for page in doc]
    except Exception:  # the fake Books' invoice "PDF" is a stub, not a document
        out["raw"] = content.decode("latin-1")
    return out


out: list = []  # filled step by step, so a probe that dies half-way still prints what it saw


async def main() -> None:
    books = Books()
    async with lib.temp_db() as sm:
        wire = lib.Wire(books)
        zoho_service.calls_in_last_minute = lambda: books.meter  # the shared per-minute budget, set by the probe
        pinned = lib.pin_clock()

        async def override_get_db():
            async with sm() as session:
                try:
                    yield session
                    await session.commit()
                except BaseException:
                    await session.rollback()
                    raise

        app.dependency_overrides[get_db] = override_get_db

        def cut(body, target):
            """Boards down to one line per order; the acted-on order's row in full."""
            if not isinstance(body, dict):
                return body
            if isinstance(body.get("board"), dict):
                return {**body, "board": cut(body["board"], target)}
            if isinstance(body.get("rows"), list) and all(isinstance(r, dict) and "lines" in r for r in body["rows"]):
                short = {**body, "rows": [brief(r) for r in body["rows"]]}
                if target:
                    short["row_of_" + target] = next((r for r in body["rows"] if r["id"] == target), None)
                return short
            return body

        def rec(step, r, *, full=False, target=None, before=()):
            ct = r.headers.get("content-type", "")
            entry = {"step": step, "status": r.status_code}
            if ct.startswith("application/pdf"):
                entry["headers"] = {h: r.headers.get(h) for h in ("content-type", "content-disposition", "cache-control")}
                entry["pdf"] = pdf_summary(r.content)
            elif not r.content:
                entry["body"] = None
            elif ct.startswith("application/json"):
                entry["body"] = r.json() if full else cut(r.json(), target)
            else:
                entry["body"] = f"### NOT JSON ({ct}): {r.text[:300]}"
            entry["wire"] = [*before, *wire.take()]
            out.append(entry)
            return r

        def note(step, **facts):
            out.append({"step": step, **facts})

        with (
            patch("backend.app.core.database.async_session", sm),
            patch("backend.app.core.auth.async_session", sm),
            patch("backend.app.main.async_session", sm),
        ):
            async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as c:
                note("00-clock", pinned_modules=pinned, local_day=lib.day(), utc_day=lib.UTC_NOW.date().isoformat())

                async def refresh(step, **kw):
                    return rec(step, await c.post(f"{B}/refresh"), **kw)

                # === A: the sync side ===============================================================================
                rec("A01-empty-board-zoho-not-connected", await c.get(B))
                rec("A02-default-settings", await c.get(f"{B}/settings"))
                await refresh("A03-refresh-not-connected-records-error")
                rec("A04-finished-list-empty-not-connected", await c.get(f"{B}/finished"))

                await lib.set_settings(sm, lib.ZOHO_SETTINGS)
                # 23 plain open orders + the interesting ones.
                books.add(*(order(n, age=DAYS[n % len(DAYS)], item="A" if n % 2 else "B") for n in range(1, 24)))
                books.add(
                    order(30, age=3, item="C", qty=1.5),
                    order(31, age=1, item="A", qty=2, packed=2, packages=[{"package_id": "pkx", "package_number": "PKG-00031", "status": "not_shipped", "date": lib.day()}]),
                    order(32, age=8, item="B", qty=2, invoiced=2),
                    order(33, age=12, item="A", qty=3, shipped=3),
                    order(34, age=5, status="draft"),
                    order(35, age=5, status="void"),
                    order(36, age=30, item="Z", qty=1, extra_lines=[ln("l36s", "S", 1, name="Main d'oeuvre", sku=""), ln("l36n", None, 1, name="Note")]),
                    purchase(1, item="B", qty=5),
                    purchase(2, item="B", qty=2, status="billed"),
                    purchase(3, item="Z", qty=1, status="partially_billed"),
                )
                await refresh("A05-first-pass-bounded-nothing-computed")
                await refresh("A06-second-pass-completes-board", full=True)
                rec("A07-read-board", await c.get(B))
                await refresh("A08-unchanged-pass-no-detail-calls")

                books.add(order(1, age=DAYS[1], item="A", qty=4), order(3, age=DAYS[3], item="A", qty=1, shipped=1))
                del books.orders["so5"]
                books.purchases["po1"]["status"] = "billed"
                books.items["A"]["stock_on_hand"] = 40
                await refresh("A09-changed-shipped-deleted-and-stock")
                rec("A10-finished-list-after-a-shipment", await c.get(f"{B}/finished"))

                rec("A11-save-settings-cleans-brands-rebuilds", await c.put(f"{B}/settings", json={"sync_enabled": True, "sync_minutes": 5, "max_age_days": 10, "core_brands": [" eSUN ", "esun", "Bambu Lab", "BAMBU LAB"]}))
                rec("A12-settings-read-back", await c.get(f"{B}/settings"))
                rec("A13-board-after-settings-no-zoho-call", await c.get(B))
                await refresh("A14-pass-after-age-limit")
                rec("A15-settings-age-zero-sync-off", await c.put(f"{B}/settings", json={"sync_enabled": False, "sync_minutes": 60, "max_age_days": 0, "core_brands": []}))
                rec("A16-board-sync-off", await c.get(B))
                await refresh("A17-pass-refetches-old-orders")
                await refresh("A18-pass-again")

                ok = {"sync_enabled": True, "sync_minutes": 15, "max_age_days": 365, "core_brands": ["eSUN"]}
                for label, body in (
                    ("bad-minutes", {**ok, "sync_minutes": 7}),
                    ("negative-age", {**ok, "max_age_days": -1}),
                    ("age-too-large", {**ok, "max_age_days": 3651}),
                    ("blank-brand", {**ok, "core_brands": ["eSUN", "  "]}),
                    ("long-brand", {**ok, "core_brands": ["x" * 61]}),
                    ("too-many-brands", {**ok, "core_brands": [f"b{i}" for i in range(31)]}),
                    ("missing-field", {"sync_enabled": True}),
                    ("not-an-object", [1, 2]),
                ):
                    rec(f"A19-settings-refused-{label}", await c.put(f"{B}/settings", json=body))
                rec("A20-settings-unchanged-after-refusals", await c.get(f"{B}/settings"))

                books.down = (500, {"code": 1000, "message": "Internal error"})
                await refresh("A21-upstream-failure-board-kept")
                books.down = None
                await refresh("A22-recovers")
                books.down = (429, {"code": 44, "message": "Too many requests"}, {"Retry-After": "120"})
                await refresh("A23-rate-limited")
                books.down = None
                await refresh("A24-refresh-during-back-off-sends-nothing")
                lib.clock.advance(121)
                await refresh("A25-back-off-over")

                books.add(*(order(n, age=3, item="C", qty=0.25) for n in range(40, 46)))
                books.meter = 30
                await refresh("A26-call-ceiling-details-wait")
                books.meter = 0
                await refresh("A27-ceiling-cleared")
                rec("A28-final-board-full", await c.get(B), full=True)

                # === B/C fixtures: a clean board with the orders the write steps act on ============================
                books.orders.clear()
                books.purchases.clear()
                await refresh("B01-everything-deleted-in-books")
                rec("B02-settings-for-the-write-steps", await c.put(f"{B}/settings", json=ok))
                books.items.update(
                    P={"stock_on_hand": 20, "brand": "eSUN", "track_inventory": True},
                    Q={"stock_on_hand": 1, "brand": "Marlow", "track_inventory": True},
                )
                person = [{"first_name": "Hina", "last_name": "Teriitahi", "email": "hina@example.pf", "phone": "40 12 34 56", "mobile": "87 11 22 33"}]
                books.add(
                    so(60, [ln("l60a", "P", 3, rate=500.0), ln("l60b", "Q", 2, rate=250.0, name="Cordage Marlow 8 mm")], age=4, customer="c60",
                       customer_name="Atelier Moana", reference_number="#1042", sales_channel_formatted="Shopify", delivery_method="PICK UP",
                       payment_terms_label="Net 30", estimate_id="est60", account_identifier="aito3d", marketplace_so_id="5551234",
                       contact={"unused_customer_credits": 800.0}, contact_person_details=person),
                    so(61, [ln("l61", "P", 2, rate=1000.0), ln("l61s", "", 1, rate=2000.0, name="Main d'oeuvre", sku="", product_type="service")],
                       age=3, delivery_method="Colissimo", reference_number="DEV26-2638"),
                    so(62, [ln("l62", "P", 4, rate=300.0)], age=2, delivery_method="PICK UP", shipping_charge=1500, contact={"unused_customer_credits": 500.0}),
                    so(63, [ln("l63", "P", 1, rate=700.0)], age=2, contact={"unused_customer_credits": 5000.0}),
                    so(64, [ln("l64", "P", 1, rate=400.0), ln("l64s", "", 1, rate=2000.0, name="Conception", sku="", product_type="service")], age=1),
                    so(65, [ln("l65", "P", 1, rate=300.0)], age=9, customer="c60", contact={"unused_customer_credits": 800.0}),
                    so(66, [ln("l66", "P", 3, rate=100.0)], age=1, contact={"unused_customer_credits": 150.0}),
                    so(70, [ln("l70", "P", 2, rate=450.0, shipped=2, invoiced=2)], age=20, paid_status="paid", invoiced_status="invoiced",
                       reference_number="#0990", invoices=[{"invoice_id": "inv900", "invoice_number": "INV-00900", "status": "paid", "date": lib.day(-19), "due_date": lib.day(11), "total": 900.0, "balance": 0.0}]),
                    so(71, [ln("l71", "Q", 1, rate=80.0, shipped=1)], age=25, paid_status="partially_paid",
                       invoices=[{"invoice_id": "inv901", "invoice_number": "INV-00901", "status": "overdue", "date": lib.day(-24), "due_date": lib.day(-3), "total": 80.0, "balance": 30.0}]),
                )
                books.payments = {
                    "c60": [{"payment_id": "pay1", "date": lib.day(-2), "unused_amount": 450.0}, {"payment_id": "pay2", "date": lib.day(-8), "unused_amount": 350.0},
                            {"payment_id": "", "date": lib.day(-9), "unused_amount": 99.0}, {"payment_id": "pay0", "date": lib.day(-10), "unused_amount": 0}],
                    "c62": [{"payment_id": "pay3", "date": lib.day(-1), "unused_amount": 500.0}],
                    "c63": [{"payment_id": "pay4", "date": lib.day(-1), "unused_amount": 5000.0}],
                    "c66": [{"payment_id": "pay5", "date": lib.day(-1), "unused_amount": 150.0}],
                }
                await refresh("B03-first-pass-of-the-new-orders")
                await refresh("B04-board-of-the-write-steps", full=True)

                # === B: finished orders, invoice PDF ================================================================
                rec("B05-finished-list-from-list-rows", await c.get(f"{B}/finished"))
                rec("B06-finished-detail-not-stored-is-fetched", await c.get(f"{B}/finished/so70"))
                rec("B07-finished-detail-stored-no-zoho-call", await c.get(f"{B}/finished/so70"))
                rec("B08-finished-list-shows-the-stored-payment", await c.get(f"{B}/finished"))
                rec("B09-finished-detail-of-an-open-order", await c.get(f"{B}/finished/so60"))
                rec("B10-finished-detail-unknown-order", await c.get(f"{B}/finished/nope"))
                books.orders["so70"]["paid_status"] = "partially_paid"
                books.touch(books.orders["so70"])
                await refresh("B11-pass-sees-the-finished-order-changed")
                rec("B12-finished-list-stale-detail-hides-payment", await c.get(f"{B}/finished"))
                rec("B13-finished-detail-stale-is-fetched-again", await c.get(f"{B}/finished/so70"))
                books.fail("GET /salesorders/so71", 500, {"message": "Internal error"})
                rec("B14-finished-detail-upstream-failure", await c.get(f"{B}/finished/so71"))
                books.fail("GET /salesorders/so71", 429, {"code": 44, "message": "Too many requests"}, {"Retry-After": "30"})
                rec("B15-finished-detail-rate-limited", await c.get(f"{B}/finished/so71"))
                rec("B16-finished-detail-during-back-off", await c.get(f"{B}/finished/so71"))
                lib.clock.advance(31)
                books.meter = 30
                rec("B17-finished-detail-call-budget-spent", await c.get(f"{B}/finished/so71"))
                books.meter = 0

                rec("B18-invoice-pdf-of-a-stored-order", await c.get(f"{B}/invoices/inv900/pdf"))
                rec("B19-invoice-pdf-not-on-a-stored-order", await c.get(f"{B}/invoices/inv901/pdf"))
                rec("B20-invoice-pdf-unknown", await c.get(f"{B}/invoices/nope/pdf"))
                books.fail("GET /invoices/inv900", 200, b"<html>login</html>")
                rec("B21-invoice-pdf-books-answers-html", await c.get(f"{B}/invoices/inv900/pdf"))
                books.fail("GET /invoices/inv900", 404, {"message": "Invoice does not exist."})
                rec("B22-invoice-pdf-gone-in-books", await c.get(f"{B}/invoices/inv900/pdf"))

                # === C: prep sheet, picklist, parcel, hand-over, invoice ============================================
                O = f"{B}/orders"
                rec("C01-prep-sheet-no-public-url-no-qr", await c.post(f"{O}/so60/prep-sheet"))
                await lib.set_settings(sm, {"external_url": " https://fenrir.example/ "})
                rec("C02-prep-sheet-everything-packable", await c.post(f"{O}/so60/prep-sheet"))
                rec("C03-board-shows-the-print-stamp", await c.get(B), target="so60")
                rec("C04-prep-sheet-unknown-order", await c.post(f"{O}/nope/prep-sheet"))
                rec("C05-prep-sheet-unknown-picklist", await c.post(f"{O}/so60/prep-sheet", params={"picklist_id": "nope"}))
                rec("C06-prep-sheet-empty-picklist-id", await c.post(f"{O}/so60/prep-sheet", params={"picklist_id": ""}))
                rec("C07-prep-sheet-of-a-finished-order", await c.post(f"{O}/so70/prep-sheet"))

                rec("C08-picklist-preview", await c.get(f"{O}/so60/picklist"))
                rec("C09-picklist-preview-unknown-order", await c.get(f"{O}/nope/picklist"))
                rec("C10-picklist-preview-finished-order", await c.get(f"{O}/so70/picklist"))
                for label, body in (
                    ("no-lines", {"lines": []}),
                    ("missing-lines", {}),
                    ("line-twice", {"lines": [{"line_id": "l60a", "quantity": 1}, {"line_id": "l60a", "quantity": 1}]}),
                    ("zero-quantity", {"lines": [{"line_id": "l60a", "quantity": 0}]}),
                    ("negative-quantity", {"lines": [{"line_id": "l60a", "quantity": -1}]}),
                    ("text-quantity", {"lines": [{"line_id": "l60a", "quantity": "two"}]}),
                    ("empty-line-id", {"lines": [{"line_id": "", "quantity": 1}]}),
                    ("unknown-line", {"lines": [{"line_id": "nope", "quantity": 1}]}),
                    ("line-of-another-order", {"lines": [{"line_id": "l61", "quantity": 1}]}),
                    ("too-many", {"lines": [{"line_id": "l60a", "quantity": 3}, {"line_id": "l60b", "quantity": 2}]}),
                    ("a-hair-too-many", {"lines": [{"line_id": "l60a", "quantity": 3.001}]}),
                ):
                    rec(f"C11-create-picklist-refused-{label}", await c.post(f"{O}/so60/picklists", json=body))
                rec("C12-create-picklist-unknown-order", await c.post(f"{O}/nope/picklists", json={"lines": [{"line_id": "l60a", "quantity": 1}]}))
                rec("C13-create-picklist", await c.post(f"{O}/so60/picklists", json={"lines": [{"line_id": "l60a", "quantity": 2}, {"line_id": "l60b", "quantity": 1}]}), target="so60")
                rec("C14-picklist-preview-while-one-is-open", await c.get(f"{O}/so60/picklist"))
                rec("C15-second-picklist-while-one-is-open", await c.post(f"{O}/so60/picklists", json={"lines": [{"line_id": "l60a", "quantity": 1}]}))
                rec("C16-picklist-content", await c.get(f"{O}/so60/picklists/pl1"))
                rec("C17-picklist-content-unknown-picklist", await c.get(f"{O}/so60/picklists/nope"))
                rec("C18-picklist-content-of-another-order", await c.get(f"{O}/so61/picklists/pl1"))
                rec("C19-picklist-content-unknown-order", await c.get(f"{O}/nope/picklists/pl1"))
                rec("C20-prep-sheet-of-the-picklist", await c.post(f"{O}/so60/prep-sheet", params={"picklist_id": "pl1"}))

                box = {"picklist_id": "pl1", "lines": [{"line_id": "l60a", "quantity": 1.5}, {"line_id": "l60b", "quantity": 1}]}
                for label, body in (
                    ("missing-picklist-id", {"lines": box["lines"]}),
                    ("unknown-picklist", {**box, "picklist_id": "nope"}),
                    ("unknown-line", {"picklist_id": "pl1", "lines": [{"line_id": "nope", "quantity": 1}]}),
                    ("more-than-picked", {"picklist_id": "pl1", "lines": [{"line_id": "l60a", "quantity": 2.5}]}),
                    ("zero-quantity", {"picklist_id": "pl1", "lines": [{"line_id": "l60a", "quantity": 0}]}),
                ):
                    rec(f"C21-create-parcel-refused-{label}", await c.post(f"{O}/so60/packages", json=body))
                rec("C22-create-parcel-unknown-order", await c.post(f"{O}/nope/packages", json=box))
                books.fail(r"POST /picklists/pl1/setstatus", 500, {"message": "Internal error"})
                rec("C23-create-parcel-books-fails-completing-the-picklist", await c.post(f"{O}/so60/packages", json=box), target="so60")
                rec("C24-create-parcel-retry-finishes-the-job", await c.post(f"{O}/so60/packages", json=box), target="so60")
                rec("C25-create-parcel-same-request-again", await c.post(f"{O}/so60/packages", json=box))
                rec("C26-picklist-content-once-boxed", await c.get(f"{O}/so60/picklists/pl1"))

                rec("C27-handover-preview", await c.get(f"{O}/so60/packages/pk1/handover"))
                rec("C28-handover-preview-unknown-package", await c.get(f"{O}/so60/packages/nope/handover"))
                rec("C29-handover-preview-unknown-order", await c.get(f"{O}/nope/packages/pk1/handover"))
                rec("C30-handover-preview-package-of-another-order", await c.get(f"{O}/so61/packages/pk1/handover"))
                books.fail("GET /packages/pk1", 500, {"message": "Internal error"})
                rec("C31-handover-preview-books-fails", await c.get(f"{O}/so60/packages/pk1/handover"))
                for label, body in (
                    ("bad-mode", {"mode": "courier", "apply_credit": True}),
                    ("missing-apply-credit", {"mode": "pickup"}),
                    ("no-body", None),
                ):
                    rec(f"C32-hand-over-refused-{label}", await c.post(f"{O}/so60/packages/pk1/handover", json=body))
                pickup_credit = {"mode": "pickup", "apply_credit": True}
                rec("C33-hand-over-unknown-package", await c.post(f"{O}/so60/packages/nope/handover", json=pickup_credit))
                rec("C34-hand-over-package-of-another-order", await c.post(f"{O}/so61/packages/pk1/handover", json=pickup_credit))
                rec("C35-hand-over-unknown-order", await c.post(f"{O}/nope/packages/pk1/handover", json=pickup_credit))
                rec("C36-hand-over-pickup-with-credit", await c.post(f"{O}/so60/packages/pk1/handover", json=pickup_credit), target="so60")
                rec("C37-hand-over-same-request-again", await c.post(f"{O}/so60/packages/pk1/handover", json=pickup_credit))
                rec("C38-handover-preview-once-handed-over", await c.get(f"{O}/so60/packages/pk1/handover"))
                await refresh("C39-pass-after-the-hand-over")
                await refresh("C40-pass-settles", target="so60")

                # a second picklist of the same order while another write on it is running
                books.park("POST /picklists")
                running = asyncio.create_task(c.post(f"{O}/so60/picklists", json={"lines": [{"line_id": "l60a", "quantity": 1.5}]}))
                await asyncio.wait_for(books.entered.wait(), 20)
                parked = wire.take()  # the parked request's own calls so far: printed with its answer below
                rec("C41-busy-invoice-while-a-picklist-is-being-created", await c.post(f"{O}/so60/invoice", json={"apply_credit": False}))
                rec("C42-busy-parcel", await c.post(f"{O}/so60/packages", json=box))
                rec("C43-busy-hand-over", await c.post(f"{O}/so60/packages/pk1/handover", json=pickup_credit))
                rec("C44-busy-second-picklist", await c.post(f"{O}/so60/picklists", json={"lines": [{"line_id": "l60a", "quantity": 1}]}))
                rec("C45-not-busy-reads-and-other-orders", await c.get(f"{O}/so61/picklist"))
                books.gate.set()
                rec("C46-the-parked-picklist-completes", await asyncio.wait_for(running, 20), target="so60", before=parked)
                books.fail("POST /packages", 504, {"message": "Gateway timeout"}, late=True)
                box2 = {"picklist_id": "pl2", "lines": [{"line_id": "l60a", "quantity": 1.5}]}
                rec("C47-create-parcel-books-acted-then-timed-out", await c.post(f"{O}/so60/packages", json=box2), target="so60")
                rec("C48-create-parcel-retry-is-not-repeated", await c.post(f"{O}/so60/packages", json=box2))
                rec("C49-hand-over-pickup-without-credit", await c.post(f"{O}/so60/packages/pk2/handover", json={"mode": "pickup", "apply_credit": False}), target="so60")

                # so61: delivery, the order's own method, a service line rides on the invoice, no credit
                rec("C50-so61-picklist", await c.post(f"{O}/so61/picklists", json={"lines": [{"line_id": "l61", "quantity": 2}]}))
                rec("C51-so61-parcel-entry-re-read-of-the-pending-copy", await c.post(f"{O}/so61/packages", json={"picklist_id": "pl3", "lines": [{"line_id": "l61", "quantity": 2}]}))
                rec("C52-so61-handover-preview", await c.get(f"{O}/so61/packages/pk3/handover"))
                rec("C53-so61-hand-over-delivery-without-credit", await c.post(f"{O}/so61/packages/pk3/handover", json={"mode": "delivery", "apply_credit": False}))
                rec("C54-finished-list-shows-so61", await c.get(f"{B}/finished"))
                rec("C55-finished-detail-so61-re-read-until-a-pass-updates-its-list-row", await c.get(f"{B}/finished/so61"))

                # so62: delivery with credit; a partial invoice of an order with a shipping charge is left to Books
                rec("C56-so62-picklist", await c.post(f"{O}/so62/picklists", json={"lines": [{"line_id": "l62", "quantity": 2}]}))
                rec("C57-so62-parcel", await c.post(f"{O}/so62/packages", json={"picklist_id": "pl4", "lines": [{"line_id": "l62", "quantity": 2}]}))
                rec("C58-so62-handover-preview-manual-invoice", await c.get(f"{O}/so62/packages/pk4/handover"))
                rec("C59-so62-hand-over-delivery-with-credit", await c.post(f"{O}/so62/packages/pk4/handover", json={"mode": "delivery", "apply_credit": True}), target="so62")
                rec("C60-so62-invoice-with-credit-still-manual", await c.post(f"{O}/so62/invoice", json={"apply_credit": True}))

                # so63: Books refuses the invoice in the middle of a hand-over; the invoice route finishes later
                rec("C61-so63-picklist", await c.post(f"{O}/so63/picklists", json={"lines": [{"line_id": "l63", "quantity": 1}]}))
                rec("C62-so63-parcel", await c.post(f"{O}/so63/packages", json={"picklist_id": "pl5", "lines": [{"line_id": "l63", "quantity": 1}]}))
                books.fail("POST /invoices", 400, {"code": 1038, "message": "Le client Customer 63 est inactif."})
                rec("C63-so63-hand-over-books-refuses-the-invoice", await c.post(f"{O}/so63/packages/pk5/handover", json=pickup_credit))
                rec("C64-so63-invoice-with-credit-off-the-board", await c.post(f"{O}/so63/invoice", json={"apply_credit": True}))
                rec("C65-so63-invoice-again-nothing-left", await c.post(f"{O}/so63/invoice", json={"apply_credit": True}))

                # so64: a service line is invoiced before anything ships; a draft then blocks the next invoice
                books.fail(r"POST /invoices/[^/]+/status/sent", 500, {"message": "Internal error"})
                rec("C66-so64-invoice-without-credit-mark-sent-fails", await c.post(f"{O}/so64/invoice", json={"apply_credit": False}), target="so64")
                rec("C67-so64-picklist", await c.post(f"{O}/so64/picklists", json={"lines": [{"line_id": "l64", "quantity": 1}]}))
                rec("C68-so64-parcel", await c.post(f"{O}/so64/packages", json={"picklist_id": "pl6", "lines": [{"line_id": "l64", "quantity": 1}]}))
                rec("C69-so64-handover-preview-draft-in-the-way", await c.get(f"{O}/so64/packages/pk6/handover"))
                rec("C70-so64-hand-over-draft-in-the-way", await c.post(f"{O}/so64/packages/pk6/handover", json={"mode": "pickup", "apply_credit": False}))

                # so66: 429 in the middle of a hand-over, the back-off, then the invoice route with credit
                rec("C71-so66-picklist", await c.post(f"{O}/so66/picklists", json={"lines": [{"line_id": "l66", "quantity": 1}]}))
                rec("C72-so66-parcel", await c.post(f"{O}/so66/packages", json={"picklist_id": "pl7", "lines": [{"line_id": "l66", "quantity": 1}]}))
                books.fail("GET /invoices/editpage/fromsalesorder", 429, {"code": 44, "message": "Too many requests"}, {"Retry-After": "120"})
                rec("C73-so66-hand-over-rate-limited-at-the-invoice", await c.post(f"{O}/so66/packages/pk7/handover", json={"mode": "pickup", "apply_credit": False}), target="so66")
                rec("C74-back-off-invoice", await c.post(f"{O}/so66/invoice", json={"apply_credit": True}))
                rec("C75-back-off-picklist-preview", await c.get(f"{O}/so65/picklist"))
                rec("C76-back-off-create-picklist", await c.post(f"{O}/so65/picklists", json={"lines": [{"line_id": "l65", "quantity": 1}]}))
                rec("C77-back-off-picklist-content", await c.get(f"{O}/so66/picklists/pl7"))
                rec("C78-back-off-handover-preview-unavailable", await c.get(f"{O}/so66/packages/pk7/handover"))
                rec("C79-back-off-prep-sheet-needs-no-zoho", await c.post(f"{O}/so65/prep-sheet"))
                await refresh("C80-back-off-refresh-sends-nothing")
                lib.clock.advance(121)
                rec("C81-so66-invoice-with-credit", await c.post(f"{O}/so66/invoice", json={"apply_credit": True}), target="so66")
                rec("C82-so66-invoice-again-nothing-left", await c.post(f"{O}/so66/invoice", json={"apply_credit": False}))
                books.fail("POST /shipmentorders", 429, {"code": 44, "message": "Too many requests"}, {"Retry-After": "60"})
                rec("C83-so62-second-parcel-picklist", await c.post(f"{O}/so62/picklists", json={"lines": [{"line_id": "l62", "quantity": 2}]}))
                rec("C84-so62-second-parcel", await c.post(f"{O}/so62/packages", json={"picklist_id": "pl8", "lines": [{"line_id": "l62", "quantity": 2}]}))
                rec("C85-so62-hand-over-rate-limited-at-the-shipment", await c.post(f"{O}/so62/packages/pk8/handover", json={"mode": "delivery", "apply_credit": True}))
                lib.clock.advance(61)
                books.fail("POST /shipmentorders", 400, {"code": 36023, "message": "Le colis PKG-00008 est déjà expédié."})
                rec("C86-so62-hand-over-books-refuses-the-shipment", await c.post(f"{O}/so62/packages/pk8/handover", json={"mode": "delivery", "apply_credit": True}))
                rec("C87-so62-hand-over-whole-order-invoiced-with-its-shipping-charge", await c.post(f"{O}/so62/packages/pk8/handover", json={"mode": "delivery", "apply_credit": True}))

                # the shared per-minute call budget is spent
                books.meter = 30
                rec("C88-budget-spent-picklist-preview", await c.get(f"{O}/so65/picklist"))
                rec("C89-budget-spent-create-picklist", await c.post(f"{O}/so65/picklists", json={"lines": [{"line_id": "l65", "quantity": 1}]}))
                rec("C90-budget-spent-invoice", await c.post(f"{O}/so65/invoice", json={"apply_credit": False}))
                books.meter = 0

                # a customer payment changed in Books: the pass re-reads that customer's orders
                books.changed_payments = [{"payment_id": "pay9", "customer_id": "c60", "last_modified_time": "2026-03-14T09:00:00-1000"}]
                books.orders["so65"]["contact"]["unused_customer_credits"] = 1234.0
                await refresh("C91-pass-after-a-customer-payment-changed")
                books.changed_payments = []
                await refresh("C92-pass-settles", full=True)
                rec("C93-finished-list-at-the-end", await c.get(f"{B}/finished"))

                # Zoho not configured any more
                await lib.set_settings(sm, {"zoho_refresh_token": None})
                rec("C94-not-configured-board", await c.get(B))
                rec("C95-not-configured-finished-list", await c.get(f"{B}/finished"))
                rec("C96-not-configured-finished-detail-stored", await c.get(f"{B}/finished/so61"))
                rec("C97-not-configured-finished-detail-not-stored", await c.get(f"{B}/finished/so71"))
                rec("C98-not-configured-picklist-preview", await c.get(f"{O}/so65/picklist"))
                rec("C99-not-configured-create-picklist", await c.post(f"{O}/so65/picklists", json={"lines": [{"line_id": "l65", "quantity": 1}]}))
                rec("C100-not-configured-invoice", await c.post(f"{O}/so65/invoice", json={"apply_credit": False}))
                rec("C101-not-configured-handover-preview", await c.get(f"{O}/so60/packages/pk2/handover"))
                rec("C102-not-configured-invoice-pdf", await c.get(f"{B}/invoices/inv900/pdf"))
                rec("C103-not-configured-prep-sheet", await c.post(f"{O}/so65/prep-sheet"))
                await refresh("C104-not-configured-refresh")
                await lib.set_settings(sm, {"zoho_refresh_token": "probe-refresh"})
                await refresh("C105-connected-again")

                # === D: who may call what ===========================================================================
                from backend.app.core.auth import create_access_token, get_password_hash
                from backend.app.models.group import Group
                from backend.app.models.settings import Settings
                from backend.app.models.user import User

                principals = {"none": [], "read": ["orders:read"], "both": ["orders:read", "orders:update"]}
                async with sm() as db:
                    db.add(Settings(key="auth_enabled", value="true"))
                    for name, perms in principals.items():
                        user = User(username=f"orders-{name}", password_hash=get_password_hash("password"), is_active=True)
                        user.groups.append(Group(name=f"orders-{name}", permissions=perms, is_system=False))
                        db.add(user)
                    await db.commit()
                tokens = {name: {"Authorization": f"Bearer {create_access_token(data={'sub': f'orders-{name}'})}"} for name in principals}
                tokens["no token"] = {}
                tokens["bad token"] = {"Authorization": "Bearer not-a-token"}
                line = {"lines": [{"line_id": "l65", "quantity": 1}]}
                gate = {}
                for method, path, body in (
                    ("GET", B, None),
                    ("GET", f"{B}/finished", None),
                    ("GET", f"{B}/finished/nope", None),
                    ("POST", f"{B}/refresh", None),
                    ("GET", f"{B}/settings", None),
                    ("PUT", f"{B}/settings", ok),
                    ("POST", f"{O}/nope/prep-sheet", None),
                    ("GET", f"{O}/nope/picklist", None),
                    ("POST", f"{O}/nope/picklists", line),
                    ("GET", f"{O}/nope/picklists/pl1", None),
                    ("POST", f"{O}/nope/packages", {"picklist_id": "pl1", **line}),
                    ("GET", f"{O}/nope/packages/pk1/handover", None),
                    ("POST", f"{O}/nope/packages/pk1/handover", pickup_credit),
                    ("POST", f"{O}/nope/invoice", {"apply_credit": False}),
                    ("GET", f"{B}/invoices/nope/pdf", None),
                ):
                    answers = {}
                    for who, headers in tokens.items():
                        r = await c.request(method, path, json=body, headers=headers)
                        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") and isinstance(r.json(), dict) else None
                        answers[who] = f"{r.status_code}" + (f" {detail}" if r.status_code >= 400 and isinstance(detail, str) else "")
                    gate[f"{method} {path}"] = answers
                note("D01-permission-gate-of-every-route", answers=gate, wire=wire.take())
                rec("D02-prep-sheet-as-a-read-only-user", await c.post(f"{O}/so65/prep-sheet", headers=tokens["read"]))
                rec("D03-the-stamp-names-who-printed", await c.get(B, headers=tokens["read"]))


def dump() -> str:
    text = json.dumps(out, indent=1, sort_keys=True, default=str, ensure_ascii=False)
    return re.sub(lib.SCRUB_STAMP, "<TIMESTAMP>", text)


try:
    asyncio.run(main())
except BaseException as e:  # stderr is discarded by the snapshot command: say it on stdout, and fail
    print(dump())
    print(f"### PROBE FAILURE after step {out[-1]['step'] if out else '-'}: {type(e).__name__}: {str(e)[:300]}")
    sys.exit(1)
lib.leak_check(dump())
print(dump())
