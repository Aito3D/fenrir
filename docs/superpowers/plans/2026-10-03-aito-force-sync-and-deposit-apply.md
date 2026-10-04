# Aito force sync, deposit apply, post-invoice deposit link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-card "Force Zoho sync" with a per-step report, an "Apply deposit" modal on the invoice row, stop deposit collection once a card is invoiced, and drop the hold gesture on the client name.

**Architecture:** Two new backend services (`aito_force_sync.py`, `aito_deposit_apply.py`) behind thin routes in `routes/aito.py`; the post-invoice changes are small edits to existing payment code. Frontend adds two modals (`ForceSyncModal`, `ApplyDepositModal`), one pure helper (`depositPrefill.ts`), one menu row and one invoice-row icon.

**Tech Stack:** FastAPI + SQLAlchemy async (pytest, Zoho/Heimdall stubbed by monkeypatch), React 19 + TanStack Query + Vitest/Testing Library, i18n in 15 locales.

**Spec:** `docs/superpowers/specs/2026-10-03-aito-force-sync-and-deposit-apply-design.md`

## Global Constraints

- Work only in the worktree `.claude/worktrees/aito-sync-and-deposit` (branch `aito-sync-and-deposit`). Never `git stash`; never `git add -A` (static/ and `.coverage` are tracked); never run `npm run build` except in Task 8 (it dirties `static/`).
- Python via `./venv/bin/python3`; line length 120; Python 3.10 target (no `datetime.UTC`).
- Run vitest from `frontend/` (`cd frontend && npx vitest run <file>`), one file per command.
- No live Zoho/Heimdall calls in tests or dev: stub every `zoho_service` / `heimdall_service` method touched.
- No new `Permission`: reads ride `AITO_READ`, writes `AITO_UPDATE`.
- Every new i18n key gets a real translation in all 15 locales (en, de, es, fr, it, ja, ko, nl, pt-BR, ru, sv, tr, uk, zh-CN, zh-TW). `{{count}}` only with `_one/_other` keys. Grep the `aito` namespace before adding a key (duplicates are a TS error).
- Exporting a helper from a `.tsx` component trips `react-refresh/only-export-components` — helpers go in `.ts` files.
- Route count in `backend/tests/unit/test_aito_permissions.py`: today 56 total / `WRITE_ROUTES` 36. After this plan: 59 total / 38 write (+force-sync write, +invoice-deposits GET read-only, +apply write).
- Literal routes register before parameterised siblings in the same router.

## Review Focus

1. **Apply amount above what Books now says** (deposit spent elsewhere between modal open and submit) → server re-reads and 409s `amount_too_high`; the modal shows the message and stays open. Test in Task 2.
2. **Retainer id from another customer/quote** posted by hand → 404, nothing applied. Test in Task 2.
3. **Force sync while Zoho returns 429 mid-way** → that step `failed`, later Zoho steps `skipped`, payment-links step still runs. Test in Task 3.
4. **Force sync with the worker not serving** (sync disabled / Zoho unconfigured) → quote step `failed` with `worker_unavailable`, never hangs. Test in Task 3.
5. **Invoiced card with a terminal deposit tap in flight** → Deposit due block stays until the tap settles. Test in Task 4.

---

### Task 1: Deposit collection stops once a card is invoiced (backend)

**Files:**
- Modify: `backend/app/api/routes/aito.py` (create-invoice route `create_invoice`, ~line 2548–2720: after `project.quote_invoiced = True` is committed)
- Modify: `backend/app/api/routes/aito_payments.py` (`start_terminal_payment_route`, `record_manual_payment_route`)
- Modify: `backend/app/services/aito_manual_payments.py` (`refresh_after_payment`, quote branch)
- Modify: `backend/app/services/aito_payment_links.py` (`_became_paid`)
- Test: `backend/tests/unit/test_aito_invoiced_deposit_lockdown.py` (new)

**Interfaces:**
- Produces: `aito_manual_payments.settle_invoiced_deposits(db, project) -> None` (best-effort; used by `refresh_after_payment` and nothing else).

- [ ] **Step 1: Write the failing tests**

```python
"""Once a card is invoiced its quote deposit can no longer be collected from
the panel, and a deposit that lands anyway goes onto the invoice at once."""

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_manual_payments, aito_payment_links
from backend.app.services.zoho import zoho_service


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x", "board_column": "finish", "position": 0, "status": "active",
        "client_id": "z1", "quote_id": "EST1", "quote_number": "DEV26-1", "quote_invoiced": True,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.mark.asyncio
async def test_manual_quote_payment_on_invoiced_card_is_refused(async_client, db_session, monkeypatch):
    p = await _project(db_session)

    async def resolve(*_a, **_k):  # never reached
        raise AssertionError("document must not be resolved")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/manual-payment",
        json={"document_kind": "quote", "document_id": "EST1", "mode": "cash", "amount": 1000},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "quote_invoiced"


@pytest.mark.asyncio
async def test_terminal_quote_payment_on_invoiced_card_is_refused(async_client, db_session, monkeypatch):
    p = await _project(db_session)

    async def resolve(*_a, **_k):
        raise AssertionError("document must not be resolved")

    monkeypatch.setattr("backend.app.api.routes.aito_payments.resolve_document", resolve)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/terminal-payment",
        json={"document_kind": "quote", "document_id": "EST1", "amount": 1000},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "quote_invoiced"


@pytest.mark.asyncio
async def test_quote_payment_refresh_settles_the_open_invoice(db_session, monkeypatch):
    p = await _project(db_session)
    settled: list[str] = []

    async def fake_sync_project(db, project, *a, **k):
        return None

    async def list_project_invoices(db, estimate_id, customer_id):
        return [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": "2026-10-10"}]

    async def fake_settle(db, project_id, quote_id, invoice, quote_number=None):
        settled.append(invoice["id"])
        return {**invoice, "balance": 0.0, "status": "paid"}, 0.0

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync_project)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_with_deposits", fake_settle)

    await aito_manual_payments.refresh_after_payment(db_session, p.id, "quote")

    assert settled == ["INV1"]
    await db_session.refresh(p)
    assert (p.invoice_status, p.invoice_balance) == ("paid", 0.0)


@pytest.mark.asyncio
async def test_quote_payment_refresh_leaves_uninvoiced_card_alone(db_session, monkeypatch):
    p = await _project(db_session, quote_invoiced=False)

    async def fake_sync_project(db, project, *a, **k):
        return None

    async def boom(*_a, **_k):
        raise AssertionError("no invoice read for an uninvoiced card")

    monkeypatch.setattr("backend.app.services.aito_quote_sync.sync_project", fake_sync_project)
    monkeypatch.setattr(zoho_service, "list_project_invoices", boom)
    await aito_manual_payments.refresh_after_payment(db_session, p.id, "quote")


@pytest.mark.asyncio
async def test_paid_quote_link_on_invoiced_card_runs_the_refresh(db_session, monkeypatch):
    from backend.app.models.aito_payment_link import AitoPaymentLink

    p = await _project(db_session)
    row = AitoPaymentLink(
        project_id=p.id, idempotency_key="k1", reference="DEV26-1", document_kind="quote",
        amount=7000, expires_on="2026-12-31", status="paid",
    )
    db_session.add(row)
    await db_session.commit()
    calls: list[tuple[int, str]] = []

    async def fake_refresh(db, project_id, kind):
        calls.append((project_id, kind))

    async def fake_accept(*_a, **_k):
        return None

    monkeypatch.setattr(aito_manual_payments, "refresh_after_payment", fake_refresh)
    monkeypatch.setattr("backend.app.services.aito_quote_status.accept_quote", fake_accept)
    from datetime import datetime

    await aito_payment_links._became_paid(db_session, row, now=datetime(2026, 10, 3))
    assert calls == [(p.id, "quote")]


@pytest.mark.asyncio
async def test_create_invoice_reconciles_the_card_links_at_once(async_client, db_session, monkeypatch):
    """Spy-level: the create route calls reconcile_payment_links for this card
    with force=True after flipping quote_invoiced. Reuse the create-invoice
    happy-path stubs from test_aito_invoice_create.py (copy its `books` fake
    setup into this test verbatim) and add:"""
    calls: list[dict] = []

    async def fake_reconcile(db, **kw):
        calls.append(kw)
        return 1

    monkeypatch.setattr("backend.app.api.routes.aito.reconcile_payment_links", fake_reconcile)
    # ... create-invoice happy path from test_aito_invoice_create.py ...
    # assert any(c.get("only_project_id") == project_id and c.get("force") for c in calls)
```

For the last test, open `backend/tests/unit/test_aito_invoice_create.py`, find its simplest passing happy-path test (the one asserting a 200 from `POST /api/v1/aito/{id}/invoice`), copy its arrange block into this test body in place of the `# ...` comment, and make the final assertion real:
`assert any(c.get("only_project_id") == pid and c.get("force") is True for c in calls)`.

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_invoiced_deposit_lockdown.py -v -p no:xdist`
Expected: the two 409 tests FAIL (422/201 instead), the refresh tests FAIL (no settle), the link test FAILS (`calls == []`), the create test FAILS (`calls` empty).

- [ ] **Step 3: Refuse quote-kind counter payments on an invoiced card**

In `aito_payments.py`, in both `start_terminal_payment_route` and `record_manual_payment_route`, directly after `project = await _get_active_project_or_404(db, project_id)`:

```python
    if body.document_kind == "quote" and project.quote_invoiced:
        # The deposit is moot once the job is billed: collect on the invoice.
        raise _refuse(409, "quote_invoiced", "This quote is invoiced: collect the invoice balance instead")
