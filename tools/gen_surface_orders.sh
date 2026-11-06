#!/bin/bash
# Order-board campaign (O1) SURFACE generator: the Order Board's public contract
# (HTTP routes with their permissions, backend public callables, request
# schemas, the table, settings keys, permissions, the Zoho calls, registration
# points, frontend exports, API client types/methods, i18n keys, wiring).
# Regenerate the whole file with:  bash tools/gen_surface_orders.sh > SURFACE.md
# (when comparing, write to a scratch file first and diff: a failing section
# prints a `### SURFACE FAILURE` line or comes out empty, and must not replace
# the committed copy unnoticed).
# Every section is produced by the `regen:` command printed above it, run from
# the repo root with LC_ALL=C, so the file is byte-replayable. ANY diff = a
# surface change = the iteration FAILS unless the user approved it
# (BASELINE-CHANGELOG.md entry in the same commit).
# No section pins line numbers or counts occurrences (names, routes, order only):
# moving code inside a file, or naming a repeated literal, moves nothing here.
set -u
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C PYTHONHASHSEED=0

BE_ROUTES='backend/app/api/routes/order_board.py'
BE_SVC='backend/app/services/order_board.py backend/app/services/order_board_actions.py backend/app/services/order_board_payment.py backend/app/services/order_board_prep_sheet.py backend/app/services/order_board_sync.py'
BE_SRC="$BE_ROUTES $BE_SVC backend/app/models/order_board_doc.py"
FE_SRC='frontend/src/components/orders frontend/src/pages/OrderBoardPage.tsx'
CLIENT='frontend/src/api/client.ts'
PY='./venv/bin/python3 tools/probe_orders_surface.py'

R1="$PY routes 2>/dev/null"
R2="grep -hE '^@[a-z_]*router\.(get|post|put|patch|delete)\(' $BE_ROUTES | sed 's/, *\$//' | sort"
R3="$PY callables 2>/dev/null"
R4="$PY schemas 2>/dev/null"
R5="$PY ddl 2>/dev/null"
R6="grep -hoE 'kind ?==? ?\"[a-z]+\"|kind\.in_\(\(\"[a-z]+\", \"[a-z]+\"\)\)|zoho_id ?==? ?\"[a-z]+\"' $BE_SRC | sed -E 's/ ?(==|=) ?/ = /' | sort -u; grep -hoE '\"(rows|computed_at|stock_loaded_at|last_error|last_error_at|last_success_at|payments_since|_fetched_at|_stale)\"' $BE_SRC | sort -u"
R7="grep -hoE '(get_setting|set_setting)\(db, \"[a-z_]+\"|number\(\"[a-z_]+\"' $BE_SRC | sed -E 's/\(db, /(/' | sort -u; grep -hoE 'get_setting\(db, \"external_url\"' backend/app/services/aito_tracking.py | sed -E 's/\(db, /(/; s/\$/  (aito_tracking.external_url, the prep sheet link)/' | sort -u; sed -n '/^_REQUIRED_KEYS = /p; /async def _load_config/,/return config/p' backend/app/services/zoho.py | grep -oE '\"zoho_[a-z_]+\"' | sort -u | sed 's/^/zoho config: /'; echo 'env vars:'; grep -hoE 'os\.environ[^)]*\)|os\.getenv\([^)]*\)|env_get\([^)]*\)' $BE_SRC | sort -u"
R8="$PY permissions 2>/dev/null; grep -oE \"'orders:(read|update)'\" $CLIENT | sort -u | sed 's/^/frontend Permission union: /'; grep -rhoE \"hasPermission\('orders:[a-z]+'\)|permission=\\\"orders:[a-z]+\\\"|orders: 'orders:[a-z]+'\" frontend/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ | sort -u"
R9="$PY zoho 2>/dev/null"
R10="sed -n '/# --- Order Board: read-only listings/,/async def get_shipping_catalogue/p; /async def picklist_prefill/,/async def get_invoice_raw/p' backend/app/services/zoho.py | grep -E '^    (async )?def ' | grep -vE 'get_shipping_catalogue|get_invoice_raw' | sed -E 's/^ *//; s/\(.*//'"
R11='grep -nE "order_board|OrderBoardDoc" backend/app/main.py backend/app/models/__init__.py backend/app/core/database.py | sed -E "s/:[0-9]+:[[:space:]]*/: /"'
R12="grep -rHoE --include='*.ts' --include='*.tsx' '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' $FE_SRC | sort"
R13="sed -n '/^\/\/ --- Order Board (routes/,/^export interface OrderBoardSettings {/p' $CLIENT | sed '\$d' | grep -E '^export |^  [a-z_]+\??: |^}'; sed -n '/^export interface OrderBoardSettings {/,/^}/p' $CLIENT | grep -E '^export |^  [a-z_]+\??: |^}'"
R14="grep -E '^async function orderBoardBlob\(' $CLIENT | sed 's/ {\$//'; awk '/^  getOrderBoard: /{p=1} p&&e&&/^  [^ ]/{exit} /^  updateOrderBoardSettings: /{e=1} p' $CLIENT | grep -E '^  [a-zA-Z]+: ' | sed -E 's/^  //; s/ =>.*//'; awk '/^  getOrderBoard: /{p=1} p&&e&&/^  [^ ]/{exit} /^  updateOrderBoardSettings: /{e=1} p' $CLIENT | tr '\n' ' ' | sed -E 's/ +/ /g' | grep -oE \"(request<[^(]*>|orderBoardBlob)\((\\\`|')/order-board[^\\\`']*(\\\`|')(, \{ method: '[A-Z]+'|, '[A-Z]+')?\" | sed -E 's/^request<.*>\(/request(/' | sort"
R15="mkdir -p /tmp/fenrir-refactor-probe && frontend/node_modules/.bin/rolldown tools/probe_orders_i18n_entry.ts --format cjs --file /tmp/fenrir-refactor-probe/ordersI18n.cjs >/dev/null 2>&1 && node tools/probe_orders_i18n.cjs | sed -n '/^--- en orders/,/^--- es orders/p' | grep -v '^--- es ' | sed -E 's/ = .*  placeholders=(.*)\$/  \1/; s/ = .*//'"
R16="grep -rhoE --include='*.ts' --include='*.tsx' \"'(orders|nav|settings\.tabs|common)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*'|\\\`orders\.[a-zA-Z0-9_.]*\\\$\{[^}]*\}[a-zA-Z0-9_]*\\\`\" $FE_SRC | sort -u"
R17="grep -rhoE --include='*.ts' --include='*.tsx' 'useQuery|useMutation|useIsMutating|(query|mutation)Key: [^,}]*|[A-Z_]+_KEY = \[[^]]*\]|(invalidate|remove|cancel)Queries\([^)]*\)|setQueryData\([^,]*,' $FE_SRC | sort -u"
R18='grep -nE "OrderBoardPage|path=\"orders\"" frontend/src/App.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "id: .orders.|orders: .orders:read." frontend/src/components/Layout.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "OrdersSettingsCard|canSeeOrdersTab = |tab: .orders.|tab === .orders." frontend/src/pages/SettingsPage.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -rhoE "searchParams\.get\(.[a-z]+.\)|[?&](order|tab)=" frontend/src/pages/OrderBoardPage.tsx backend/app/api/routes/order_board.py | sort -u'

