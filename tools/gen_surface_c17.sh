#!/bin/bash
# Campaign-17 SURFACE.md generator: the whole app's public contract, plus the
# Heimdall payment-link surface in detail.
#
# Regenerate with:  bash tools/gen_surface_c17.sh > SURFACE.md
#
# Sections 1-8 are the whole-app contract inherited from gen_surface_all.sh
# (routes, permissions, settings, service defs, frontend exports, API client,
# pages, tables) — coarse on purpose, so a change anywhere in the app still
# shows. Sections 9+ are this campaign's SCOPE at full resolution: every
# signature in the two payment-link modules, the ledger table column by
# column, the wire-visible schema fields, the settings keys the feature reads,
# and its i18n keys. Every section names the exact command that produces it,
# so the file is byte-replayable by re-running that command.
set -u
cd "$(dirname "$0")/.." || exit 1

V=./venv/bin/python3

# --- whole-app sections (same commands as tools/gen_surface_all.sh) ---------
R1='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\")]" 2>/dev/null'
R2='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.permissions import ALL_PERMISSIONS; [print(p) for p in sorted(ALL_PERMISSIONS)]" 2>/dev/null'
R3='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.config import settings; [print(n, \"=\", repr(f.default)) for n, f in sorted(type(settings).model_fields.items())]" 2>/dev/null'
R4='grep -hE "^(def|class|async def) [a-zA-Z]" backend/app/services/*.py | sort | uniq -c | sed "s/^ *//"'
R5='grep -rhoE "^export (default function|function|const|type|interface|class|enum) [A-Za-z0-9_]+" frontend/src/utils frontend/src/hooks --include="*.ts" --include="*.tsx" | sort'
R6='{ awk "/^export const api = \\{/{f=1} f&&/^  [a-zA-Z0-9_]+:/{gsub(/:.*/,\"\"); gsub(/ /,\"\"); print} f&&/^\\};?$/{exit}" frontend/src/api/client.ts; grep -oE "^export (const|async function|function) [a-zA-Z0-9_]+" frontend/src/api/client.ts | sed "s/^export [a-z ]*//"; } | sort'
R7='ls frontend/src/pages/*.tsx | xargs -n1 basename | sort'
R8='PYTHONHASHSEED=0 ./venv/bin/python3 -c "import backend.app.main; from backend.app.core.database import Base; [print(n, len(t.columns)) for n, t in sorted(Base.metadata.tables.items())]" 2>/dev/null'