```

- [ ] **Step 4: Settle on a quote payment for an invoiced card**

In `aito_manual_payments.py` add above `refresh_after_payment`:

```python
async def settle_invoiced_deposits(db: AsyncSession, project: AitoProject) -> None:
    """A deposit paid AFTER the invoice was raised: spend it on the invoice now
    rather than at the hourly sweep. Same rules as the sweep (only this quote's
    own deposits, newest invoice only). Raises like the Zoho calls it makes;
    the caller's best-effort wrapper owns the logging."""
    from backend.app.services.aito_invoice_sweep import settle_with_deposits

    if not (project.quote_invoiced and project.quote_id):
        return
    invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
    if not invoices or float(invoices[0].get("balance") or 0) <= 0:
        return
    fresh, remaining = await settle_with_deposits(
        db, project.id, project.quote_id, invoices[0], project.quote_number
    )
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_due_date = fresh.get("due_date") or None
    if remaining is not None:
        project.customer_credit_total = remaining
```

`settle_with_deposits` must be looked up through the module at call time (the test patches `aito_invoice_sweep.settle_with_deposits`): use `from backend.app.services import aito_invoice_sweep` inside the function and call `aito_invoice_sweep.settle_with_deposits(...)` instead of the `from … import settle_with_deposits` line above.

In `refresh_after_payment`'s `else:` (quote) branch, after `await sync_project(db, project)` and before its `await db.commit()`:

```python
            await settle_invoiced_deposits(db, project)
```

Also make `sync_project` resolvable for the test patch: replace the branch's `from backend.app.services.aito_quote_sync import sync_project` + `await sync_project(db, project)` with `from backend.app.services import aito_quote_sync` + `await aito_quote_sync.sync_project(db, project)`.

- [ ] **Step 5: Run the quote-link refresh from `_became_paid`**

In `aito_payment_links.py` `_became_paid`, replace the tail:

```python
    if kind == "invoice":
        await _after_invoice_paid(db, project_id)
```

with:

```python
    if kind == "invoice":
        await _after_invoice_paid(db, project_id)
    else:
        project = await db.get(AitoProject, project_id)
        if project is not None and project.quote_invoiced:
            # Paid in the window between Create invoice and the link's cancel:
            # put the money on the invoice now, not at the hourly sweep.
            from backend.app.services import aito_manual_payments

            await aito_manual_payments.refresh_after_payment(db, project_id, "quote")
```

- [ ] **Step 6: Cancel the deposit link right after Create invoice**

In `routes/aito.py` `create_invoice`, after the commit that persists `project.quote_invoiced = True` (find the `await db.commit()` that follows line ~2664), add:

```python
    # The deposit link is moot now (wanted_link → None for an invoiced card);
    # cancel it immediately rather than on the loop's next pass, so the client
    # cannot pay a deposit on a job that already has an invoice. Best-effort:
    # the invoice exists, a Heimdall hiccup must not turn this into an error.
    try:
        await reconcile_payment_links(db, only_project_id=project.id, force=True)
    except Exception as exc:  # noqa: BLE001 — see above
        logger.warning("Deposit link cancel after invoicing project %s failed: %s", project.id, exc)
```

If the route re-reads `project` attributes after this point, add `await db.refresh(project)` after the try block (reconcile commits).

- [ ] **Step 7: Run the tests and the neighbours**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_invoiced_deposit_lockdown.py backend/tests/unit/test_aito_manual_payments.py backend/tests/unit/test_aito_manual_payment_api.py backend/tests/unit/test_aito_payment_links.py backend/tests/unit/test_aito_invoice_create.py -v -n 6`
Expected: all PASS. If an existing payment-link test now sees an extra refresh call for a quote link, the fixture's card has `quote_invoiced=True` by accident — check before changing the test.

- [ ] **Step 8: Lint + commit**

```bash
ruff check backend/ && ruff format backend/app backend/tests/unit/test_aito_invoiced_deposit_lockdown.py
git add backend/app/api/routes/aito.py backend/app/api/routes/aito_payments.py backend/app/services/aito_manual_payments.py backend/app/services/aito_payment_links.py backend/tests/unit/test_aito_invoiced_deposit_lockdown.py
git commit -m "feat(aito): stop deposit collection once a card is invoiced, settle late deposits at once"
```

---

### Task 2: Apply-deposit service and routes (backend)

**Files:**
- Create: `backend/app/services/aito_deposit_apply.py`
- Modify: `backend/app/schemas/aito.py` (3 schemas)
- Modify: `backend/app/api/routes/aito.py` (2 routes, placed right after `get_retainers`)
- Modify: `backend/tests/unit/test_aito_permissions.py` (counts + classification)
- Test: `backend/tests/unit/test_aito_deposit_apply.py` (new)

**Interfaces:**
- Consumes: `aito_invoice_create.customer_credits(db, estimate) -> list[RetainerCredit]`, `share_out(credits, balance)`, `aito_invoice_sweep.linked_credits(estimate, credits, quote_number)`, `zoho_service.{get_estimate, list_project_invoices, apply_invoice_credits, get_invoice}`, `aito_customer_credit.read_customer_credit(db, customer_id)`.
- Produces:
  - `async def project_deposits(db, project) -> tuple[dict | None, list[RetainerCredit]]` (newest invoice row or None, linked credits with `applicable > 0`).
  - `async def apply_deposit(db, project, *, invoice_id: str, retainer_id: str, amount: float, actor_name: str | None) -> dict` (returns the re-read invoice dict). Raises `DepositNotFound`, `DepositAmountTooHigh`.
  - Routes `GET /aito/{id}/invoice-deposits` (name `get_invoice_deposits`) → `AitoInvoiceDepositsResponse`; `POST /aito/{id}/invoice-deposits/apply` (name `apply_invoice_deposit`) body `AitoApplyDepositRequest` → `AitoInvoiceResponse`.

- [ ] **Step 1: Schemas** (append to `backend/app/schemas/aito.py` near `AitoInvoiceResponse`)

```python
class AitoDepositCredit(BaseModel):
    id: str
    number: str
    applicable: float
    total: float


class AitoInvoiceDepositsInvoice(BaseModel):
    id: str
    number: str
    balance: float
    currency_code: str


class AitoInvoiceDepositsResponse(BaseModel):
    """This quote's own unspent deposits and the invoice they could go on.
    `invoice` is null when the card has no open invoice to pay."""

    invoice: AitoInvoiceDepositsInvoice | None
    deposits: list[AitoDepositCredit]


class AitoApplyDepositRequest(BaseModel):
    invoice_id: str = Field(min_length=1, max_length=64)
    retainer_id: str = Field(min_length=1, max_length=64)
    amount: float = Field(gt=0)
```

(`Field` is already imported in that module — check; add to the pydantic import if not.)

- [ ] **Step 2: Write the failing tests**

```python
"""Operator-driven deposit → invoice application (the invoice row's button)."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import zoho_service


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x", "board_column": "finish", "position": 0, "status": "active",
        "client_id": "z1", "quote_id": "EST1", "quote_number": "DEV26-1", "quote_invoiced": True,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _invoice(balance: float) -> dict:
    return {"id": "INV1", "number": "FA-1", "date": "2026-10-01", "due_date": "2026-10-31", "total": 14000.0,
            "balance": balance, "currency_code": "XPF", "status": "draft" if balance else "paid"}


class _Books:
    def __init__(self, monkeypatch, *, balance=14000.0, payments=None, linked=("RET1",), fresh_balance=7000.0):
        self.applied: list[tuple[str, list[dict]]] = []

        async def get_estimate(db, estimate_id):
            return {"estimate_id": "EST1", "customer_id": "z1", "retainerinvoices": [
                {"retainerinvoice_id": r, "retainerinvoice_number": f"RET-{r}", "status": "paid", "total": 7000.0}
                for r in linked]}

        async def list_customer_payments(db, customer_id):
            return list(payments if payments is not None else [
                {"payment_id": "P1", "payment_number": "1", "retainerinvoice_id": "RET1", "amount": 7000.0,
                 "unused_amount": 7000.0, "date": "2026-09-01"}])

        async def list_customer_retainers(db, customer_id):
            return [{"retainerinvoice_id": "RET1", "retainerinvoice_number": "RET-RET1", "reference_number": ""},
                    {"retainerinvoice_id": "RET9", "retainerinvoice_number": "RET-RET9", "reference_number": ""}]

        async def list_project_invoices(db, estimate_id, customer_id):
            return [_invoice(balance)]

        async def apply_invoice_credits(db, invoice_id, invoice_payments):
            self.applied.append((invoice_id, invoice_payments))

        async def get_invoice(db, invoice_id):
            return _invoice(fresh_balance)

        async def books_invoice_url(db, invoice_id):
            return "https://books/INV1"

        for name, fn in {
            "get_estimate": get_estimate, "list_customer_payments": list_customer_payments,
            "list_customer_retainers": list_customer_retainers, "list_project_invoices": list_project_invoices,
            "apply_invoice_credits": apply_invoice_credits, "get_invoice": get_invoice,
            "books_invoice_url": books_invoice_url,
        }.items():
            monkeypatch.setattr(zoho_service, name, fn)


@pytest.mark.asyncio
async def test_lists_the_quotes_own_deposits_and_the_open_invoice(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    _Books(monkeypatch, payments=[
        {"payment_id": "P1", "payment_number": "1", "retainerinvoice_id": "RET1", "amount": 7000.0,
         "unused_amount": 7000.0, "date": "2026-09-01"},
        {"payment_id": "P9", "payment_number": "9", "retainerinvoice_id": "RET9", "amount": 500.0,
         "unused_amount": 500.0, "date": "2026-08-01"},
    ])
    r = await async_client.get(f"/api/v1/aito/{p.id}/invoice-deposits")
    assert r.status_code == 200
    body = r.json()
    assert body["invoice"] == {"id": "INV1", "number": "FA-1", "balance": 14000.0, "currency_code": "XPF"}
    assert [d["id"] for d in body["deposits"]] == ["RET1"]  # RET9 is another job's
    assert body["deposits"][0]["applicable"] == 7000.0


@pytest.mark.asyncio
async def test_uninvoiced_card_has_nothing(async_client, db_session, monkeypatch):
    p = await _project(db_session, quote_invoiced=False)
    r = await async_client.get(f"/api/v1/aito/{p.id}/invoice-deposits")
    assert r.json() == {"invoice": None, "deposits": []}


@pytest.mark.asyncio
async def test_applies_the_chosen_amount_and_records_it(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 200, r.text
    assert books.applied == [("INV1", [{"payment_id": "P1", "amount_applied": 5000.0}])]
    assert r.json()["balance"] == 7000.0
    events = (await db_session.execute(
        select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "invoice.deposit_applied")
    )).scalars().all()
    assert events[0].detail == {"retainer_number": "RET-RET1", "invoice_number": "FA-1", "amount": 5000.0,
                                "source": "manual"}
    await db_session.refresh(p)
    assert p.invoice_balance == 7000.0


@pytest.mark.asyncio
async def test_amount_above_what_books_now_allows_is_refused(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch, balance=3000.0)  # invoice shrank since the modal opened
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 5000},
    )
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "amount_too_high"
    assert books.applied == []


@pytest.mark.asyncio
async def test_retainer_of_another_job_is_404(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    books = _Books(monkeypatch)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET9", "amount": 100},
    )
    assert r.status_code == 404
    assert books.applied == []


@pytest.mark.asyncio
async def test_stale_invoice_id_is_404(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    _Books(monkeypatch)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV-OLD", "retainer_id": "RET1", "amount": 100},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_zero_amount_is_422(async_client, db_session, monkeypatch):
    p = await _project(db_session)
    r = await async_client.post(
        f"/api/v1/aito/{p.id}/invoice-deposits/apply",
        json={"invoice_id": "INV1", "retainer_id": "RET1", "amount": 0},
    )
    assert r.status_code == 422
```

