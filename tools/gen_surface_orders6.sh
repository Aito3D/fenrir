#!/bin/bash
# Campaign O6 (order code, wide) SURFACE generator = the O3-O5 Order Board contract
# (tools/gen_surface_orders.sh, unchanged) + the public names of the integration and
# payment services the order page calls.
# Regenerate with:  bash tools/gen_surface_orders6.sh > /tmp/surface-o6.md 2>/dev/null && mv /tmp/surface-o6.md SURFACE.md
set -u
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C

bash tools/gen_surface_orders.sh

EXTRA='backend/app/services/zoho.py backend/app/services/heimdall.py backend/app/services/aito_payment_links.py backend/app/services/aito_terminal_payments.py backend/app/services/aito_manual_payments.py backend/app/services/aito_customer_credit.py backend/app/services/aito_payment_documents.py backend/app/services/aito_client_rating.py backend/app/services/aito_events.py backend/app/services/aito_tracking.py backend/app/api/routes/aito_payments.py backend/app/api/routes/zoho.py backend/app/api/routes/heimdall.py'
R16='for f in '"$EXTRA"'; do echo "# $f"; grep -E "^(def|class|async def) [a-zA-Z]|^[A-Z][A-Z_0-9]* = |^[A-Z][A-Z_0-9]*: " "$f" | sed -E "s/ = .*/ =/; s/(def [a-zA-Z_0-9]+)\(.*/\1(/"; done'
R17='grep -HE "^@router\.(get|post|put|delete|patch)\(" backend/app/api/routes/aito_payments.py backend/app/api/routes/zoho.py backend/app/api/routes/heimdall.py'

echo '## O6 — public functions, classes and constants (integration + payment services)'
echo "\`\`\`regen: $R16\`\`\`"
echo '```'
eval "$R16"
echo '```'
echo ''
echo '## O6 — route decorators (aito_payments, zoho, heimdall)'
echo "\`\`\`regen: $R17\`\`\`"
echo '```'
eval "$R17"
echo '```'
