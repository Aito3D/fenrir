# SURFACE.md — order-board campaign (O1) public contract: the Order Board (frozen at setup)

Regenerate with: `bash tools/gen_surface_orders.sh > SURFACE.md` (from the repo root).
Each section is replayable by the `regen:` command shown above it (repo root,
`LC_ALL=C`). Any diff against the committed copy is a change to something
outside the feature`s own internals — a route or its permission, a public
function signature, a request schema, a table column, a stored key, a
setting or permission the feature reads, a Zoho call, an exported symbol, an
API client type or method, a translation key, the wiring — and fails the
iteration unless the user approved it.

## HTTP routes under /order-board: method, path, handler, required permission
```regen: ./venv/bin/python3 tools/probe_orders_surface.py routes 2>/dev/null```
```
GET /api/v1/order-board  ->  get_order_board  [orders:read]
GET /api/v1/order-board/finished  ->  get_finished_orders  [orders:read]
GET /api/v1/order-board/finished/{salesorder_id}  ->  get_finished_order  [orders:read]
GET /api/v1/order-board/invoices/{invoice_id}/pdf  ->  get_invoice_pdf  [orders:read]
POST /api/v1/order-board/orders/{salesorder_id}/invoice  ->  invoice_order  [orders:update]
POST /api/v1/order-board/orders/{salesorder_id}/packages  ->  create_parcel  [orders:update]
GET /api/v1/order-board/orders/{salesorder_id}/packages/{package_id}/handover  ->  get_handover_preview  [orders:read]
POST /api/v1/order-board/orders/{salesorder_id}/packages/{package_id}/handover  ->  hand_over_parcel  [orders:update]
GET /api/v1/order-board/orders/{salesorder_id}/picklist  ->  get_picklist_preview  [orders:read]
POST /api/v1/order-board/orders/{salesorder_id}/picklists  ->  create_picklist  [orders:update]
GET /api/v1/order-board/orders/{salesorder_id}/picklists/{picklist_id}  ->  get_picklist_content  [orders:read]
POST /api/v1/order-board/orders/{salesorder_id}/prep-sheet  ->  print_prep_sheet  [orders:read]
POST /api/v1/order-board/refresh  ->  refresh_order_board  [orders:update]
GET /api/v1/order-board/settings  ->  get_order_board_settings  [orders:update]
PUT /api/v1/order-board/settings  ->  update_order_board_settings  [orders:update]
15 routes
```

## Route decorators (routes/order_board.py)
```regen: grep -hE '^@[a-z_]*router\.(get|post|put|patch|delete)\(' backend/app/api/routes/order_board.py | sed 's/, *$//' | sort```
```
@router.get("")
@router.get("/finished")
@router.get("/finished/{salesorder_id}")
@router.get("/invoices/{invoice_id}/pdf")
@router.get("/orders/{salesorder_id}/packages/{package_id}/handover")
@router.get("/orders/{salesorder_id}/picklist")
@router.get("/orders/{salesorder_id}/picklists/{picklist_id}")
@router.get("/settings", response_model=OrderBoardSettingsBody)
@router.post("/orders/{salesorder_id}/invoice")
@router.post("/orders/{salesorder_id}/packages")
@router.post("/orders/{salesorder_id}/packages/{package_id}/handover")
@router.post("/orders/{salesorder_id}/picklists")
@router.post("/orders/{salesorder_id}/prep-sheet")
@router.post("/refresh")
@router.put("/settings", response_model=OrderBoardSettingsBody)
```

## Backend public functions, classes and constants (routes, model, the five services), with signatures
```regen: ./venv/bin/python3 tools/probe_orders_surface.py callables 2>/dev/null```
```
# backend.app.api.routes.order_board
class HandoverBody(BaseModel)
    mode: Literal['pickup', 'delivery']
    apply_credit: bool
class InvoiceBody(BaseModel)
    apply_credit: bool
class OrderBoardSettingsBody(BaseModel)
    sync_enabled: bool
    sync_minutes: Literal[5, 15, 60]
    max_age_days: int
    core_brands: list[str]
class PackBody(ParcelBody)
    lines: list[backend.app.api.routes.order_board.ParcelLine]
    picklist_id: str
class ParcelBody(BaseModel)
    lines: list[backend.app.api.routes.order_board.ParcelLine]
class ParcelLine(BaseModel)
    line_id: str
    quantity: float