emit() { # emit <heading> <cmd>
  local heading="$1" cmd="$2"
  echo "## $heading"
  echo "\`\`\`regen: $cmd\`\`\`"
  echo '```'
  eval "$cmd"
  echo '```'
  echo ''
}

echo '# SURFACE.md — order-board campaign (O1) public contract: the Order Board (frozen at setup)'
echo ''
echo 'Regenerate with: `bash tools/gen_surface_orders.sh > SURFACE.md` (from the repo root).'
echo 'Each section is replayable by the `regen:` command shown above it (repo root,'
echo '`LC_ALL=C`). Any diff against the committed copy is a change to something'
echo 'outside the feature`s own internals — a route or its permission, a public'
echo 'function signature, a request schema, a table column, a stored key, a'
echo 'setting or permission the feature reads, a Zoho call, an exported symbol, an'
echo 'API client type or method, a translation key, the wiring — and fails the'
echo 'iteration unless the user approved it.'
echo ''

emit 'HTTP routes under /order-board: method, path, handler, required permission' "$R1"
emit 'Route decorators (routes/order_board.py)' "$R2"
emit 'Backend public functions, classes and constants (routes, model, the five services), with signatures' "$R3"
emit 'Request body schemas (routes/order_board.py), as JSON Schema' "$R4"
emit 'Table the feature owns — DDL (order_board_docs), SQLite and PostgreSQL' "$R5"
emit 'Stored row kinds and the JSON keys kept in them (an existing database must stay readable)' "$R6"
emit 'Settings keys and env vars the feature reads or writes' "$R7"
emit 'Permissions: values, default groups, API keys, and where the frontend checks them' "$R8"
emit 'ZohoService members the order modules call, with signatures and callers' "$R9"
emit 'Zoho methods that exist only for the Order Board (services/zoho.py)' "$R10"
emit 'Registration points (main.py, models/__init__.py, core/database.py)' "$R11"
emit 'Frontend exported symbols, per file (components/orders/**, pages/OrderBoardPage.tsx)' "$R12"
emit 'API client — Order Board exported types and their fields' "$R13"
emit 'API client — orderBoardBlob, the order board methods and the endpoints they call' "$R14"
emit 'Translation keys of the `orders` namespace, nav/settings-tab labels (en; placeholders after the key)' "$R15"
emit 'Translation keys the Order Board UI reads (string literals and templates)' "$R16"
emit 'React Query hooks, keys and invalidations in the Order Board components' "$R17"
emit 'Wiring — route path, sidebar entry, Orders settings tab, URL parameters' "$R18"