- [ ] **Step 3: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_deposit_apply.py -v -p no:xdist`
Expected: FAIL (404 route not found / import errors).

- [ ] **Step 4: Service**

`backend/app/services/aito_deposit_apply.py`:

```python
"""Spend this quote's own deposit on its open invoice, by hand.

The hourly sweep (aito_invoice_sweep.settle_with_deposits) does this
automatically and always as much as it can; this is the operator's version:
now, and for the amount they choose. Same eligibility rule as the sweep
(`linked_credits`), and every figure is re-read from Books at apply time —
the client's numbers only say what the operator MEANT, never what is true."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_events
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.aito_invoice_create import RetainerCredit, customer_credits, share_out
from backend.app.services.aito_invoice_sweep import linked_credits
from backend.app.services.zoho import zoho_service

# Books keeps cents; a client-side float may differ in the last digit.
_CENT = 0.005


class DepositNotFound(Exception):
    pass


class DepositAmountTooHigh(Exception):
    def __init__(self, cap: float):
        super().__init__(f"At most {cap:.2f} can be applied")
        self.cap = cap


async def project_deposits(db: AsyncSession, project: AitoProject) -> tuple[dict | None, list[RetainerCredit]]:
    """(newest invoice or None, this quote's spendable deposits oldest first)."""
    if not (project.quote_id and project.quote_invoiced):
        return None, []
    invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
    if not invoices:
        return None, []
    estimate = await zoho_service.get_estimate(db, project.quote_id)
    credits = linked_credits(estimate, await customer_credits(db, estimate), project.quote_number)
    return invoices[0], [c for c in credits if c.applicable > 0]


async def apply_deposit(
    db: AsyncSession,
    project: AitoProject,
    *,
    invoice_id: str,
    retainer_id: str,
    amount: float,
    actor_name: str | None,
) -> dict:
    invoice, credits = await project_deposits(db, project)
    if invoice is None or str(invoice.get("id")) != invoice_id:
        raise DepositNotFound("That invoice is not this project's open invoice")
    credit = next((c for c in credits if c.id == retainer_id), None)
    if credit is None:
        raise DepositNotFound("That deposit is not one of this quote's")
    cap = min(float(invoice.get("balance") or 0), credit.applicable)
    if amount > cap + _CENT:
        raise DepositAmountTooHigh(cap)
    amount = min(amount, cap)

    [(_, payments)] = share_out([credit], amount)
    await zoho_service.apply_invoice_credits(db, invoice_id, payments)
    await aito_events.record(
        db,
        project.id,
        "invoice.deposit_applied",
        actor_class="user",
        actor_name=actor_name,
        subject_type="project",
        subject_id=project.id,
        detail={
            "retainer_number": credit.number,
            "invoice_number": str(invoice.get("number") or ""),
            "amount": round(amount, 2),
            "source": "manual",
        },
    )
    fresh = await zoho_service.get_invoice(db, invoice_id) or invoice
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_due_date = fresh.get("due_date") or None
    credit_total = await read_customer_credit(db, project.client_id)
    if credit_total is not None:
        project.customer_credit_total = credit_total
    await db.commit()
    return fresh
```

Check `aito_events.record`'s signature for the user-actor keyword (grep an existing `actor_class="user"` call in `routes/aito.py` and copy its exact keywords — e.g. `actor_name=` vs `actor=`). Adjust the call to match; the test asserts only `detail`.

- [ ] **Step 5: Routes** (in `routes/aito.py`, directly after `get_retainers`; import the service names and schemas at the top with the others)

```python
@router.get("/{project_id}/invoice-deposits", response_model=AitoInvoiceDepositsResponse)
async def get_invoice_deposits(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
) -> AitoInvoiceDepositsResponse:
    """What the invoice row's Apply-deposit button offers: this quote's own
    unspent deposits and the open invoice. Live, like get_invoice."""
    project = await _get_active_project_or_404(db, project_id)
    try:
        invoice, credits = await project_deposits(db, project)
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito deposit lookup failed for project %s: %s", project_id, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    return AitoInvoiceDepositsResponse(
        invoice=None
        if invoice is None
        else AitoInvoiceDepositsInvoice(
            id=str(invoice["id"]),
            number=str(invoice.get("number") or invoice["id"]),
            balance=float(invoice.get("balance") or 0),
            currency_code=str(invoice.get("currency_code") or ""),
        ),
        deposits=[AitoDepositCredit(id=c.id, number=c.number, applicable=c.applicable, total=c.total) for c in credits],
    )


@router.post("/{project_id}/invoice-deposits/apply", response_model=AitoInvoiceResponse)
async def apply_invoice_deposit(
    project_id: int,
    payload: AitoApplyDepositRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
) -> AitoInvoiceResponse:
    """Spend part or all of one of this quote's deposits on its open invoice.
    Every figure is re-read from Books; see aito_deposit_apply."""
    project = await _get_active_project_or_404(db, project_id)
    try:
        fresh = await apply_deposit(
            db,
            project,
            invoice_id=payload.invoice_id,
            retainer_id=payload.retainer_id,
            amount=payload.amount,
            actor_name=current_user.username if current_user else None,
        )
        invoices = await zoho_service.list_project_invoices(db, project.quote_id or "", project.client_id or "")
        url = await zoho_service.books_invoice_url(db, payload.invoice_id)
    except DepositNotFound as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except DepositAmountTooHigh as e:
        raise HTTPException(
            status_code=409, detail={"code": "amount_too_high", "message": str(e), "cap": round(e.cap, 2)}
        ) from e
    except ZohoRateLimited as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito deposit apply failed for project %s: %s", project_id, e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    return AitoInvoiceResponse(**fresh, url=url, invoice_count=len(invoices) or 1)
```

`AitoInvoiceResponse(**fresh, …)` mirrors `get_invoice`; if `fresh` (a `get_invoice` row) carries extra keys the schema rejects, build it from the same keys `get_invoice` uses (`list_project_invoices` rows are already normalised — prefer `next(i for i in invoices if i["id"] == payload.invoice_id)` as the source and fall back to `fresh`). Verify against `zoho_service.get_invoice`'s return shape before choosing. Also check that `ZohoRateLimited` is imported in `routes/aito.py` (add to the zoho import if not).

- [ ] **Step 6: Permission sweep**

In `test_aito_permissions.py`:
- add to `WRITE_ROUTES`: `("apply_invoice_deposit", "post", f"/api/v1/aito/{_MISSING_ID}/invoice-deposits/apply", {"invoice_id": "i", "retainer_id": "r", "amount": 1}),`
- add `"get_invoice_deposits"` to `_READ_ONLY_ROUTE_NAMES`
- `len(WRITE_ROUTES) == 37` (message text too), total `len(aito_routes) == 58`.

- [ ] **Step 7: Run**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_deposit_apply.py backend/tests/unit/test_aito_permissions.py -v -n 4`
Expected: PASS.

- [ ] **Step 8: Lint + commit**

```bash
ruff check backend/ && ruff format backend/app backend/tests/unit/test_aito_deposit_apply.py backend/tests/unit/test_aito_permissions.py
git add backend/app/services/aito_deposit_apply.py backend/app/schemas/aito.py backend/app/api/routes/aito.py backend/tests/unit/test_aito_deposit_apply.py backend/tests/unit/test_aito_permissions.py
git commit -m "feat(aito): apply a quote deposit to its invoice by hand"
```

---

### Task 3: Force-sync service and route (backend)

**Files:**
- Create: `backend/app/services/aito_force_sync.py`
- Modify: `backend/app/schemas/aito.py` (2 schemas)
- Modify: `backend/app/services/aito_events.py` (`KINDS`: `"project.force_synced": "detail"`)
- Modify: `backend/app/api/routes/aito.py` (route next to `sync_project_now`, plus rate-limit bucket constants next to `_PAYMENT_LINK_REFRESH_*`)
- Modify: `backend/tests/unit/test_aito_permissions.py`
- Test: `backend/tests/unit/test_aito_force_sync.py` (new)

**Interfaces:**
- Consumes: `aito_quote_sync.flush_and_wait(project_id) -> bool`, `aito_quote_sync._arm_rate_limit_throttle(e)`, `aito_customer_credit.read_customer_credit`, `aito_invoice_sweep.settle_with_deposits`, `aito_payment_links.reconcile_payment_links`, `heimdall_service.is_configured(db)`.
- Produces:
  - `@dataclass StepResult(key: str, outcome: str, detail: dict)`; outcomes `"in_sync" | "fixed" | "failed" | "skipped"`; keys `"quote" | "credit" | "invoice" | "payment_links"` in that order.
  - `async def run_force_sync(db, project, *, quote_queued: bool, quote_before: dict) -> list[StepResult]`
  - `def quote_snapshot(project) -> dict`
  - Route `POST /aito/{id}/force-sync` (name `force_sync_project`) → `AitoForceSyncReport {steps: [{key, outcome, detail}]}`.