async def create_parcel(salesorder_id: str, body: backend.app.api.routes.order_board.PackBody, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def create_picklist(salesorder_id: str, body: backend.app.api.routes.order_board.ParcelBody, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_finished_order(salesorder_id: str, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_finished_orders(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_handover_preview(salesorder_id: str, package_id: str, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_invoice_pdf(invoice_id: str, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> starlette.responses.Response
async def get_order_board(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_order_board_settings(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_picklist_content(salesorder_id: str, picklist_id: str, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def get_picklist_preview(salesorder_id: str, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def hand_over_parcel(salesorder_id: str, package_id: str, body: backend.app.api.routes.order_board.HandoverBody, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def invoice_order(salesorder_id: str, body: backend.app.api.routes.order_board.InvoiceBody, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def print_prep_sheet(salesorder_id: str, picklist_id: str | None = Query(None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> starlette.responses.Response
async def refresh_order_board(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict
async def update_order_board_settings(body: backend.app.api.routes.order_board.OrderBoardSettingsBody, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None)) -> dict

# backend.app.models.order_board_doc
class OrderBoardDoc(Base)
    id: INTEGER NOT NULL
    kind: VARCHAR(20) NOT NULL
    zoho_id: VARCHAR(64) NOT NULL
    header: JSON NOT NULL
    detail: JSON NULL
    pending: BOOLEAN NOT NULL

# backend.app.services.order_board
def age_days(day: str, today: datetime.date) -> int
def compute_board(orders: list[dict], purchase_orders: list[dict], items: dict[str, dict], today: datetime.date, *, max_age_days: int = 0, core_brands: collections.abc.Sequence[str] = ()) -> list[dict]
def order_row(order: dict, items: dict[str, dict], today: datetime.date) -> dict
def picked_waiting(order: dict) -> dict[str, float]
def units_to_invoice(order: dict, extra_shipped: collections.abc.Mapping[str, float] | None = None, service_line_ids: collections.abc.Collection[str] = ()) -> dict[str, float]

# backend.app.services.order_board_actions
class OrderActionRefused(Exception)
class OrderBusy(Exception)
class OrderNotOnBoard(Exception)
async def confirm_stored_copy(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> backend.app.models.order_board_doc.OrderBoardDoc
async def create_parcel(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, picklist_id: str, quantities: dict[str, float]) -> str
async def create_picklist(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, quantities: dict[str, float]) -> dict
async def hand_over(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, package_id: str, *, mode: Literal['pickup', 'delivery'], apply_credit: bool) -> dict
async def handover_preview(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, package_id: str) -> dict
def invoice_payload(prefill: dict, keep: collections.abc.Mapping[str, float], today: str) -> tuple[dict | None, str | None]
async def invoice_shipped(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, *, apply_credit: bool) -> dict
async def picklist_content(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, picklist_id: str) -> dict
async def picklist_preview(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> dict
async def stamp_print(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, by: str) -> dict
def writing(salesorder_id: str)

# backend.app.services.order_board_payment
def board_payments(orders: list[dict], today: datetime.date) -> dict[str, dict | None]
def order_contact(order: dict) -> dict | None
def order_facts(order: dict) -> dict
def order_payment(order: dict, today: datetime.date, credit: float = 0.0) -> dict | None

# backend.app.services.order_board_prep_sheet
def render_prep_sheet(row: dict, *, printed_at: datetime.datetime, order_url: str | None, shop_name: str = 'AITO3D', quantities: collections.abc.Mapping[str, float] | None = None, picklist_number: str = '') -> bytes

# backend.app.services.order_board_sync
class OrderBoardSettings(object)
    sync_enabled: bool
    sync_minutes: int
    max_age_days: int
    core_brands: list[str]
class OrderNotFinished(Exception)
class OrderNotStored(Exception)
class ZohoBusy(Exception)
async def find_board_row(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> dict | None
async def load_settings(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> backend.app.services.order_board_sync.OrderBoardSettings
def needs_refresh(salesorder_id: str) -> bool
def note_write(salesorder_id: str) -> None
def open_rate_limit_window(e: backend.app.services.zoho.ZohoRateLimited) -> None
async def read_board(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> dict
async def read_finished(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> dict
async def read_finished_order(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> dict
async def recompute(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> None
async def refresh_order(db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> None
async def run_loop() -> None
async def run_pass(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> bool
async def save_settings(db: sqlalchemy.ext.asyncio.session.AsyncSession, settings: backend.app.services.order_board_sync.OrderBoardSettings) -> None
def start_order_board_sync() -> None
def zoho_busy() -> bool
CALL_CEILING = 30
DAILY_BUDGET_FLOOR = 5000
DEFAULT_CORE_BRANDS = ['Bambu Lab', 'eSUN', 'SUNLU', 'Polymaker', 'Inslogic', 'Magigoo']
ITEM_BATCH = 50
MAX_DETAILS_PER_PASS = 20
PENDING_PAUSE_SECONDS = 60

```

## Request body schemas (routes/order_board.py), as JSON Schema
```regen: ./venv/bin/python3 tools/probe_orders_surface.py schemas 2>/dev/null```
```
{
 "HandoverBody": {
  "properties": {
   "apply_credit": {
    "title": "Apply Credit",
    "type": "boolean"
   },
   "mode": {
    "enum": [
     "pickup",
     "delivery"
    ],
    "title": "Mode",
    "type": "string"
   }
  },
  "required": [
   "mode",
   "apply_credit"
  ],
  "title": "HandoverBody",
  "type": "object"
 },
 "InvoiceBody": {
  "properties": {
   "apply_credit": {
    "title": "Apply Credit",
    "type": "boolean"
   }
  },
  "required": [
   "apply_credit"
  ],
  "title": "InvoiceBody",
  "type": "object"
 },
 "OrderBoardSettingsBody": {
  "properties": {
   "core_brands": {
    "items": {
     "type": "string"
    },
    "maxItems": 30,
    "title": "Core Brands",
    "type": "array"
   },
   "max_age_days": {
    "maximum": 3650,
    "minimum": 0,
    "title": "Max Age Days",
    "type": "integer"
   },
   "sync_enabled": {
    "title": "Sync Enabled",
    "type": "boolean"
   },
   "sync_minutes": {
    "enum": [
     5,
     15,
     60
    ],
    "title": "Sync Minutes",
    "type": "integer"
   }
  },
  "required": [
   "sync_enabled",
   "sync_minutes",
   "max_age_days",
   "core_brands"
  ],
  "title": "OrderBoardSettingsBody",
  "type": "object"
 },
 "PackBody": {
  "$defs": {
   "ParcelLine": {
    "properties": {
     "line_id": {
      "maxLength": 64,
      "minLength": 1,
      "title": "Line Id",
      "type": "string"
     },
     "quantity": {
      "exclusiveMinimum": 0,
      "title": "Quantity",
      "type": "number"
     }
    },
    "required": [
     "line_id",
     "quantity"
    ],
    "title": "ParcelLine",
    "type": "object"
   }
  },
  "properties": {
   "lines": {
    "items": {
     "$ref": "#/$defs/ParcelLine"
    },
    "maxItems": 200,
    "minItems": 1,
    "title": "Lines",
    "type": "array"
   },
   "picklist_id": {
    "maxLength": 64,
    "minLength": 1,
    "title": "Picklist Id",
    "type": "string"
   }
  },
  "required": [
   "lines",
   "picklist_id"
  ],
  "title": "PackBody",
  "type": "object"
 },
 "ParcelBody": {
  "$defs": {
   "ParcelLine": {
    "properties": {
     "line_id": {
      "maxLength": 64,
      "minLength": 1,
      "title": "Line Id",
      "type": "string"
     },
     "quantity": {
      "exclusiveMinimum": 0,
      "title": "Quantity",
      "type": "number"
     }
    },
    "required": [
     "line_id",
     "quantity"
    ],
    "title": "ParcelLine",
    "type": "object"
   }
  },
  "properties": {
   "lines": {
    "items": {
     "$ref": "#/$defs/ParcelLine"
    },
    "maxItems": 200,
    "minItems": 1,
    "title": "Lines",
    "type": "array"
   }
  },
  "required": [
   "lines"
  ],
  "title": "ParcelBody",
  "type": "object"
 },
 "ParcelLine": {
  "properties": {
   "line_id": {
    "maxLength": 64,
    "minLength": 1,
    "title": "Line Id",
    "type": "string"
   },
   "quantity": {
    "exclusiveMinimum": 0,
    "title": "Quantity",
    "type": "number"
   }
  },
  "required": [
   "line_id",
   "quantity"
  ],
  "title": "ParcelLine",
  "type": "object"
 }
}
```

## Table the feature owns — DDL (order_board_docs), SQLite and PostgreSQL
```regen: ./venv/bin/python3 tools/probe_orders_surface.py ddl 2>/dev/null```
```
-- sqlite
CREATE TABLE order_board_docs (
	id INTEGER NOT NULL, 
	kind VARCHAR(20) NOT NULL, 
	zoho_id VARCHAR(64) NOT NULL, 
	header JSON NOT NULL, 
	detail JSON, 
	pending BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_order_board_docs_kind_zoho_id UNIQUE (kind, zoho_id)
);
-- postgresql
CREATE TABLE order_board_docs (
	id SERIAL NOT NULL, 
	kind VARCHAR(20) NOT NULL, 
	zoho_id VARCHAR(64) NOT NULL, 
	header JSON NOT NULL, 
	detail JSON, 
	pending BOOLEAN NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_order_board_docs_kind_zoho_id UNIQUE (kind, zoho_id)
);
```

## Stored row kinds and the JSON keys kept in them (an existing database must stay readable)
```regen: grep -hoE 'kind ?==? ?"[a-z]+"|kind\.in_\(\("[a-z]+", "[a-z]+"\)\)|zoho_id ?==? ?"[a-z]+"' backend/app/api/routes/order_board.py backend/app/services/order_board.py backend/app/services/order_board_actions.py backend/app/services/order_board_payment.py backend/app/services/order_board_prep_sheet.py backend/app/services/order_board_sync.py backend/app/models/order_board_doc.py | sed -E 's/ ?(==|=) ?/ = /' | sort -u; grep -hoE '"(rows|computed_at|stock_loaded_at|last_error|last_error_at|last_success_at|payments_since|_fetched_at|_stale)"' backend/app/api/routes/order_board.py backend/app/services/order_board.py backend/app/services/order_board_actions.py backend/app/services/order_board_payment.py backend/app/services/order_board_prep_sheet.py backend/app/services/order_board_sync.py backend/app/models/order_board_doc.py | sort -u```
```
kind = "item"
kind = "prep"
kind = "purchaseorder"
kind = "salesorder"
kind = "state"
kind.in_(("salesorder", "purchaseorder"))
zoho_id = "board"
"_fetched_at"
"_stale"
"computed_at"
"last_error"
"last_error_at"
"last_success_at"
"payments_since"
"rows"
"stock_loaded_at"
```

## Settings keys and env vars the feature reads or writes
```regen: grep -hoE '(get_setting|set_setting)\(db, "[a-z_]+"|number\("[a-z_]+"' backend/app/api/routes/order_board.py backend/app/services/order_board.py backend/app/services/order_board_actions.py backend/app/services/order_board_payment.py backend/app/services/order_board_prep_sheet.py backend/app/services/order_board_sync.py backend/app/models/order_board_doc.py | sed -E 's/\(db, /(/' | sort -u; grep -hoE 'get_setting\(db, "external_url"' backend/app/services/aito_tracking.py | sed -E 's/\(db, /(/; s/$/  (aito_tracking.external_url, the prep sheet link)/' | sort -u; sed -n '/^_REQUIRED_KEYS = /p; /async def _load_config/,/return config/p' backend/app/services/zoho.py | grep -oE '"zoho_[a-z_]+"' | sort -u | sed 's/^/zoho config: /'; echo 'env vars:'; grep -hoE 'os\.environ[^)]*\)|os\.getenv\([^)]*\)|env_get\([^)]*\)' backend/app/api/routes/order_board.py backend/app/services/order_board.py backend/app/services/order_board_actions.py backend/app/services/order_board_payment.py backend/app/services/order_board_prep_sheet.py backend/app/services/order_board_sync.py backend/app/models/order_board_doc.py | sort -u```
```
get_setting("order_board_core_brands"
get_setting("order_board_sync_enabled"
number("order_board_max_age_days"
number("order_board_sync_minutes"
set_setting("order_board_core_brands"
set_setting("order_board_max_age_days"
set_setting("order_board_sync_enabled"
set_setting("order_board_sync_minutes"
get_setting("external_url"  (aito_tracking.external_url, the prep sheet link)
zoho config: "zoho_accounts_url"
zoho config: "zoho_base_url"
zoho config: "zoho_client_id"
zoho config: "zoho_client_secret"
zoho config: "zoho_organization_id"
zoho config: "zoho_refresh_token"
env vars:
```

## Permissions: values, default groups, API keys, and where the frontend checks them
```regen: ./venv/bin/python3 tools/probe_orders_surface.py permissions 2>/dev/null; grep -oE "'orders:(read|update)'" frontend/src/api/client.ts | sort -u | sed 's/^/frontend Permission union: /'; grep -rhoE "hasPermission\('orders:[a-z]+'\)|permission=\"orders:[a-z]+\"|orders: 'orders:[a-z]+'" frontend/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ | sort -u```
```
{
 "api_key_denied": [
  "orders:read",
  "orders:update"
 ],
 "api_key_scope": {
  "orders:read": "None",
  "orders:update": "None"
 },
 "categories": {
  "Orders": [
   "orders:read",
   "orders:update"
  ]
 },
 "default_groups": {
  "Administrators": [
   "orders:read",
   "orders:update"
  ],
  "Operators": [
   "orders:read",
   "orders:update"
  ],
  "Viewers": []
 },
 "values": {
  "ORDERS_READ": "orders:read",
  "ORDERS_UPDATE": "orders:update"
 }
}
frontend Permission union: 'orders:read'
frontend Permission union: 'orders:update'
hasPermission('orders:update')
orders: 'orders:read'
permission="orders:read"
```

## ZohoService members the order modules call, with signatures and callers
```regen: ./venv/bin/python3 tools/probe_orders_surface.py zoho 2>/dev/null```
```
async def apply_invoice_credits(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, invoice_id: str, invoice_payments: list[dict]) -> None   <- order_board_actions
async def books_app_url(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, estimate_id: str) -> str   <- order_board_sync
async def books_invoice_url(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, invoice_id: str) -> str   <- order_board_sync
async def books_salesorder_url_base(self, db: sqlalchemy.ext.asyncio.session.AsyncSession) -> str   <- order_board_sync
def calls_in_last_minute(self) -> int   <- order_board_sync
async def complete_picklist(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, picklist_id: str) -> None   <- order_board_actions
async def create_invoice(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, payload: dict) -> dict   <- order_board_actions
async def create_package(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, *, date: str, line_items: list[dict]) -> dict   <- order_board_actions
async def create_picklist(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, body: dict) -> dict   <- order_board_actions
async def create_shipment(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str, package_id: str, *, date: str, delivery_method: str) -> dict   <- order_board_actions
attribute daily_remaining   <- order_board_sync
async def get_invoice_pdf(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, invoice_id: str) -> bytes   <- routes/order_board
async def get_package(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, package_id: str) -> dict   <- order_board_actions
async def get_picklist(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, picklist_id: str) -> dict   <- order_board_actions
async def get_purchaseorder(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, purchaseorder_id: str) -> dict   <- order_board_sync
async def get_salesorder(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> dict   <- order_board_actions, order_board_sync
async def invoice_prefill(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> dict | None   <- order_board_actions
async def is_configured(self, db: sqlalchemy.ext.asyncio.session.AsyncSession) -> bool   <- order_board_sync
async def list_customer_payments(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, customer_id: str) -> list[dict]   <- order_board_actions
async def list_customer_payments_modified_since(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, since: str)   <- order_board_sync
async def list_items_by_ids(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, item_ids: list[str]) -> list[dict]   <- order_board_sync
async def list_purchaseorders(self, db: sqlalchemy.ext.asyncio.session.AsyncSession) -> list[dict]   <- order_board_sync
async def list_salesorders(self, db: sqlalchemy.ext.asyncio.session.AsyncSession) -> list[dict]   <- order_board_sync
async def mark_invoice_sent(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, invoice_id: str) -> None   <- order_board_actions
async def mark_shipment_delivered(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, shipment_id: str) -> None   <- order_board_actions
async def picklist_prefill(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, salesorder_id: str) -> dict | None   <- order_board_actions
async def update_picklist(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, picklist_id: str, body: dict) -> dict   <- order_board_actions
27 members
```

## Zoho methods that exist only for the Order Board (services/zoho.py)
```regen: sed -n '/# --- Order Board: read-only listings/,/async def get_shipping_catalogue/p; /async def picklist_prefill/,/async def get_invoice_raw/p' backend/app/services/zoho.py | grep -E '^    (async )?def ' | grep -vE 'get_shipping_catalogue|get_invoice_raw' | sed -E 's/^ *//; s/\(.*//'```
```
async def _list_all
async def list_salesorders
async def list_purchaseorders
async def get_salesorder
async def get_purchaseorder
async def list_items_by_ids
async def books_salesorder_url_base
async def picklist_prefill
async def get_picklist
async def create_picklist
async def update_picklist
async def complete_picklist
async def create_package
async def get_package
async def create_shipment
async def mark_shipment_delivered
async def invoice_prefill
async def mark_invoice_sent
```

## Registration points (main.py, models/__init__.py, core/database.py)
```regen: grep -nE "order_board|OrderBoardDoc" backend/app/main.py backend/app/models/__init__.py backend/app/core/database.py | sed -E "s/:[0-9]+:[[:space:]]*/: /"```
```
backend/app/main.py: order_board,
backend/app/main.py: from backend.app.services.order_board_sync import start_order_board_sync
backend/app/main.py: start_order_board_sync()
backend/app/main.py: app.include_router(order_board.router, prefix=app_settings.api_prefix)
backend/app/models/__init__.py: from backend.app.models.order_board_doc import OrderBoardDoc
backend/app/models/__init__.py: "OrderBoardDoc",
backend/app/core/database.py: order_board_doc,
```

## Frontend exported symbols, per file (components/orders/**, pages/OrderBoardPage.tsx)
```regen: grep -rHoE --include='*.ts' --include='*.tsx' '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' frontend/src/components/orders frontend/src/pages/OrderBoardPage.tsx | sort```
```
frontend/src/components/orders/FinishedOrderCard.tsx:export function FinishedOrderCard
frontend/src/components/orders/OrderCard.tsx:export function OrderCard
frontend/src/components/orders/OrderContactBlock.tsx:export function OrderContactBlock
frontend/src/components/orders/OrderHandoverBar.tsx:export function OrderHandoverBar
frontend/src/components/orders/OrderInvoicesBlock.tsx:export function OrderInvoicesBlock
frontend/src/components/orders/OrderLinesPanel.tsx:export function OrderLinesPanel
frontend/src/components/orders/OrderPackBar.tsx:export function OrderPackBar
frontend/src/components/orders/OrderPaymentBlock.tsx:export function OrderPaymentBlock
frontend/src/components/orders/OrderPrepActions.tsx:export function OrderPrepActions
frontend/src/components/orders/OrderQtyStepper.tsx:export function OrderQtyStepper
frontend/src/components/orders/OrderRefChips.tsx:export function OrderRefChips
frontend/src/components/orders/OrderRowAction.tsx:export function OrderRowAction
frontend/src/components/orders/OrdersSettingsCard.tsx:export function OrdersSettingsCard
frontend/src/components/orders/PaymentPill.tsx:export function PaymentPill
frontend/src/components/orders/orderBoard.ts:export const ageTone
frontend/src/components/orders/orderBoard.ts:export const boxablePicklists
frontend/src/components/orders/orderBoard.ts:export const byBrand
frontend/src/components/orders/orderBoard.ts:export const byFinishedPayment
frontend/src/components/orders/orderBoard.ts:export const byPayment
frontend/src/components/orders/orderBoard.ts:export const bySearch
frontend/src/components/orders/orderBoard.ts:export const byStatus
frontend/src/components/orders/orderBoard.ts:export const canPick
frontend/src/components/orders/orderBoard.ts:export const checkLines
frontend/src/components/orders/orderBoard.ts:export const countByPayment
frontend/src/components/orders/orderBoard.ts:export const countByStatus
frontend/src/components/orders/orderBoard.ts:export const daysPastDue
frontend/src/components/orders/orderBoard.ts:export const finishedPayState
frontend/src/components/orders/orderBoard.ts:export const foldText
frontend/src/components/orders/orderBoard.ts:export const formatQty
frontend/src/components/orders/orderBoard.ts:export const isBoardReady
frontend/src/components/orders/orderBoard.ts:export const nextStep
frontend/src/components/orders/orderBoard.ts:export const otherOpenOrders
frontend/src/components/orders/orderBoard.ts:export const packableUnits
frontend/src/components/orders/orderBoard.ts:export const paidPct
frontend/src/components/orders/orderBoard.ts:export const panelGroups
frontend/src/components/orders/orderBoard.ts:export const parseDay
frontend/src/components/orders/orderBoard.ts:export const pollMs
frontend/src/components/orders/orderBoard.ts:export const searchFinished
frontend/src/components/orders/orderBoard.ts:export const sortRows
frontend/src/components/orders/orderBoard.ts:export const totalValue
frontend/src/components/orders/orderBoard.ts:export const waitingPackages
frontend/src/components/orders/orderBoard.ts:export interface OrderCheck
frontend/src/components/orders/orderBoard.ts:export interface PanelGroup
frontend/src/components/orders/orderBoard.ts:export type PayFilter
frontend/src/components/orders/orderBoard.ts:export type SortKey
frontend/src/components/orders/orderBoard.ts:export type StatusFilter
frontend/src/components/orders/orderErrors.ts:export const errorReason
frontend/src/components/orders/orderErrors.ts:export const isRefused
frontend/src/components/orders/orderStatus.ts:export const FIT_VIEWPORT
frontend/src/components/orders/orderStatus.ts:export const PAY_META
frontend/src/components/orders/orderStatus.ts:export const ROW_GRID
frontend/src/components/orders/orderStatus.ts:export const STATUSES
frontend/src/components/orders/orderStatus.ts:export const STATUS_META
frontend/src/components/orders/orderStatus.ts:export const TONE
frontend/src/components/orders/orderStatus.ts:export type Tone
frontend/src/components/orders/useOrderActions.ts:export function useHandOverPending
frontend/src/components/orders/useOrderActions.ts:export function useOrderActions
frontend/src/components/orders/useOrderOutcomeToasts.ts:export function useOrderOutcomeToasts
frontend/src/pages/OrderBoardPage.tsx:export function OrderBoardPage
```

## API client — Order Board exported types and their fields
```regen: sed -n '/^\/\/ --- Order Board (routes/,/^export interface OrderBoardSettings {/p' frontend/src/api/client.ts | sed '$d' | grep -E '^export |^  [a-z_]+\??: |^}'; sed -n '/^export interface OrderBoardSettings {/,/^}/p' frontend/src/api/client.ts | grep -E '^export |^  [a-z_]+\??: |^}'```
```
export type OrderStatus = 'to_ship' | 'partial' | 'incoming' | 'to_order';
export type OrderLineState = 'ready' | 'backorder' | 'to_order' | 'shipped' | 'cancelled' | 'service';
export interface OrderBoardLine {
  id: string;
  item_id: string | null;
  name: string;
  sku: string;
  state: OrderLineState;
  quantity: number;
  shipped: number;
  cancelled: number;
  remaining: number;
  invoiced: number;
  packed_waiting: number;
  stock_available: number | null;
  covered: number;
  packable: number;
  shortfall: number;
  covered_by_po: number;
  po_numbers: string[];
}
export type OrderPayState = 'unpaid' | 'partial' | 'paid';
export interface OrderInvoice { id: string; number: string; date: string; due_date: string; total: number; balance: number; status: string; url: string | null }
export interface OrderPayment { state: OrderPayState; pct: number; paid: number; invoice_paid: number; advance: number; due: number; overdue: number; rest: number; left: number; next_due: string | null; invoices: OrderInvoice[] }
export interface OrderContact { name: string; email: string; phone: string; mobile: string }
export interface OrderFacts { channel: string; reference: string; delivery_method: string; payment_terms: string; shopify_url: string | null; quote_url: string | null }
export interface OrderPackage { id: string; shipment_id: string; number: string; status: string; date: string }
export interface OrderPicklist { id: string; number: string; status: string; date: string }
export interface OrderPickLines { lines: { line_id: string; quantity: number }[] }
export interface OrderBoardRow {
  id: string;
  number: string;
  customer: string;
  date: string;
  total: number | null;
  currency: string;
  status: OrderStatus;
  age_days: number;
  is_core: boolean;
  ready_ratio: number;
  packed: number;
  units: { total: number; shipped: number; ready: number; backordered: number; to_order: number };
  packages: OrderPackage[];
  picklists: OrderPicklist[];
  picked: number;
  unbilled_units: number;
  prep: { at: string; by: string } | null;
  lines: OrderBoardLine[];
  zoho_url: string | null;
  customer_id: string;
  payment: OrderPayment | null;
  contact: OrderContact | null;
  facts: OrderFacts;
}
export type OrderPanelRow = Omit<OrderBoardRow, 'status'>;
export type FinishedOrderDetail = OrderPanelRow & { status: 'finished' };
export interface FinishedOrderRow { id: string; number: string; customer: string; date: string; total: number | null; currency: string; reference: string; paid_flag: OrderPayState | null; payment: OrderPayment | null; zoho_url: string | null }
export interface OrderBoardResponse {
  rows: OrderBoardRow[];
  computed_at: string | null;
  stock_loaded_at: string | null;
  sync: {
}
export type OrderManualReason = 'order_money' | 'line_discount' | 'draft';
export interface OrderHandoverPreview {
  units: number;
  available: boolean;
  to_invoice: boolean;
  invoice_total: number | null;
  manual: boolean;
  manual_reason: OrderManualReason | null;
  credit: number;
  covered_by: string[];
}
export interface OrderHandoverOutcome {
  package_number: string;
  shipment: string;
  delivered: string;
  invoice: 'none' | 'created' | 'draft' | 'manual' | 'failed';
  invoice_number: string | null;
  manual_reason: OrderManualReason | null;
  credit_applied: number;
  failed_step: string | null;
  error: string | null;
}
export type OrderActionResult = { board: OrderBoardResponse; outcome: OrderHandoverOutcome };
export interface OrderBoardSettings {
  sync_enabled: boolean;
  sync_minutes: number;
  max_age_days: number;
  core_brands: string[];
}
```

## API client — orderBoardBlob, the order board methods and the endpoints they call
```regen: grep -E '^async function orderBoardBlob\(' frontend/src/api/client.ts | sed 's/ {$//'; awk '/^  getOrderBoard: /{p=1} p&&e&&/^  [^ ]/{exit} /^  updateOrderBoardSettings: /{e=1} p' frontend/src/api/client.ts | grep -E '^  [a-zA-Z]+: ' | sed -E 's/^  //; s/ =>.*//'; awk '/^  getOrderBoard: /{p=1} p&&e&&/^  [^ ]/{exit} /^  updateOrderBoardSettings: /{e=1} p' frontend/src/api/client.ts | tr '\n' ' ' | sed -E 's/ +/ /g' | grep -oE "(request<[^(]*>|orderBoardBlob)\((\`|')/order-board[^\`']*(\`|')(, \{ method: '[A-Z]+'|, '[A-Z]+')?" | sed -E 's/^request<.*>\(/request(/' | sort```
```
async function orderBoardBlob(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Blob>
getOrderBoard: ()
refreshOrderBoard: ()
getFinishedOrders: ()
getFinishedOrder: (id: string)
printOrderPrepSheet: (id: string, picklistId: string): Promise<Blob>
getOrderPicklistPreview: (id: string)
createOrderPicklist: (id: string, lines: OrderPickLines['lines'])
getOrderPicklist: (id: string, picklistId: string)
createOrderParcel: (id: string, picklistId: string, lines: OrderPickLines['lines'])
getOrderHandover: (id: string, packageId: string)
handOverOrderParcel: (id: string, packageId: string, body: { mode: 'pickup' | 'delivery'; apply_credit: boolean })
createOrderInvoice: (id: string, body: { apply_credit: boolean })
getOrderInvoicePdf: (invoiceId: string): Promise<Blob>
getOrderBoardSettings: ()
updateOrderBoardSettings: (body: OrderBoardSettings)
orderBoardBlob(`/order-board/invoices/${encodeURIComponent(invoiceId)}/pdf`
orderBoardBlob(`/order-board/orders/${encodeURIComponent(id)}/prep-sheet?picklist_id=${encodeURIComponent(picklistId)}`, 'POST'
request('/order-board'
request('/order-board/finished'
request('/order-board/refresh', { method: 'POST'
request('/order-board/settings'
request('/order-board/settings', { method: 'PUT'
request(`/order-board/finished/${encodeURIComponent(id)}`
request(`/order-board/orders/${encodeURIComponent(id)}/invoice`, { method: 'POST'
request(`/order-board/orders/${encodeURIComponent(id)}/packages/${encodeURIComponent(packageId)}/handover`
request(`/order-board/orders/${encodeURIComponent(id)}/packages/${encodeURIComponent(packageId)}/handover`, { method: 'POST'
request(`/order-board/orders/${encodeURIComponent(id)}/packages`, { method: 'POST'
request(`/order-board/orders/${encodeURIComponent(id)}/picklist`
request(`/order-board/orders/${encodeURIComponent(id)}/picklists/${encodeURIComponent(picklistId)}`
request(`/order-board/orders/${encodeURIComponent(id)}/picklists`, { method: 'POST'
```

## Translation keys of the `orders` namespace, nav/settings-tab labels (en; placeholders after the key)
```regen: mkdir -p /tmp/fenrir-refactor-probe && frontend/node_modules/.bin/rolldown tools/probe_orders_i18n_entry.ts --format cjs --file /tmp/fenrir-refactor-probe/ordersI18n.cjs >/dev/null 2>&1 && node tools/probe_orders_i18n.cjs | sed -n '/^--- en orders/,/^--- es orders/p' | grep -v '^--- es ' | sed -E 's/ = .*  placeholders=(.*)$/  \1/; s/ = .*//'```
```
--- en orders (190 keys)
orders.age  {{n}}
orders.busy
orders.chip.quote
orders.col.available
orders.col.product
orders.col.qty
orders.col.short
orders.col.state
orders.contact.alsoOpen
orders.contact.copied
orders.contact.copy  {{what}}
orders.contact.mailSubject  {{number}}
orders.contact.noEmail
orders.contact.noPhone
orders.contact.none
orders.contact.title
orders.coreOnly
orders.empty.core
orders.empty.coreHint
orders.empty.noResults
orders.empty.none
orders.empty.noneHint
orders.finished.chip
orders.finished.intro
orders.finished.loadFailed
orders.finished.loading
orders.finished.match  {{n}}
orders.finished.none
orders.finished.older
orders.finished.shipped
orders.finished.show
orders.firstSync  {{n}}
orders.group.other
orders.group.packed
orders.group.shipped
orders.group.todo
orders.handover.alreadyInvoiced  {{numbers}}
orders.handover.applyCredit  {{amount}}
orders.handover.confirmDelivery
orders.handover.confirmPickup
orders.handover.creditOffBoard
orders.handover.delivery
orders.handover.deliveryNote
orders.handover.doneDelivery  {{number}}
orders.handover.donePickup  {{number}}
orders.handover.due  {{amount}}
orders.handover.failed  {{reason}}
orders.handover.invoice  {{amount}}
orders.handover.invoiceCreated  {{number}}
orders.handover.invoiceFailed  {{reason}}
orders.handover.invoiceNoAmount
orders.handover.manual
orders.handover.manualDraft  {{number}}
orders.handover.meta  {{date}},{{units}}
orders.handover.modeLabel
orders.handover.nothingToInvoice
orders.handover.open
orders.handover.openNumber  {{number}}
orders.handover.pickup
orders.handover.pickupNote
orders.handover.prefillRefused
orders.handover.previewFailed
orders.handover.sending
orders.handover.settled
orders.hidden  {{n}}
orders.hint.incoming
orders.hint.partial
orders.hint.toOrder
orders.hint.toShip
orders.inv.create
orders.inv.download
orders.inv.draft
orders.inv.empty
orders.inv.nothing
orders.inv.open
orders.inv.pdfFailed
orders.inv.print
orders.inv.title
orders.inv.unbilled  {{units}}
orders.line.backorder
orders.line.cancelled
orders.line.invoiced
orders.line.packed
orders.line.ready
orders.line.service
orders.line.shipped
orders.line.toOrder
orders.loadFailed
orders.notConnected
orders.notConnectedHint
orders.ofOrdered  {{n}}
orders.packed  {{n}}
orders.parcel.create
orders.parcel.created  {{number}}
orders.parcel.creating
orders.parcel.failed  {{reason}}
orders.parcel.fromPick  {{number}},{{of}},{{units}}
orders.parcel.inParcel
orders.parcel.left  {{units}}
orders.parcel.less
orders.parcel.meta  {{date}}
orders.parcel.more
orders.parcel.stale
orders.pay.advanceNote
orders.pay.any
orders.pay.invDue  {{date}}
orders.pay.invLeft  {{amount}}
orders.pay.invOverdue  {{n}}
orders.pay.left
orders.pay.legendAdvance
orders.pay.legendDue
orders.pay.legendInvoice
orders.pay.legendOverdue
orders.pay.legendPaid
orders.pay.legendRest
orders.pay.nothingLeft
orders.pay.overdue
orders.pay.overdueChip
orders.pay.paid
orders.pay.partial
orders.pay.pct  {{pct}}
orders.pay.tile  {{pct}}
orders.pay.title
orders.pay.unpaid
orders.pick.boxed
orders.pick.create
orders.pick.created  {{number}}
orders.pick.failed  {{reason}}
orders.pick.meta
orders.pick.nothing
orders.pick.open
orders.pick.summary  {{of}},{{units}}
orders.pick.toPick
orders.pkg.delivered  {{date}},{{number}}
orders.pkg.packed  {{date}},{{number}}
orders.pkg.shipped  {{date}},{{number}}
orders.prep.inProgress
orders.prep.printFailed
orders.prep.printed  {{name}},{{time}}
orders.prep.printedNoName  {{time}}
orders.prep.reprint
orders.prep.sheet
orders.readyPct  {{pct}}
orders.refresh
orders.refreshFailed
orders.retry
orders.search
orders.settings.addBrand
orders.settings.coreBrands
orders.settings.coreBrandsHint
orders.settings.days
orders.settings.hour
orders.settings.interval
orders.settings.intervalHint
orders.settings.lastSync  {{when}}
orders.settings.maxAge
orders.settings.maxAgeHint
orders.settings.minutes  {{n}}
orders.settings.neverSynced
orders.settings.removeBrand  {{brand}}
orders.settings.saveFailed
orders.settings.saved
orders.settings.showsTitle
orders.settings.syncEnabled
orders.settings.syncEnabledHint
orders.settings.syncNow
orders.settings.syncTitle
orders.shipped  {{shipped}},{{total}}
orders.sort.age
orders.sort.customer
orders.sort.label
orders.sort.ready
orders.sort.value
orders.status.all
orders.status.inProgress
orders.status.incoming
orders.status.partial
orders.status.toOrder
orders.status.toShip
orders.syncFailed  {{reason}},{{when}}
orders.syncOff
orders.syncOffHint
orders.syncing  {{n}}
orders.title
orders.units_one  {{count}}
orders.units_other  {{count}}
orders.updated  {{when}}
nav.orders
settings.tabs.orders
common.cancel
```

## Translation keys the Order Board UI reads (string literals and templates)
```regen: grep -rhoE --include='*.ts' --include='*.tsx' "'(orders|nav|settings\.tabs|common)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*'|\`orders\.[a-zA-Z0-9_.]*\$\{[^}]*\}[a-zA-Z0-9_]*\`" frontend/src/components/orders frontend/src/pages/OrderBoardPage.tsx | sort -u```
```
'common.cancel'
'orders.age'
'orders.busy'
'orders.chip.quote'
'orders.col.available'
'orders.col.product'
'orders.col.qty'
'orders.col.short'
'orders.col.state'
'orders.contact.alsoOpen'
'orders.contact.copied'
'orders.contact.copy'
'orders.contact.mailSubject'
'orders.contact.noEmail'
'orders.contact.noPhone'
'orders.contact.none'
'orders.contact.title'
'orders.coreOnly'
'orders.empty.core'
'orders.empty.coreHint'
'orders.empty.noResults'
'orders.empty.none'
'orders.empty.noneHint'
'orders.finished.chip'
'orders.finished.intro'
'orders.finished.loadFailed'
'orders.finished.loading'
'orders.finished.match'
'orders.finished.none'
'orders.finished.older'
'orders.finished.shipped'
'orders.finished.show'
'orders.firstSync'
'orders.group.other'
'orders.group.packed'
'orders.group.shipped'
'orders.group.todo'
'orders.handover.alreadyInvoiced'
'orders.handover.applyCredit'
'orders.handover.confirmDelivery'
'orders.handover.confirmPickup'
'orders.handover.creditOffBoard'
'orders.handover.doneDelivery'
'orders.handover.donePickup'
'orders.handover.due'
'orders.handover.failed'
'orders.handover.invoice'
'orders.handover.invoiceCreated'
'orders.handover.invoiceFailed'
'orders.handover.invoiceNoAmount'
'orders.handover.manual'
'orders.handover.manualDraft'
'orders.handover.meta'
'orders.handover.modeLabel'
'orders.handover.nothingToInvoice'
'orders.handover.open'
'orders.handover.openNumber'
'orders.handover.prefillRefused'
'orders.handover.previewFailed'
'orders.handover.sending'
'orders.handover.settled'
'orders.hidden'
'orders.hint.incoming'
'orders.hint.partial'
'orders.hint.toOrder'
'orders.hint.toShip'
'orders.inv.create'
'orders.inv.download'
'orders.inv.draft'
'orders.inv.empty'
'orders.inv.nothing'
'orders.inv.open'
'orders.inv.pdfFailed'
'orders.inv.print'
'orders.inv.title'
'orders.inv.unbilled'
'orders.line.backorder'
'orders.line.cancelled'
'orders.line.invoiced'
'orders.line.packed'
'orders.line.ready'
'orders.line.service'
'orders.line.shipped'
'orders.line.toOrder'
'orders.loadFailed'
'orders.notConnected'
'orders.notConnectedHint'
'orders.ofOrdered'
'orders.packed'
'orders.parcel.create'
'orders.parcel.created'
'orders.parcel.creating'
'orders.parcel.failed'
'orders.parcel.fromPick'
'orders.parcel.inParcel'
'orders.parcel.left'
'orders.parcel.less'
'orders.parcel.meta'
'orders.parcel.more'
'orders.parcel.stale'
'orders.pay.advanceNote'
'orders.pay.any'
'orders.pay.invDue'
'orders.pay.invLeft'
'orders.pay.invOverdue'
'orders.pay.left'
'orders.pay.legendAdvance'
'orders.pay.legendDue'
'orders.pay.legendInvoice'
'orders.pay.legendOverdue'
'orders.pay.legendPaid'
'orders.pay.legendRest'
'orders.pay.nothingLeft'
'orders.pay.overdue'
'orders.pay.overdueChip'
'orders.pay.paid'
'orders.pay.partial'
'orders.pay.pct'
'orders.pay.tile'
'orders.pay.title'
'orders.pay.unpaid'
'orders.pick.boxed'
'orders.pick.create'
'orders.pick.created'
'orders.pick.failed'
'orders.pick.meta'
'orders.pick.nothing'
'orders.pick.open'
'orders.pick.summary'
'orders.pick.toPick'
'orders.pkg.delivered'
'orders.pkg.packed'
'orders.pkg.shipped'
'orders.prep.inProgress'
'orders.prep.printFailed'
'orders.prep.printed'
'orders.prep.printedNoName'
'orders.prep.reprint'
'orders.prep.sheet'
'orders.readyPct'
'orders.refresh'
'orders.refreshFailed'
'orders.retry'
'orders.search'
'orders.settings.addBrand'
'orders.settings.coreBrands'
'orders.settings.coreBrandsHint'
'orders.settings.days'
'orders.settings.hour'
'orders.settings.interval'
'orders.settings.intervalHint'
'orders.settings.lastSync'
'orders.settings.maxAge'
'orders.settings.maxAgeHint'
'orders.settings.minutes'
'orders.settings.neverSynced'
'orders.settings.removeBrand'
'orders.settings.saveFailed'
'orders.settings.saved'
'orders.settings.showsTitle'
'orders.settings.syncEnabled'
'orders.settings.syncEnabledHint'
'orders.settings.syncNow'
'orders.settings.syncTitle'
'orders.shipped'
'orders.sort.label'
'orders.status.all'
'orders.status.inProgress'
'orders.status.incoming'
'orders.status.partial'
'orders.status.toOrder'
'orders.status.toShip'
'orders.syncFailed'
'orders.syncOff'
'orders.syncOffHint'
'orders.syncing'
'orders.title'
'orders.units'
'orders.updated'
```

## React Query hooks, keys and invalidations in the Order Board components
```regen: grep -rhoE --include='*.ts' --include='*.tsx' 'useQuery|useMutation|useIsMutating|(query|mutation)Key: [^,}]*|[A-Z_]+_KEY = \[[^]]*\]|(invalidate|remove|cancel)Queries\([^)]*\)|setQueryData\([^,]*,' frontend/src/components/orders frontend/src/pages/OrderBoardPage.tsx | sort -u```
```
BOARD_KEY = ['order-board']
FINISHED_KEY = ['order-board', 'finished']
HANDOVER_KEY = ['order-hand-over']
SETTINGS_KEY = ['order-board-settings']
cancelQueries({ queryKey: BOARD_KEY, exact: true })
invalidateQueries({ queryKey: BOARD_KEY })
invalidateQueries({ queryKey: BOARD_KEY, exact: true })
invalidateQueries({ queryKey: FINISHED_KEY, exact: true })
invalidateQueries({ queryKey: ['order-board'], exact: true })
invalidateQueries({ queryKey: ['order-board-finished-order'] })
invalidateQueries({ queryKey: [...BOARD_KEY, 'finished'], exact: true })
mutationKey: HANDOVER_KEY
queryKey: BOARD_KEY
queryKey: FINISHED_KEY
queryKey: SETTINGS_KEY
queryKey: ['order-board-finished-order'
queryKey: ['order-handover'
removeQueries({ queryKey: ['order-handover', id] })
setQueryData(BOARD_KEY,
setQueryData(SETTINGS_KEY,
useIsMutating
useMutation
useQuery
```

## Wiring — route path, sidebar entry, Orders settings tab, URL parameters
```regen: grep -nE "OrderBoardPage|path=\"orders\"" frontend/src/App.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "id: .orders.|orders: .orders:read." frontend/src/components/Layout.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "OrdersSettingsCard|canSeeOrdersTab = |tab: .orders.|tab === .orders." frontend/src/pages/SettingsPage.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -rhoE "searchParams\.get\(.[a-z]+.\)|[?&](order|tab)=" frontend/src/pages/OrderBoardPage.tsx backend/app/api/routes/order_board.py | sort -u```
```
const loadOrderBoardPage = () => import('./pages/OrderBoardPage').then(m => ({ default: m.OrderBoardPage }));
const OrderBoardPage = lazyWithReload(loadOrderBoardPage);
[/^\/orders\/?$/, loadOrderBoardPage],
<Route path="orders" element={<PermissionRoute permission="orders:read"><OrderBoardPage /></PermissionRoute>} />
{ id: 'orders', to: '/orders', icon: PackageCheck, labelKey: 'nav.orders' },
orders: 'orders:read',
import { OrdersSettingsCard } from '../components/orders/OrdersSettingsCard'; // Fenrir: Orders tab
const canSeeOrdersTab = hasPermission('orders:update'); // Fenrir: Orders tab
? [{ tab: 'orders', icon: PackageCheck, label: t('settings.tabs.orders') } as SettingsTabEntry]
{tab === 'orders' && (
<OrdersSettingsCard />
?order=
searchParams.get('order')
```

