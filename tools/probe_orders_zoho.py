"""Order-board campaign golden probe: what the Order Board puts on the wire to Zoho Books.

Calls every ZohoService method the board uses (the order-only reads and writes,
plus the shared ones order code calls) on the real service, with the HTTP layer
replaced by ``httpx.MockTransport`` (``zoho_service.transport``, the service's
test seam). For each call it prints the exact requests sent (method, path as
escaped, query, JSON body) and what the method returned or raised for the
canned answer. Credentials are fake rows in a temp database; nothing can reach
Books.
"""

import asyncio
import json
import sys

sys.path.insert(0, ".")
sys.path.insert(0, "tools")
import probe_orders_lib as lib  # noqa: E402

from backend.app.services.zoho import zoho_service  # noqa: E402

PDF = b"%PDF-1.4 probe invoice\n%%EOF\n"
MORE = {"page_context": {"has_more_page": True}}
PAYMENT_ROW = {"payment_id": "pay1", "customer_id": "c1", "last_modified_time": "2026-03-01T08:00:00-1000", "amount": 5}


def cases(z, db):
    """(label, call, canned answers in order). An answer is (status, payload[, headers]); none left = 200 {}."""
    lines = [{"so_line_item_id": "l1", "quantity": 1.5, "picklist_item_id": "pl1-l1"}]
    picklist_body = {
        "date": "2026-03-14", "location_id": "loc1", "parent_entity": "salesorder", "group_by": "none",
        "line_items": [{"salesorder_id": "so1", "so_line_item_id": "l1", "quantity_to_be_picked": 1.5, "quantity_picked": 0}],
    }
    invoice_body = {"customer_id": "c1", "date": "2026-03-14", "line_items": [{"salesorder_item_id": "l1", "quantity": 2, "rate": 500.0}]}
    credits = [{"payment_id": "pay1", "amount_applied": 300.0}, {"payment_id": "pay2", "amount_applied": 12.5}]
    return [
        # --- reads -------------------------------------------------------------------------------------
        ("list_salesorders (two pages)", lambda: z.list_salesorders(db), [
            (200, {"salesorders": [{"salesorder_id": "1"}, {"salesorder_id": "2"}], **MORE}),
            (200, {"salesorders": [{"salesorder_id": "3"}], "page_context": {"has_more_page": False}}),
        ]),
        ("list_purchaseorders (null list)", lambda: z.list_purchaseorders(db), [(200, {"purchaseorders": None})]),
        ("get_salesorder (id escaped)", lambda: z.get_salesorder(db, "so/1 x?y"), [(200, {"salesorder": {"salesorder_id": "so1", "line_items": []}})]),
        ("get_salesorder (404)", lambda: z.get_salesorder(db, "nope"), [(404, {"code": 1002, "message": "Sales order does not exist."})]),
        ("get_purchaseorder (empty body)", lambda: z.get_purchaseorder(db, "460000000026049"), [(200, {})]),
        ("list_items_by_ids", lambda: z.list_items_by_ids(db, ["A", "B", "C"]), [(200, {"items": [{"item_id": "A", "stock_on_hand": 3}]})]),
        ("list_items_by_ids (no items key)", lambda: z.list_items_by_ids(db, ["A"]), [(200, {})]),
        ("books_salesorder_url_base", lambda: z.books_salesorder_url_base(db), []),
        ("books_invoice_url", lambda: z.books_invoice_url(db, "inv1"), []),
        ("books_invoice_url (empty id: the prefix)", lambda: z.books_invoice_url(db, ""), []),
        ("books_app_url", lambda: z.books_app_url(db, "est1"), []),
        ("list_customer_payments", lambda: z.list_customer_payments(db, "c1"), [(200, {"customerpayments": [{"payment_id": "pay1", "unused_amount": 300.0, "date": "2026-03-01"}]})]),
        ("list_customer_payments (no customer: no call)", lambda: z.list_customer_payments(db, ""), []),
        ("list_customer_payments (null list)", lambda: z.list_customer_payments(db, "c1"), [(200, {"customerpayments": None})]),
        ("list_customer_payments_modified_since (two pages)", lambda: modified_since(z, db), [
            (200, {"customerpayments": [PAYMENT_ROW, {"payment_id": 77, "customer_id": None}], **MORE}),
            (200, {"customerpayments": [{"payment_id": "pay3", "customer_id": "c2", "last_modified_time": "2026-03-02T08:00:00-1000"}]}),
        ]),
        ("list_customer_payments_modified_since (page cap: truncated)", lambda: modified_since(z, db), [(200, {"customerpayments": [PAYMENT_ROW], **MORE})] * 8),
        ("picklist_prefill", lambda: z.picklist_prefill(db, "so1"), [(200, {"picklist": {"location_id": "loc1", "line_items": [{"salesorder_id": "so1", "so_line_item_id": "l1", "quantity_to_be_picked": 2}]}})]),
        ("picklist_prefill (400: refused)", lambda: z.picklist_prefill(db, "so1"), [(400, {"code": 36005, "message": "Nothing to pick."})]),
        ("picklist_prefill (no picklist key)", lambda: z.picklist_prefill(db, "so1"), [(200, {})]),
        ("picklist_prefill (500)", lambda: z.picklist_prefill(db, "so1"), [(500, {"message": "boom"})]),
        ("get_picklist (id escaped)", lambda: z.get_picklist(db, "pl/1"), [(200, {"picklist": {"picklist_id": "pl1", "status": "yet_to_start"}})]),
        ("get_picklist (404)", lambda: z.get_picklist(db, "nope"), [(404, {"message": "Picklist does not exist."})]),
        ("get_picklist (no picklist key)", lambda: z.get_picklist(db, "pl1"), [(200, {})]),
        ("get_package (id escaped)", lambda: z.get_package(db, "pk/1"), [(200, {"package": {"package_id": "pk1", "status": "not_shipped"}})]),
        ("get_package (404, no message)", lambda: z.get_package(db, "nope"), [(404, {})]),
        ("invoice_prefill", lambda: z.invoice_prefill(db, "so1"), [(200, {"invoice": {"customer_id": "c1", "line_items": []}})]),
        ("invoice_prefill (400: refused)", lambda: z.invoice_prefill(db, "so1"), [(400, {"message": "Nothing to invoice."})]),
        ("invoice_prefill (no invoice key)", lambda: z.invoice_prefill(db, "so1"), [(200, {})]),
        ("get_invoice_pdf (id escaped)", lambda: z.get_invoice_pdf(db, "inv/1"), [(200, PDF)]),
        ("get_invoice_pdf (200 that is not a PDF)", lambda: z.get_invoice_pdf(db, "inv1"), [(200, b"<html>login</html>")]),
        ("get_invoice_pdf (404)", lambda: z.get_invoice_pdf(db, "nope"), [(404, {"message": "Invoice does not exist."})]),
        # --- writes ------------------------------------------------------------------------------------
        ("create_picklist", lambda: z.create_picklist(db, picklist_body), [(201, {"picklist": {"picklist_id": "pl1", "picklist_number": "PL-00001"}})]),
        ("create_picklist (no picklist key)", lambda: z.create_picklist(db, picklist_body), [(201, {})]),
        ("update_picklist (id escaped)", lambda: z.update_picklist(db, "pl/1", {"date": "2026-03-14", "line_items": [{"line_item_id": "pl1-l1", "quantity_to_be_picked": 1.5, "quantity_picked": 1.5}]}), [(200, {"picklist": {"picklist_id": "pl1", "status": "in_progress"}})]),
        ("complete_picklist (id escaped)", lambda: z.complete_picklist(db, "pl/1"), [(200, {"message": "done"})]),
        ("create_package", lambda: z.create_package(db, "so1", date="2026-03-14", line_items=lines), [(201, {"package": {"package_id": "pk1", "package_number": "PKG-00001"}})]),
        ("create_package (no package key)", lambda: z.create_package(db, "so1", date="2026-03-14", line_items=lines), [(201, {})]),
        ("create_shipment (shipmentorder key)", lambda: z.create_shipment(db, "so1", "pk1", date="2026-03-14", delivery_method="PICK UP"), [(201, {"shipmentorder": {"shipment_id": "sh1"}})]),
        ("create_shipment (shipment_order key)", lambda: z.create_shipment(db, "so1", "pk1", date="2026-03-14", delivery_method="Aito3D"), [(201, {"shipment_order": {"shipment_id": "sh2"}})]),
        ("create_shipment (neither key)", lambda: z.create_shipment(db, "so1", "pk1", date="2026-03-14", delivery_method="Aito3D"), [(201, {})]),
        ("mark_shipment_delivered (id escaped)", lambda: z.mark_shipment_delivered(db, "sh/1"), [(200, {})]),
        ("create_invoice", lambda: z.create_invoice(db, invoice_body), [(201, {"invoice": {"invoice_id": "inv1", "invoice_number": "INV-1", "total": 1000.0, "balance": 1000.0}})]),
        ("create_invoice (no invoice key)", lambda: z.create_invoice(db, invoice_body), [(201, {})]),
        ("mark_invoice_sent (id escaped)", lambda: z.mark_invoice_sent(db, "inv/1"), [(200, {})]),
        ("apply_invoice_credits (id escaped)", lambda: z.apply_invoice_credits(db, "inv/1", credits), [(200, {})]),
        # --- how a write's failure surfaces --------------------------------------------------------------
        ("create_package (400 with Books' reason)", lambda: z.create_package(db, "so1", date="2026-03-14", line_items=lines), [(400, {"code": 36023, "message": "Quantity exceeds what was ordered."})]),
        ("create_shipment (429, Retry-After 120)", lambda: z.create_shipment(db, "so1", "pk1", date="2026-03-14", delivery_method="PICK UP"), [(429, {"code": 44, "message": "slow down"}, {"Retry-After": "120"})]),
        ("create_invoice (500)", lambda: z.create_invoice(db, invoice_body), [(500, {"message": "internal"})]),
        ("mark_invoice_sent (403)", lambda: z.mark_invoice_sent(db, "inv1"), [(403, {"message": "not allowed"})]),
        ("apply_invoice_credits (200 that is not JSON)", lambda: z.apply_invoice_credits(db, "inv1", credits), [(200, b"<html>")]),
        ("mark_shipment_delivered (401 twice: token refreshed once)", lambda: z.mark_shipment_delivered(db, "sh1"), [(401, {"message": "invalid token"}), (401, {"message": "invalid token"})]),
    ]