**Spec deviation (deliberate, note it in the spec's Implementation notes at Task 8):** step `credit` refreshes `customer_credit_total` only. `retainer_paid_total` is the quote worker's figure (computed inside `sync_project` with its `needed` short-circuit); step `quote` already refreshes it for a pushable card, and for an invoiced card it drives nothing (`wanted_link` is None). Recomputing it here with different rules would flip-flop against the worker.

- [ ] **Step 1: Schemas**

```python
class AitoForceSyncStep(BaseModel):
    key: Literal["quote", "credit", "invoice", "payment_links"]
    outcome: Literal["in_sync", "fixed", "failed", "skipped"]
    detail: dict[str, Any] = {}


class AitoForceSyncReport(BaseModel):
    steps: list[AitoForceSyncStep]
```

(check `Literal`/`Any` imports in the schema module).

- [ ] **Step 2: Write the failing tests**

```python
"""POST /aito/{id}/force-sync: check every Zoho-backed part of a card, fix
what drifted, report per step."""

import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_force_sync, aito_quote_sync
from backend.app.services.heimdall import heimdall_service
from backend.app.services.zoho import ZohoRateLimited, zoho_service


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x", "board_column": "finish", "position": 0, "status": "active",
        "client_id": "z1", "quote_id": "EST1", "quote_number": "DEV26-1", "quote_invoiced": True,
        "quote_sync_state": "locked", "quote_total": 14000.0, "customer_credit_total": 0.0,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@pytest.fixture
def stubs(monkeypatch):
    """Default: everything in sync, Heimdall not configured."""
    state = {"credit": 0.0, "invoices": [], "flush": True, "settled": None, "reconciled": []}

    async def flush_and_wait(project_id, *a, **k):
        return state["flush"]

    async def read_customer_credit(db, customer_id, cache=None):
        if isinstance(state["credit"], Exception):
            raise state["credit"]
        return state["credit"]

    async def list_project_invoices(db, estimate_id, customer_id):
        return state["invoices"]

    async def settle(db, project_id, quote_id, invoice, quote_number=None):
        return (state["settled"] or invoice), 0.0

    async def is_configured(db):
        return False

    async def reconcile(db, **kw):
        state["reconciled"].append(kw)
        return 1

    monkeypatch.setattr(aito_quote_sync, "flush_and_wait", flush_and_wait)
    monkeypatch.setattr(aito_quote_sync, "can_flush", lambda: True)
    monkeypatch.setattr("backend.app.services.aito_force_sync.read_customer_credit", read_customer_credit)
    monkeypatch.setattr(zoho_service, "list_project_invoices", list_project_invoices)
    monkeypatch.setattr("backend.app.services.aito_invoice_sweep.settle_with_deposits", settle)
    monkeypatch.setattr(heimdall_service, "is_configured", is_configured)
    monkeypatch.setattr("backend.app.services.aito_payment_links.reconcile_payment_links", reconcile)
    return state


def _by_key(body):
    return {s["key"]: s for s in body["steps"]}


@pytest.mark.asyncio
async def test_everything_in_sync(async_client, db_session, stubs):
    p = await _project(db_session)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 200, r.text
    steps = _by_key(r.json())
    assert [s["key"] for s in r.json()["steps"]] == ["quote", "credit", "invoice", "payment_links"]
    assert steps["quote"]["outcome"] == "in_sync"
    assert steps["credit"]["outcome"] == "in_sync"
    assert steps["invoice"]["outcome"] == "in_sync"
    assert steps["payment_links"] == {"key": "payment_links", "outcome": "skipped",
                                      "detail": {"reason": "not_configured"}}


@pytest.mark.asyncio
async def test_credit_drift_is_fixed(async_client, db_session, stubs):
    p = await _project(db_session, customer_credit_total=500.0)
    stubs["credit"] = 7000.0
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["credit"] == {"key": "credit", "outcome": "fixed",
                                           "detail": {"before": 500.0, "after": 7000.0}}
    await db_session.refresh(p)
    assert p.customer_credit_total == 7000.0


@pytest.mark.asyncio
async def test_deposit_applied_to_invoice_is_fixed(async_client, db_session, stubs):
    p = await _project(db_session)
    stubs["invoices"] = [{"id": "INV1", "number": "FA-1", "balance": 7000.0, "status": "draft", "due_date": ""}]
    stubs["settled"] = {"id": "INV1", "number": "FA-1", "balance": 0.0, "status": "paid", "due_date": ""}
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["invoice"]["outcome"] == "fixed"
    assert _by_key(r.json())["invoice"]["detail"] == {"number": "FA-1", "balance_before": 7000.0, "balance_after": 0.0}


@pytest.mark.asyncio
async def test_worker_unavailable_fails_the_quote_step_only(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session, quote_sync_state="idle", quote_invoiced=False)
    monkeypatch.setattr(aito_quote_sync, "can_flush", lambda: False)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["quote"] == {"key": "quote", "outcome": "failed", "detail": {"reason": "worker_unavailable"}}
    assert steps["credit"]["outcome"] == "in_sync"
    assert steps["invoice"] == {"key": "invoice", "outcome": "skipped", "detail": {"reason": "not_invoiced"}}


@pytest.mark.asyncio
async def test_rate_limit_skips_the_remaining_zoho_steps(async_client, db_session, stubs, monkeypatch):
    p = await _project(db_session)
    stubs["credit"] = ZohoRateLimited(30.0)
    armed: list = []
    monkeypatch.setattr(aito_quote_sync, "_arm_rate_limit_throttle", lambda e: armed.append(e))

    async def heimdall_on(db):
        return True

    monkeypatch.setattr(heimdall_service, "is_configured", heimdall_on)
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["credit"] == {"key": "credit", "outcome": "failed", "detail": {"reason": "rate_limited"}}
    assert steps["invoice"] == {"key": "invoice", "outcome": "skipped", "detail": {"reason": "rate_limited"}}
    assert steps["payment_links"]["outcome"] in ("in_sync", "fixed")  # Heimdall still runs
    assert armed and stubs["reconciled"]


@pytest.mark.asyncio
async def test_unmanaged_card_skips_the_quote(async_client, db_session, stubs):
    p = await _project(db_session, quote_sync_state="unmanaged")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert _by_key(r.json())["quote"] == {"key": "quote", "outcome": "skipped", "detail": {"reason": "unmanaged"}}


@pytest.mark.asyncio
async def test_no_quote_skips_every_zoho_step(async_client, db_session, stubs):
    p = await _project(db_session, quote_id=None, quote_number=None, quote_invoiced=False, quote_sync_state="idle")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    steps = _by_key(r.json())
    assert steps["quote"]["detail"] == {"reason": "no_quote"}
    assert steps["invoice"]["outcome"] == "skipped"


@pytest.mark.asyncio
async def test_trashed_card_is_404(async_client, db_session, stubs):
    p = await _project(db_session, status="deleted")
    r = await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_records_one_event(async_client, db_session, stubs):
    from sqlalchemy import select

    from backend.app.models.aito_event import AitoEvent

    p = await _project(db_session)
    await async_client.post(f"/api/v1/aito/{p.id}/force-sync")
    rows = (await db_session.execute(
        select(AitoEvent).where(AitoEvent.project_id == p.id, AitoEvent.kind == "project.force_synced")
    )).scalars().all()
    assert len(rows) == 1
    assert rows[0].detail["steps"]["quote"] == "in_sync"
```

Check `ZohoRateLimited`'s constructor (`grep -n "class ZohoRateLimited" -A8 backend/app/services/zoho.py`) and build the instance the way its own tests do.

- [ ] **Step 3: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_force_sync.py -v -p no:xdist`
Expected: FAIL (route missing).

- [ ] **Step 4: Service**

`backend/app/services/aito_force_sync.py`:

```python
"""The ⋯ menu's "Force Zoho sync": every Zoho-backed part of one card,
checked and repaired now, with a per-step report.

Nothing here writes to Books on its own authority. The quote push is the
worker's (marked pending by the route, then ``flush_and_wait``), the deposit
application is the sweep's ``settle_with_deposits``, the links are
``reconcile_payment_links`` — so every guard those already own still applies.
Each step is isolated; a Zoho 429 stops the remaining ZOHO steps (no point
deepening the shared throttle) but not Heimdall's."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_invoice_sweep, aito_payment_links, aito_quote_sync
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.heimdall import heimdall_service
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)


@dataclass
class StepResult:
    key: str
    outcome: str
    detail: dict = field(default_factory=dict)


def quote_snapshot(project: AitoProject) -> dict:
    return {
        "total": project.quote_total,
        "status": project.quote_status,
        "state": project.quote_sync_state,
        "error": project.quote_sync_error,
    }


async def _quote_step(db: AsyncSession, project: AitoProject, *, queued: bool, before: dict) -> StepResult:
    if not project.quote_id and not queued:
        return StepResult("quote", "skipped", {"reason": "no_quote"})
    if before["state"] == "unmanaged":
        return StepResult("quote", "skipped", {"reason": "unmanaged"})
    if not aito_quote_sync.can_flush():
        return StepResult("quote", "failed", {"reason": "worker_unavailable"})
    if not await aito_quote_sync.flush_and_wait(project.id):
        return StepResult("quote", "failed", {"reason": "timeout"})
    await db.refresh(project)  # the worker committed in its own session
    after = quote_snapshot(project)
    if after["state"] == "error" or (after["state"] == "locked" and not project.quote_invoiced and after["error"]):
        return StepResult("quote", "failed", {"reason": "refused", "message": after["error"] or ""})
    changed = {k: {"before": before[k], "after": after[k]} for k in ("total", "status") if before[k] != after[k]}
    return StepResult("quote", "fixed", changed) if changed else StepResult("quote", "in_sync")


async def _credit_step(db: AsyncSession, project: AitoProject) -> StepResult:
    if not project.client_id:
        return StepResult("credit", "skipped", {"reason": "no_client"})
    before = project.customer_credit_total
    after = await read_customer_credit(db, project.client_id)
    if after is None:
        return StepResult("credit", "failed", {"reason": "unreachable"})
    if before is not None and abs(before - after) < 0.005:
        return StepResult("credit", "in_sync")
    project.customer_credit_total = after
    await db.commit()
    return StepResult("credit", "fixed", {"before": before, "after": after})


async def _invoice_step(db: AsyncSession, project: AitoProject) -> StepResult:
    if not project.quote_id or not project.quote_invoiced:
        return StepResult("invoice", "skipped", {"reason": "not_invoiced"})
    invoices = await zoho_service.list_project_invoices(db, project.quote_id, project.client_id or "")
    if not invoices:
        return StepResult("invoice", "in_sync")
    newest = invoices[0]
    fresh = newest
    remaining = None
    if float(newest.get("balance") or 0) > 0:
        fresh, remaining = await aito_invoice_sweep.settle_with_deposits(
            db, project.id, project.quote_id, newest, project.quote_number
        )
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_due_date = fresh.get("due_date") or None
    if remaining is not None:
        project.customer_credit_total = remaining
    await db.commit()
    before, after = float(newest.get("balance") or 0), float(fresh.get("balance") or 0)
    if after < before:
        return StepResult(
            "invoice",
            "fixed",
            {"number": str(newest.get("number") or ""), "balance_before": before, "balance_after": after},
        )
    return StepResult("invoice", "in_sync")


async def _link_rows(db: AsyncSession, project_id: int) -> list[tuple]:
    rows = (
        await db.execute(
            select(AitoPaymentLink).where(
                AitoPaymentLink.project_id == project_id, AitoPaymentLink.superseded_at.is_(None)
            )
        )
    ).scalars()
    return sorted((r.id, r.document_kind, r.status, r.amount, r.heimdall_id, r.sync_error) for r in rows)


async def _links_step(db: AsyncSession, project: AitoProject) -> StepResult:
    if not await heimdall_service.is_configured(db):
        return StepResult("payment_links", "skipped", {"reason": "not_configured"})
    before = await _link_rows(db, project.id)
    await aito_payment_links.reconcile_payment_links(db, only_project_id=project.id, force=True)
    after = await _link_rows(db, project.id)
    errors = [row[5] for row in after if row[5]]
    if errors:
        return StepResult("payment_links", "failed", {"reason": "upstream", "message": errors[0]})
    return StepResult("payment_links", "fixed" if after != before else "in_sync")


async def run_force_sync(db: AsyncSession, project: AitoProject, *, quote_queued: bool, quote_before: dict) -> list[StepResult]:
    results: list[StepResult] = []
    throttled = False
    zoho_steps = (
        lambda: _quote_step(db, project, queued=quote_queued, before=quote_before),
        lambda: _credit_step(db, project),
        lambda: _invoice_step(db, project),
    )
    keys = ("quote", "credit", "invoice")
    for key, step in zip(keys, zoho_steps):
        if throttled:
            results.append(StepResult(key, "skipped", {"reason": "rate_limited"}))
            continue
        try:
            results.append(await step())
        except ZohoRateLimited as e:
            aito_quote_sync._arm_rate_limit_throttle(e)
            throttled = True
            results.append(StepResult(key, "failed", {"reason": "rate_limited"}))
        except ZohoNotConfiguredError:
            results.append(StepResult(key, "skipped", {"reason": "not_configured"}))
        except ZohoUpstreamError as e:
            results.append(StepResult(key, "failed", {"reason": "upstream", "message": str(e)}))
    try:
        results.append(await _links_step(db, project))
    except Exception as e:  # noqa: BLE001 — a report, never a 500
        logger.warning("Force sync: payment links for project %s failed: %s", project.id, e)
        results.append(StepResult("payment_links", "failed", {"reason": "upstream", "message": str(e)}))
    return results
```

- [ ] **Step 5: Event kind**

In `aito_events.py` `KINDS`, next to `"sync.queued"`: `"project.force_synced": "detail",` with a one-line comment ("an operator asked for a full Zoho check; detail carries each step's outcome").

- [ ] **Step 6: Route** (in `routes/aito.py`, right after `sync_project_now`; constants next to `_PAYMENT_LINK_REFRESH_*`)

```python
_FORCE_SYNC_MAX_CALLS = 6
_FORCE_SYNC_DETAIL = "Too many force syncs. Please wait a moment and try again."
```

```python
@router.post("/{project_id}/force-sync", response_model=AitoForceSyncReport)
async def force_sync_project(
    project_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """The ⋯ menu's Force Zoho sync: check every Zoho-backed part of the card
    and repair drift, reporting per step (aito_force_sync). The quote half is
    the same mark-pending as ``sync_project_now`` — it forces the ATTEMPT,
    never the write — then waits for the worker's attempt to land."""
    _check_rate_limit(
        request, current_user, bucket="force_sync", max_calls=_FORCE_SYNC_MAX_CALLS, detail=_FORCE_SYNC_DETAIL
    )
    project = await _get_active_project_or_404(db, project_id)
    before = quote_snapshot(project)
    was_pending = project.quote_sync_state == "pending"
    _mark_pending_if_ours(project)
    if not was_pending and project.quote_sync_state == "pending":
        await record(db, project.id, "sync.queued", actor_class="system")
    queued = project.quote_sync_state == "pending"
    await db.commit()

    steps = await run_force_sync(db, project, quote_queued=queued, quote_before=before)
    await record(
        db,
        project.id,
        "project.force_synced",
        actor_class="user",
        # copy the actor keyword(s) the other user-recorded events in this file pass
        detail={"steps": {s.key: s.outcome for s in steps}},
    )
    await db.commit()
    return AitoForceSyncReport(steps=[AitoForceSyncStep(key=s.key, outcome=s.outcome, detail=s.detail) for s in steps])
```

Replace the comment line with the exact actor keywords used by a nearby user-initiated `record(...)` call in this file (grep `actor_class="user"`). Do NOT call `_commit_and_wake` here: `flush_and_wait` itself requests the immediate drain. The rate-limit test helper state (`_ai_rate_limit_calls`) is module-global; add `aito_routes._ai_rate_limit_calls.clear()` in an autouse fixture in the new test file (pattern: `test_aito_manual_payment_api.py`'s `_setup`).

- [ ] **Step 7: Permission sweep**

`WRITE_ROUTES` += `("force_sync_project", "post", f"/api/v1/aito/{_MISSING_ID}/force-sync", None),`; counts → `len(WRITE_ROUTES) == 38`, `len(aito_routes) == 59`.

- [ ] **Step 8: Run**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_force_sync.py backend/tests/unit/test_aito_permissions.py backend/tests/unit/test_aito_events.py backend/tests/unit/test_aito_close_sync.py -v -n 4`
Expected: PASS. `test_aito_events.py` may pin the KINDS list or the story set — update only if it lists every kind explicitly.

- [ ] **Step 9: Lint + commit**

```bash
ruff check backend/ && ruff format backend/app backend/tests/unit/test_aito_force_sync.py backend/tests/unit/test_aito_permissions.py
git add backend/app/services/aito_force_sync.py backend/app/schemas/aito.py backend/app/services/aito_events.py backend/app/api/routes/aito.py backend/tests/unit/test_aito_force_sync.py backend/tests/unit/test_aito_permissions.py
git commit -m "feat(aito): force Zoho sync route with a per-step report"
```

---

### Task 4: API client + Billing card hides the deposit once invoiced (frontend)

**Files:**
- Modify: `frontend/src/api/client.ts` (types + 3 api functions near `syncAitoProject` / `getAitoInvoice`)
- Modify: `frontend/src/components/aito/BillingCard.tsx` (the `quotePay &&` PaymentBlock)
- Test: `frontend/src/__tests__/components/AitoBillingCard.test.tsx` (append)

**Interfaces:**
- Produces (client.ts):

```ts
export type AitoForceSyncStepKey = 'quote' | 'credit' | 'invoice' | 'payment_links';
export type AitoForceSyncOutcome = 'in_sync' | 'fixed' | 'failed' | 'skipped';
export interface AitoForceSyncStep {
  key: AitoForceSyncStepKey;
  outcome: AitoForceSyncOutcome;
  detail: Record<string, unknown>;
}
export interface AitoForceSyncReport {
  steps: AitoForceSyncStep[];
}
export interface AitoDepositCredit {
  id: string;
  number: string;
  applicable: number;
  total: number;
}
export interface AitoInvoiceDeposits {
  invoice: { id: string; number: string; balance: number; currency_code: string } | null;
  deposits: AitoDepositCredit[];
}
```

and in the `api` object:

```ts
  forceSyncAitoProject: (projectId: number) =>
    request<AitoForceSyncReport>(`/aito/${projectId}/force-sync`, { method: 'POST' }),
  getAitoInvoiceDeposits: (projectId: number) => request<AitoInvoiceDeposits>(`/aito/${projectId}/invoice-deposits`),
  applyAitoInvoiceDeposit: (projectId: number, body: { invoice_id: string; retainer_id: string; amount: number }) =>
    request<AitoInvoice>(`/aito/${projectId}/invoice-deposits/apply`, { method: 'POST', body: JSON.stringify(body) }),
```

(Check how neighbouring POSTs with a body pass headers — copy that exact shape.)

- [ ] **Step 1: Failing tests** (append to `AitoBillingCard.test.tsx`)

```tsx
describe('BillingCard deposit block once invoiced', () => {
  it('hides Deposit due once the card is invoiced', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(null);
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([]);
    renderCard(project({ quote_invoiced: true, quote_total: 14000 }), { depositPct: 50 });
    await waitFor(() => expect(screen.queryByText('Deposit due')).not.toBeInTheDocument());
  });

  it('keeps Deposit due while a deposit tap is still on the terminal', async () => {
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(null);
    vi.spyOn(api, 'getAitoRetainers').mockResolvedValue([]);
    renderCard(
      project({
        quote_invoiced: true,
        quote_total: 14000,
        terminal_payment: {
          id: 1, document_kind: 'quote', document_number: 'DEV-2026-1234', status: 'processing', amount: 7000,
          amount_confirmed: null, booking_status: null, booking_error: null, sync_error: null,
          created_at: '2026-10-03T00:00:00', settled_at: null,
        },
      }),
      { depositPct: 50 },
    );
    expect(await screen.findByText('Deposit due')).toBeInTheDocument();
  });

  it('still shows Deposit due before invoicing', () => {
    renderCard(project({ quote_total: 14000 }), { depositPct: 50 });
    expect(screen.getByText('Deposit due')).toBeInTheDocument();
  });
});
```

Confirm the EN label for the quote PaymentBlock heading is literally "Deposit due" (`grep -n "Deposit due" frontend/src/i18n/locales/en.ts`) and the retainers API name (`getAitoRetainers`?) — adjust both to what exists. If the file's existing tests already mock these queries a different way, follow that.

- [ ] **Step 2: Run, expect the first test to FAIL**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoBillingCard.test.tsx`

- [ ] **Step 3: Implement** in `BillingCard.tsx`, replacing `const quotePay = quoteDocument(project, depositPct, currency);` with:

```tsx
  // Once the job is billed the deposit is moot: collect on the invoice. The
  // backend cancels the link and refuses new deposit payments; the block only
  // stays while a deposit tap is still on the terminal, so a payment in
  // progress is never hidden mid-way.
  const quoteTerminal = terminalFor(project, 'quote');
  const depositInFlight = quoteTerminal != null && ['pending', 'processing'].includes(quoteTerminal.status);
  const quotePay = project.quote_invoiced && !depositInFlight ? null : quoteDocument(project, depositPct, currency);
```

and pass `terminal={quoteTerminal}` to the quote PaymentBlock.

- [ ] **Step 4: Run, expect PASS**; then `cd frontend && npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/components/aito/BillingCard.tsx frontend/src/__tests__/components/AitoBillingCard.test.tsx
git commit -m "feat(aito): hide the deposit block once a card is invoiced; client types for sync and deposit apply"
```

---

### Task 5: Apply-deposit modal on the invoice row (frontend)

**Files:**
- Create: `frontend/src/components/aito/depositPrefill.ts`
- Create: `frontend/src/components/aito/ApplyDepositModal.tsx`
- Create: `frontend/src/components/aito/useAitoInvoiceDeposits.ts`
- Modify: `frontend/src/components/aito/InvoiceCard.tsx`
- Modify: `frontend/src/components/aito/DocumentRow.tsx` (optional `extra?: ReactNode` action slot rendered before `print`)
- Modify: 15 locale files `frontend/src/i18n/locales/*.ts`
- Test: `frontend/src/__tests__/components/AitoApplyDepositModal.test.tsx` (new), `frontend/src/__tests__/components/AitoDepositPrefill.test.ts` (new), `frontend/src/__tests__/components/AitoInvoiceCard.test.tsx` (append)

**Interfaces:**
- Consumes: `api.getAitoInvoiceDeposits`, `api.applyAitoInvoiceDeposit`, `AitoInvoiceDeposits`, `AitoDepositCredit` (Task 4).
- Produces: `depositPrefill(balance: number, applicable: number): { amount: number; reason: 'paysInFull' | 'usesAll' }`; `useAitoInvoiceDeposits(project, enabled)` with query key `['aito-invoice-deposits', project.id]`.

i18n keys (namespace `aito`), EN / FR — translate the other 13 for real:

| key | en | fr |
|---|---|---|
| `applyDeposit` | Apply deposit | Imputer l'acompte |
| `applyDepositTitle` | Apply a deposit to {{invoice}} | Imputer un acompte sur {{invoice}} |
| `applyDepositBody` | The amount is taken from the chosen deposit and paid on the invoice in Zoho Books. | Le montant est pris sur l'acompte choisi et réglé sur la facture dans Zoho Books. |
| `applyDepositAvailable` | {{amount}} unused | {{amount}} non utilisé |
| `applyDepositAmount` | Amount to apply | Montant à imputer |
| `applyDepositPaysInFull` | Pays the invoice in full | Solde la facture |
| `applyDepositUsesAll` | Uses the whole deposit | Utilise tout l'acompte |
| `applyDepositTooHigh` | At most {{amount}} | {{amount}} maximum |
| `applyDepositConfirm` | Apply {{amount}} | Imputer {{amount}} |
| `applyDepositDone` | {{amount}} applied to {{invoice}} | {{amount}} imputé sur {{invoice}} |
| `applyDepositError` | The deposit could not be applied | L'acompte n'a pas pu être imputé |

- [ ] **Step 1: Prefill helper test + impl**

`AitoDepositPrefill.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { depositPrefill } from '../../components/aito/depositPrefill';

describe('depositPrefill', () => {
  it('pays the invoice in full when the deposit covers it', () => {
    expect(depositPrefill(5000, 7000)).toEqual({ amount: 5000, reason: 'paysInFull' });
  });
  it('uses the whole deposit when it falls short', () => {
    expect(depositPrefill(14000, 7000)).toEqual({ amount: 7000, reason: 'usesAll' });
  });
  it('prefers paysInFull on a tie', () => {
    expect(depositPrefill(7000, 7000)).toEqual({ amount: 7000, reason: 'paysInFull' });
  });
  it('rounds to cents', () => {
    expect(depositPrefill(100.005, 1000).amount).toBe(100.01);
  });
});
```

`depositPrefill.ts`:

```ts
/** The Apply-deposit modal's starting amount: whichever runs out first, the
 *  invoice balance or the deposit's unused money. On a tie the invoice wins
 *  the label — "pays in full" is the fact the operator cares about. */
export function depositPrefill(balance: number, applicable: number): { amount: number; reason: 'paysInFull' | 'usesAll' } {
  const round = (n: number) => Math.round(n * 100) / 100;
  return applicable >= balance
    ? { amount: round(balance), reason: 'paysInFull' }
    : { amount: round(applicable), reason: 'usesAll' };
}
```

Run: `cd frontend && npx vitest run src/__tests__/components/AitoDepositPrefill.test.ts` → PASS after impl (FAIL before).

- [ ] **Step 2: Hook**

```ts
import { useQuery } from '@tanstack/react-query';
import { api, type AitoProject } from '../../api/client';

/** This quote's own unspent deposits + its open invoice (GET invoice-deposits).
 *  Live, like useAitoInvoice; the caller gates it on an invoice with a balance. */
export function useAitoInvoiceDeposits(project: AitoProject, enabled: boolean) {
  return useQuery({
    queryKey: ['aito-invoice-deposits', project.id],
    queryFn: () => api.getAitoInvoiceDeposits(project.id),
    enabled,
    staleTime: 30_000,
  });
}
```

- [ ] **Step 3: Modal tests** (`AitoApplyDepositModal.test.tsx`)

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ApplyDepositModal } from '../../components/aito/ApplyDepositModal';
import { api, ApiError } from '../../api/client';

const DATA = {
  invoice: { id: 'INV1', number: 'FA-26-4458', balance: 14000, currency_code: 'XPF' },
  deposits: [
    { id: 'R1', number: 'RET26-00301', applicable: 7000, total: 7000 },
    { id: 'R2', number: 'RET26-00302', applicable: 20000, total: 20000 },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('ApplyDepositModal', () => {
  it('preselects the oldest deposit and prefills what it can cover', () => {
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    expect(screen.getByRole('radio', { name: /RET26-00301/ })).toBeChecked();
    expect(screen.getByLabelText('Amount to apply')).toHaveValue('7000');
    expect(screen.getByText('Uses the whole deposit')).toBeInTheDocument();
  });

  it('re-prefills when another deposit is chosen', async () => {
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('radio', { name: /RET26-00302/ }));
    expect(screen.getByLabelText('Amount to apply')).toHaveValue('14000');
    expect(screen.getByText('Pays the invoice in full')).toBeInTheDocument();
  });

  it('blocks an amount above the cap', async () => {
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={() => {}} />);
    const input = screen.getByLabelText('Amount to apply');
    await userEvent.clear(input);
    await userEvent.type(input, '9000');
    await userEvent.tab();
    expect(screen.getByText(/At most/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Apply/ })).toBeDisabled();
  });

  it('applies and closes', async () => {
    const spy = vi.spyOn(api, 'applyAitoInvoiceDeposit').mockResolvedValue({} as never);
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(12, { invoice_id: 'INV1', retainer_id: 'R1', amount: 7000 }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the modal open with the server message on a 409', async () => {
    vi.spyOn(api, 'applyAitoInvoiceDeposit').mockRejectedValue(new ApiError('At most 3000.00 can be applied', 409));
    const onClose = vi.fn();
    render(<ApplyDepositModal projectId={12} data={DATA} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /^Apply/ }));
    expect(await screen.findByText(/At most 3000/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

Check `ApiError`'s constructor argument order in `client.ts` and how a `detail` object (`{code, message}`) becomes `err.message`; adjust the 409 test's construction to what `request()` actually throws. Check how `CalcInput` renders its value in jsdom (the `toHaveValue` string vs number) in an existing CalcInput test and match it.

- [ ] **Step 4: Modal implementation** — `ApplyDepositModal.tsx`, same shell as `MergeProjectModal` (overlay `z-[110]`, `useDismissableDialog`, Escape `stopPropagation`, header with a `PiggyBank` icon tile, title `aito.applyDepositTitle` with `{invoice: data.invoice.number}`, body `aito.applyDepositBody`). Props: `{ projectId: number; data: AitoInvoiceDeposits; onClose: () => void }` (the invoice is non-null when rendered — the caller guarantees it).

Core state and logic:

```tsx
  const invoice = data.invoice!;
  const [selectedId, setSelectedId] = useState(data.deposits[0]?.id ?? '');
  const selected = data.deposits.find((d) => d.id === selectedId) ?? data.deposits[0];
  const prefill = depositPrefill(invoice.balance, selected.applicable);
  const [amount, setAmount] = useState<number>(prefill.amount);
  const cap = prefill.amount;
  const tooHigh = amount > cap + 0.005;
  const valid = amount > 0 && !tooHigh;
  const hint = amount === prefill.amount ? t(prefill.reason === 'paysInFull' ? 'aito.applyDepositPaysInFull' : 'aito.applyDepositUsesAll') : null;

  const select = (id: string) => {
    const next = data.deposits.find((d) => d.id === id);
    if (!next) return;
    setSelectedId(id);
    setAmount(depositPrefill(invoice.balance, next.applicable).amount);
    setError(null);
  };

  const apply = useMutation({
    mutationFn: () => api.applyAitoInvoiceDeposit(projectId, { invoice_id: invoice.id, retainer_id: selected.id, amount }),
    onSuccess: () => {
      for (const key of ['aito-invoice', 'aito-invoice-deposits', 'aito-retainers', 'aito-events']) {
        queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      showToast(t('aito.applyDepositDone', { amount: formatMoney(amount, invoice.currency_code), invoice: invoice.number }), 'success');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : t('aito.applyDepositError')),
  });
```

Body: a `role="radiogroup"` list, one `<label>` per deposit with `<input type="radio" name="deposit" checked={d.id === selected.id} onChange={() => select(d.id)} />`, the RET number, and `t('aito.applyDepositAvailable', { amount: formatMoney(d.applicable, invoice.currency_code) })`. Then `<label htmlFor="apply-deposit-amount">{t('aito.applyDepositAmount')}</label>` + `<CalcInput id="apply-deposit-amount" value={amount} onValueChange={(raw) => { const n = Number(raw); setAmount(Number.isFinite(n) ? n : 0); setError(null); }} />`, then either `<p className="text-xs text-red-400">{t('aito.applyDepositTooHigh', { amount: formatMoney(cap, invoice.currency_code) })}</p>` when `tooHigh` or the hint in `text-bambu-gray`. Footer like MergeProjectModal's: error `<p role="alert">`, Cancel (`common.cancel`) and primary `<Button disabled={!valid || apply.isPending} onClick={() => apply.mutate()}>{t('aito.applyDepositConfirm', { amount: formatMoney(amount, invoice.currency_code) })}</Button>`.

Run the modal tests → PASS.

- [ ] **Step 5: InvoiceCard icon** — add an optional `extra?: ReactNode` prop to `DocumentRow` rendered first in the action group (`{extra}{print}{download}{send}`). In `InvoiceCard`:

```tsx
  const depositsQuery = useAitoInvoiceDeposits(project, canUpdate && !!invoice && invoice.balance > 0);
  const [applying, setApplying] = useState(false);
  const deposits = depositsQuery.data;
  const canApply = !!deposits?.invoice && deposits.deposits.some((d) => d.applicable > 0);
```

(hooks must run before the `if (!invoice) return null;` early return — move that return below them, and gate the query with `!!invoice`). Pass:

```tsx
        extra={
          canApply ? (
            <button
              type="button"
              onClick={() => setApplying(true)}
              aria-label={t('aito.applyDeposit')}
              title={t('aito.applyDeposit')}
              data-testid="apply-deposit"
              className={/* copy the className SendInvoiceButton variant="icon" uses */ ''}
            >
              <PiggyBank className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : undefined
        }
```

and render `{applying && deposits && <ApplyDepositModal projectId={project.id} data={deposits} onClose={() => setApplying(false)} />}` inside the returned `<div>`. Fill the className from `SendInvoiceButton`'s icon variant (same size, hover, focus ring) — do not leave it empty.

Append to `AitoInvoiceCard.test.tsx`: (a) icon shown when `getAitoInvoiceDeposits` returns a deposit with `applicable > 0` and the invoice balance > 0; (b) hidden when `deposits: []`; (c) hidden without `canUpdate` (and `getAitoInvoiceDeposits` never called); (d) clicking it opens the modal (`findByRole('dialog')`). Use the file's existing invoice mocks.

- [ ] **Step 6: i18n** — add the 11 keys to all 15 locales under `aito` (grep first that none exists). Run `cd frontend && npm run check:i18n` → PASS.

- [ ] **Step 7: Run all touched tests + typecheck + lint**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoApplyDepositModal.test.tsx
cd frontend && npx vitest run src/__tests__/components/AitoInvoiceCard.test.tsx
cd frontend && npx vitest run src/__tests__/components/AitoBillingCard.test.tsx
cd frontend && npm run typecheck && npm run lint
```

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/aito/depositPrefill.ts frontend/src/components/aito/ApplyDepositModal.tsx frontend/src/components/aito/useAitoInvoiceDeposits.ts frontend/src/components/aito/InvoiceCard.tsx frontend/src/components/aito/DocumentRow.tsx frontend/src/i18n/locales frontend/src/__tests__/components/AitoApplyDepositModal.test.tsx frontend/src/__tests__/components/AitoDepositPrefill.test.ts frontend/src/__tests__/components/AitoInvoiceCard.test.tsx
git commit -m "feat(aito): apply a deposit to the invoice from the invoice row"
```

---

### Task 6: Force Zoho sync menu row + report modal (frontend)

**Files:**
- Create: `frontend/src/components/aito/ForceSyncModal.tsx`
- Create: `frontend/src/components/aito/forceSyncText.ts` (pure: step → label/detail text)
- Modify: `frontend/src/components/aito/ProjectActionsMenu.tsx` (prop `onForceSync`, row `forceSync`)
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx` (state `forceSyncing`, menu prop, modal render, `shortcutEnabled` list)
- Modify: `frontend/src/components/aito/history/eventKinds.ts` (`'project.force_synced': 'aito.history.projectForceSynced'`)
- Modify: 15 locales
- Test: `frontend/src/__tests__/components/AitoForceSyncModal.test.tsx` (new), `AitoProjectActionsMenu.test.tsx` (append), `AitoForceSyncText.test.ts` (new)

**Interfaces:**
- Consumes: `api.forceSyncAitoProject`, `AitoForceSyncReport`, `AitoForceSyncStep` (Task 4).
- Produces: `forceSyncStepText(t, step: AitoForceSyncStep, currency: string): { label: string; detail: string | null }`.

i18n keys (namespace `aito`; EN / FR):

| key | en | fr |
|---|---|---|
| `forceSync` (check: may already exist for the Billing card's button — if so reuse it and name the menu label `forceZohoSync`) | Force Zoho sync | Forcer la synchro Zoho |
| `forceSyncTitle` | Zoho sync check | Vérification Zoho |
| `forceSyncRunning` | Checking… | Vérification… |
| `forceSyncStepQuote` | Quote | Devis |
| `forceSyncStepCredit` | Customer credit | Crédit client |
| `forceSyncStepInvoice` | Invoice | Facture |
| `forceSyncStepLinks` | Payment links | Liens de paiement |
| `forceSyncInSync` | In sync | À jour |
| `forceSyncFixed` | Fixed | Corrigé |
| `forceSyncFailed` | Failed | Échec |
| `forceSyncSkipped` | Skipped | Ignoré |
| `forceSyncReasonNoQuote` | No quote | Pas de devis |
| `forceSyncReasonUnmanaged` | Not managed by Aito | Non géré par Aito |
| `forceSyncReasonNotInvoiced` | Not invoiced yet | Pas encore facturé |
| `forceSyncReasonNotConfigured` | Not configured | Non configuré |
| `forceSyncReasonRateLimited` | Zoho rate limit — try again in a minute | Limite Zoho atteinte — réessayez dans une minute |
| `forceSyncReasonWorkerUnavailable` | Zoho sync is off | La synchro Zoho est désactivée |
| `forceSyncReasonTimeout` | Zoho did not answer in time | Zoho n'a pas répondu à temps |
| `forceSyncReasonNoClient` | No client | Pas de client |
| `forceSyncCreditChanged` | {{before}} → {{after}} | {{before}} → {{after}} |
| `forceSyncInvoiceApplied` | {{number}}: balance {{before}} → {{after}} | {{number}} : solde {{before}} → {{after}} |
| `history.projectForceSynced` | ran a Zoho sync check | a lancé une vérification Zoho |

(`forceSyncCreditChanged` is identical in every locale — add it to the parity script's per-locale allowlist only if the gate rejects it; prefer a localized arrow phrase otherwise.)

- [ ] **Step 1: `forceSyncText.ts` test + impl**

Test (`AitoForceSyncText.test.ts`): `in_sync` quote → `{label: 'In sync', detail: null}`; `skipped` with `reason: 'rate_limited'` → detail is the rate-limit sentence; `fixed` credit `{before: 500, after: 7000}` → detail contains both formatted amounts; `fixed` invoice → detail contains the number; `failed` with `reason: 'refused', message: 'tax-exclusive…'` → detail is the message; unknown reason → detail is the raw reason string. Use `i18n` from the test utils (`import i18n from '../../i18n'` — check how other pure-`t` tests obtain `t`).

Impl:

```ts
import type { TFunction } from 'i18next';
import type { AitoForceSyncStep } from '../../api/client';
import { formatMoney } from '../../utils/pricing';

const OUTCOME_KEY = {
  in_sync: 'aito.forceSyncInSync',
  fixed: 'aito.forceSyncFixed',
  failed: 'aito.forceSyncFailed',
  skipped: 'aito.forceSyncSkipped',
} as const;

const REASON_KEY: Record<string, string> = {
  no_quote: 'aito.forceSyncReasonNoQuote',
  unmanaged: 'aito.forceSyncReasonUnmanaged',
  not_invoiced: 'aito.forceSyncReasonNotInvoiced',
  not_configured: 'aito.forceSyncReasonNotConfigured',
  rate_limited: 'aito.forceSyncReasonRateLimited',
  worker_unavailable: 'aito.forceSyncReasonWorkerUnavailable',
  timeout: 'aito.forceSyncReasonTimeout',
  no_client: 'aito.forceSyncReasonNoClient',
};

/** One report row's text. The server sends machine reasons; the words live here. */
export function forceSyncStepText(t: TFunction, step: AitoForceSyncStep, currency: string) {
  const d = step.detail as Record<string, unknown>;
  const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v, currency) : '—');
  let detail: string | null = null;
  if (typeof d.message === 'string' && d.message) detail = d.message;
  else if (typeof d.reason === 'string') detail = REASON_KEY[d.reason] ? t(REASON_KEY[d.reason]) : d.reason;
  else if (step.outcome === 'fixed' && step.key === 'credit') {
    detail = t('aito.forceSyncCreditChanged', { before: money(d.before), after: money(d.after) });
  } else if (step.outcome === 'fixed' && step.key === 'invoice') {
    detail = t('aito.forceSyncInvoiceApplied', {
      number: String(d.number ?? ''),
      before: money(d.balance_before),
      after: money(d.balance_after),
    });
  } else if (step.outcome === 'fixed' && step.key === 'quote') {
    const total = d.total as { before?: number; after?: number } | undefined;
    if (total) detail = t('aito.forceSyncCreditChanged', { before: money(total.before), after: money(total.after) });
  }
  return { label: t(OUTCOME_KEY[step.outcome]), detail };
}
```

- [ ] **Step 2: Modal tests** (`AitoForceSyncModal.test.tsx`): (a) shows "Checking…" and four step names while the POST is pending (mock with a never-resolving promise); (b) renders each outcome label once resolved (mock a report with one of each outcome); (c) a rejected POST with `ApiError(…, 429)` shows the error text and no step rows; (d) on success invalidates — spy `QueryClient.prototype.invalidateQueries` and assert it was called with `{ queryKey: ['aito-invoice', 12] }` and `{ queryKey: ['aito-projects'] }`; (e) Escape closes (`onClose` called). Fire the POST exactly once even under StrictMode: assert `spy` called once.

- [ ] **Step 3: Modal impl** — same shell as `MergeProjectModal` (copy its overlay/Card/header markup; icon `RefreshCw`, title `aito.forceSyncTitle`). Props `{ project: AitoProject; currency: string; onClose: () => void }`.

```tsx
  const STEPS: { key: AitoForceSyncStepKey; label: string }[] = [
    { key: 'quote', label: 'aito.forceSyncStepQuote' },
    { key: 'credit', label: 'aito.forceSyncStepCredit' },
    { key: 'invoice', label: 'aito.forceSyncStepInvoice' },
    { key: 'payment_links', label: 'aito.forceSyncStepLinks' },
  ];
  const run = useMutation({
    mutationFn: () => api.forceSyncAitoProject(project.id),
    onSuccess: () => {
      for (const key of ['aito-invoice', 'aito-invoice-deposits', 'aito-retainers', 'aito-events', 'aito-tasks']) {
        queryClient.invalidateQueries({ queryKey: [key, project.id] });
      }
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    },
  });
  // Once per mount, StrictMode-safe: a ref, not the effect's own re-run.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run.mutate();
  }, [run]);
```

Body: a `<ul>` of the four steps; for each, while `run.isPending` a `Loader2 animate-spin` + `t('aito.forceSyncRunning')`; when `run.data`, the matching step's `forceSyncStepText` label with an icon per outcome (`Check` green / `RefreshCw` amber-ish `text-bambu-green-light` for fixed / `X` red / `Minus` gray) and the detail in `text-xs text-bambu-gray` under it. On `run.error`: `<p role="alert">` with `err.message` (ApiError) or `aito.forceSyncFailed`. Footer: one Close button (`common.close`). Block close while pending? No — closing mid-run is fine (the request completes server-side); keep Close enabled.

- [ ] **Step 4: Menu row** — in `ProjectActionsMenu.tsx` add prop `onForceSync: () => void` (doc: "Opens the force-sync report; runs on open.") and, between the `watch` block and `duplicate`:

```tsx
    item(
      { key: 'forceSync', icon: RefreshCw, label: t('aito.forceZohoSync'), onSelect: p.onForceSync },
      // POST /{id}/force-sync rides AITO_UPDATE and 404s a trashed card. An
      // invoiced card stays enabled: the invoice and deposit steps matter most there.
      reason([trashed, hintTrashed], [!p.canUpdate, hintNoPermission]),
    ),
```

(use whichever label key Task 6's i18n table settled on). Append to `AitoProjectActionsMenu.test.tsx`: enabled on an invoiced card, disabled with the trashed hint on a trashed card, disabled with the permission hint without `canUpdate`, calls `onForceSync` on select. Update every existing render in that test file to pass `onForceSync={vi.fn()}` (required prop — grep the file for `<ProjectActionsMenu` and the default-props helper).

- [ ] **Step 5: Panel wiring** — in `ProjectDetailPanel.tsx`: `const [forceSyncing, setForceSyncing] = useState(false);`, pass `onForceSync={() => setForceSyncing(true)}`, add `forceSyncing ||` to the `shortcutEnabled` negation list, and render next to the merge modal: `{forceSyncing && <ForceSyncModal project={project} currency={currency} onClose={() => setForceSyncing(false)} />}` (use the currency value the panel already passes to `BillingCard`). Grep `__tests__` for other `<ProjectActionsMenu` renders and fixtures that need the new prop.

- [ ] **Step 6: Event label** — `eventKinds.ts`: `'project.force_synced': 'aito.history.projectForceSynced',`. If `eventKinds.test.ts` asserts every backend KINDS entry has a label (check), it now passes; otherwise nothing else.

- [ ] **Step 7: i18n** all 15 locales; `cd frontend && npm run check:i18n`.

- [ ] **Step 8: Run + typecheck + lint**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoForceSyncModal.test.tsx
cd frontend && npx vitest run src/__tests__/components/AitoForceSyncText.test.ts
cd frontend && npx vitest run src/__tests__/components/AitoProjectActionsMenu.test.tsx
cd frontend && npx vitest run src/__tests__/components/eventKinds.test.ts
cd frontend && npm run typecheck && npm run lint
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/aito/ForceSyncModal.tsx frontend/src/components/aito/forceSyncText.ts frontend/src/components/aito/ProjectActionsMenu.tsx frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/components/aito/history/eventKinds.ts frontend/src/i18n/locales frontend/src/__tests__/components/AitoForceSyncModal.test.tsx frontend/src/__tests__/components/AitoForceSyncText.test.ts frontend/src/__tests__/components/AitoProjectActionsMenu.test.tsx
git commit -m "feat(aito): Force Zoho sync in the card menu with a per-step report"
```

---

### Task 7: Client name loses the hold gesture (frontend)

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx` (~lines 548–600)
- Modify: 15 locales (delete `clientHistoryHint`)
- Test: `frontend/src/__tests__/components/AitoClientHistory.test.tsx` (update)

- [ ] **Step 1: Update the tests first** — in `AitoClientHistory.test.tsx` (and any other test grepping `clientHistoryHint` / "Hold for the client" / a hold on the name: `grep -rn "Hold for the client\|clientHistoryHint\|HoldButton" frontend/src/__tests__ | grep -i "client\|history"`): replace hold-based openings with a click on the `History` button (`getByRole('button', { name: 'Client history' })` — confirm the EN of `aito.clientHistory`), and add:

```tsx
  it('the client name is plain text, not a hold target', () => {
    // render the panel as the file's other tests do
    expect(screen.queryByText('Hold for the client’s history')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ACME' })).not.toBeInTheDocument();
  });
```

Run the file → the new test FAILS.

- [ ] **Step 2: Implement** — replace the whole `{onOpenHistory ? ( <span …><HoldButton …>…</HoldButton></span> ) : ( <span className="truncate">…</span> )}` block with just:

```tsx
          <span className="truncate">{project.client_name ?? t('aito.noClient')}</span>
```

On the History button's className, add `pointer-coarse:opacity-100` right after `opacity-0` (touch screens have no hover; it is the only way to the history now). Update its leading comment: it is now the one way in, not "the gesture's discoverable twin". Remove the `HoldButton` import if nothing else in the file uses it.

- [ ] **Step 3: Delete `clientHistoryHint`** from all 15 locales; `grep -rn clientHistoryHint frontend/src` → no hits.

- [ ] **Step 4: Verify `pointer-coarse:` compiles** — Tailwind 4 ships the `pointer-coarse` variant; confirm with `grep -rn "pointer-coarse:" frontend/src | head -3` that it is already used somewhere (if not, use `[@media(pointer:coarse)]:opacity-100`).

- [ ] **Step 5: Run + commit**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoClientHistory.test.tsx
cd frontend && npm run typecheck && npm run lint && npm run check:i18n
git add frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/i18n/locales frontend/src/__tests__/components/AitoClientHistory.test.tsx
git commit -m "feat(aito): open client history from its button only, drop the hold on the name"
```

---

### Task 8: Full verification, spec notes, static build

- [ ] **Step 1:** `./test_backend.sh` → all green except the known `test_library_api.py::…::test_delete_folder_removes_managed_files_from_disk` root-cwd precondition failure (pre-existing, not ours). Any other failure in a file we did not touch: rerun that file alone before investigating.
- [ ] **Step 2:** `./test_frontend.sh` → summary line has no FAILED.
- [ ] **Step 3:** Append an "Implementation notes" section to the spec listing deviations (at least: `credit` step refreshes `customer_credit_total` only; invoice step's detail is balance before/after rather than an `applied` list; route count now 59 / 38 write).
- [ ] **Step 4:** `cd frontend && npm run build` (dirties `static/`), then:

```bash
git add docs/superpowers/specs/2026-10-03-aito-force-sync-and-deposit-apply-design.md
git commit -m "docs(aito): implementation notes for force sync and deposit apply"
git add -f static
git commit -m "chore(build): rebuild static for force sync and deposit apply"
```

- [ ] **Step 5:** Report to the user: branch, commits, test results, and what is owed live (Books apply-credit on a real partial amount, force sync against a real card on the dev `:8000` after restart — no `--reload`).