# --- campaign-17 scope sections --------------------------------------------
# Every def/class in the two payment-link modules, WITH its signature: these
# are the seams the reconciler, the routes and the tests all call through, so a
# renamed parameter or a dropped keyword-only marker is a contract change.
S9='grep -nE "^(async def|def|class) " backend/app/services/heimdall.py backend/app/services/aito_payment_links.py | sed "s/:[0-9]*:/: /"'
# The ledger table, column by column (type, nullability, default, uniqueness)
# — the money record'"'"'s shape.
S10='PYTHONHASHSEED=0 ./venv/bin/python3 -c "
import backend.app.main
from backend.app.core.database import Base
t = Base.metadata.tables[\"aito_payment_links\"]
for c in t.columns:
    d = getattr(c.server_default, \"arg\", None)
    # A SQL function default (func.now()) reprs with its memory address, so
    # name the callable instead of repring the object.
    d = None if d is None else (getattr(d, \"name\", None) or repr(d))
    print(c.name, c.type, \"nullable\" if c.nullable else \"NOT NULL\", \"unique\" if c.unique else \"-\", d)
for i in sorted(t.indexes, key=lambda i: i.name):
    print(\"index\", i.name, sorted(col.name for col in i.columns))
" 2>/dev/null'
# The wire-visible schemas: field names, types and defaults, exactly as a
# client sees them.
S11='PYTHONHASHSEED=0 ./venv/bin/python3 -c "
from backend.app.schemas.heimdall import HeimdallStatus, HeimdallTestRequest
from backend.app.schemas.aito import AitoPaymentLinkView
for m in (HeimdallTestRequest, HeimdallStatus, AitoPaymentLinkView):
    print(m.__name__)
    for n, f in m.model_fields.items():
        print(\"  \", n, f.annotation, repr(f.default))
" 2>/dev/null'
# The OpenAPI fragment for every payment-link / heimdall endpoint: the public
# request and response contract, not just the path.
S12='PYTHONHASHSEED=0 ./venv/bin/python3 -c "
import json
from backend.app.main import app
spec = app.openapi()
for path in sorted(spec[\"paths\"]):
    if \"heimdall\" in path or \"payment-link\" in path:
        for method in sorted(spec[\"paths\"][path]):
            op = spec[\"paths\"][path][method]
            print(method.upper(), path, \"->\", sorted(op.get(\"responses\", {})))
            print(\"   body:\", json.dumps(op.get(\"requestBody\"), sort_keys=True))
" 2>/dev/null'
# The tunables the feature reads: a changed default or a dropped key changes
# how much money a link asks for.
S13='PYTHONHASHSEED=0 ./venv/bin/python3 -c "
from backend.app.services import aito_payment_links as PL
for n in sorted(dir(PL)):
    if n == \"TYPE_CHECKING\":
        continue
    if n.isupper() or n in (\"_TICK_SECONDS\", \"_MAX_BACKOFF_TICKS\", \"_DEAD_STATUSES\", \"_CLOSED_QUOTE_STATUSES\"):
        v = getattr(PL, n)
        print(n, \"=\", sorted(v) if isinstance(v, frozenset) else v)
from backend.app.services import heimdall as HD
print(\"_TIMEOUT_SECONDS =\", HD._TIMEOUT_SECONDS)
from backend.app.api.routes import aito as A
print(\"_PAYMENT_LINK_REFRESH_MAX_CALLS =\", A._PAYMENT_LINK_REFRESH_MAX_CALLS)
print(\"_AI_RATE_LIMIT_WINDOW_S =\", A._AI_RATE_LIMIT_WINDOW_S)
" 2>/dev/null'
# Default values of the feature'"'"'s settings keys, as the DB layer reports them.
S14='grep -hoE "\"(heimdall_[a-z_]+|aito_deposit_pct|aito_quote_validity_days)\"" backend/app/api/routes/settings.py backend/app/schemas/settings.py backend/app/services/aito_payment_links.py backend/app/services/heimdall.py | sort | uniq -c | sed "s/^ *//"'
# The i18n keys the feature'"'"'s UI renders, per locale: a key deleted in one
# language only is a user-visible regression the parity probe alone can miss.
S15='for f in frontend/src/i18n/locales/*.ts; do printf "%s " "$(basename "$f")"; grep -coE "^\s+(heimdall|paymentLink)[A-Za-z0-9_]*:" "$f"; done'
# The frontend components and the API-client calls that drive the feature.
S16='{ grep -hoE "^export (default function|function|const) [A-Za-z0-9_]+" frontend/src/components/HeimdallSettings.tsx frontend/src/components/aito/PaymentLinkRow.tsx; grep -hoE "(PaymentLink[A-Za-z]*|payment-link/[a-z]+|heimdall/[a-z]+|heimdall_[a-z_]+)" frontend/src/api/client.ts | sort -u; grep -hoE "^  (refreshPaymentLink|testHeimdall)[A-Za-z0-9_]*" frontend/src/api/client.ts; } | sort'

emit() {  # emit <heading> <regen-cmd>
  echo "## $1"
  echo "\`\`\`regen: $2\`\`\`"
  echo '```'
  eval "$2"
  echo '```'
  echo ''
}

echo '# SURFACE.md — campaign-17 public contract (frozen at setup)'
echo ''
echo 'Scope: the Heimdall payment-link feature. Sections 1-8 are the whole-app'
echo 'contract; sections 9-16 are the payment-link surface at full resolution.'
echo ''
echo 'Regenerate every section with `bash tools/gen_surface_c17.sh > SURFACE.md`.'
echo 'Each section names the exact command that produces it. ANY diff against this'
echo 'file is a change to the app'"'"'s public contract and fails the iteration.'
echo ''
emit 'HTTP routes (path + methods)' "$R1"
emit 'Permission catalogue' "$R2"
emit 'Settings / environment surface (name = default)' "$R3"
emit 'Backend service top-level defs (count per signature)' "$R4"
emit 'Frontend exported symbols — utils + hooks' "$R5"
emit 'Frontend API client methods' "$R6"
emit 'Frontend pages' "$R7"
emit 'Database tables (name, column count)' "$R8"
emit 'SCOPE: payment-link module signatures' "$S9"
emit 'SCOPE: aito_payment_links table, column by column' "$S10"
emit 'SCOPE: wire schemas (HeimdallTestRequest, HeimdallStatus, AitoPaymentLinkView)' "$S11"
emit 'SCOPE: OpenAPI fragment for the payment-link endpoints' "$S12"
emit 'SCOPE: reconciler tunables' "$S13"
emit 'SCOPE: settings keys the feature reads' "$S14"
emit 'SCOPE: i18n key counts per locale' "$S15"
emit 'SCOPE: frontend components and API-client calls' "$S16"