async def modified_since(z, db):
    rows = await z.list_customer_payments_modified_since(db, "2026-03-01T08:00:00-1000")
    return {"rows": list(rows), "truncated": rows.truncated}


def shown(value):
    if isinstance(value, bytes):
        return f"<{len(value)} bytes: {value[:24]!r}>"
    return value


async def main():
    out = {}
    async with lib.temp_db() as sessions:
        await lib.set_settings(sessions, lib.ZOHO_SETTINGS)
        answers: list = []
        wire = lib.Wire(lambda method, path, query, body: answers.pop(0) if answers else (200, {}))
        async with sessions() as db:
            for label, call, canned in cases(zoho_service, db):
                if label in out:
                    raise SystemExit(f"duplicate case {label}")
                answers[:] = canned
                entry = {}
                try:
                    entry["returned"] = shown(await call())
                except Exception as e:  # the exception class and message are the method's contract
                    entry["raised"] = f"{type(e).__name__}: {e}"
                    for attr in ("retry_after", "code", "retry_after_raw"):
                        if hasattr(e, attr):
                            entry[attr] = getattr(e, attr)
                entry["sent"] = wire.take()
                entry["answers_left_unread"] = len(answers)
                out[label] = entry
            await lib.set_settings(sessions, {"zoho_refresh_token": None})
            for label, call in (
                ("not configured: get_salesorder", lambda: zoho_service.get_salesorder(db, "so1")),
                ("not configured: books_salesorder_url_base", lambda: zoho_service.books_salesorder_url_base(db)),
                ("not configured: create_invoice", lambda: zoho_service.create_invoice(db, {})),
                ("not configured: is_configured", lambda: zoho_service.is_configured(db)),
            ):
                try:
                    out[label] = {"returned": await call(), "sent": wire.take()}
                except Exception as e:
                    out[label] = {"raised": f"{type(e).__name__}: {e}", "sent": wire.take()}
    text = json.dumps(out, indent=1, sort_keys=False, default=str)
    lib.leak_check(text)
    print(text)


asyncio.run(main())
