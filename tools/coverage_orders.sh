#!/bin/bash
# Order-board campaign (O2) coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only — the Order Board (/orders: Zoho Books sales orders vs
# stock, the bounded sync pass, pick/pack/hand-over/invoice actions, the prep sheet, the Orders settings tab).
# Run from repo root: bash tools/coverage_orders.sh [frontend|backend|both]
#
# Backend coverage is measured wide (the whole app package) and reported
# narrow (cov_filter.py globs): the scope cannot be quietly widened to inflate
# the number, and a scope file that stops being imported reads as a miss rather
# than vanishing from the report. Anchor files are existence-checked so a
# rename fails loudly.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_INCLUDES=(
  'src/components/orders/**'
  'src/pages/OrderBoardPage.tsx'
)
BE_GLOBS=(
  'backend/app/api/routes/order_board.py'
  'backend/app/services/order_board.py'
  'backend/app/services/order_board_sync.py'
  'backend/app/services/order_board_actions.py'
  'backend/app/services/order_board_payment.py'
  'backend/app/services/order_board_prep_sheet.py'
  'backend/app/models/order_board_doc.py'
)
ANCHORS=(
  frontend/src/components/orders/orderBoard.ts
  frontend/src/components/orders/OrdersSettingsCard.tsx
  frontend/src/pages/OrderBoardPage.tsx
  backend/app/api/routes/order_board.py
  backend/app/services/order_board.py
  backend/app/services/order_board_sync.py
  backend/app/services/order_board_actions.py
  backend/app/services/order_board_payment.py
  backend/app/services/order_board_prep_sheet.py
  backend/app/models/order_board_doc.py
  frontend/src/components/orders/useOrderActions.ts
  frontend/src/components/orders/OrderLinesPanel.tsx
)

missing=0
for f in "${ANCHORS[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_orders.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Order Board) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-orders-backend.json --cov-report= 2>&1 | tail -30 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-orders-backend.json "${BE_GLOBS[@]}" || rc=1
  # pytest-cov rewrites the (tracked, campaign-1 leak) .coverage file; put it back so it never rides into a commit.
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Order Board) ==="
  ARGS=()
  for g in "${FE_INCLUDES[@]}"; do ARGS+=("--coverage.include=$g"); done
  # reportOnFailure: the documented load flakes must not suppress the report —
  # the ratchet needs a number even on a run where a known flake fires.
  ( cd frontend && npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -60 ) || rc=1
  # The text table hides fully-covered files; the JSON summary is the record.
  echo "--- per-file (coverage/coverage-summary.json) ---"
  node -e '
const s = require("./frontend/coverage/coverage-summary.json");
for (const [f, v] of Object.entries(s)) if (f !== "total") console.log(String(v.statements.pct).padStart(7) + "%  " + f.replace(/.*\/src\//, "src/") + "  " + v.statements.covered + "/" + v.statements.total);
const t = s.total;
console.log("\nSCOPED statements: " + t.statements.covered + "/" + t.statements.total + " = " + t.statements.pct + "%   <- RATCHET METRIC");
console.log("SCOPED branches:   " + t.branches.covered + "/" + t.branches.total + " = " + t.branches.pct + "%");
console.log("SCOPED functions:  " + t.functions.covered + "/" + t.functions.total + " = " + t.functions.pct + "%");
console.log("SCOPED lines:      " + t.lines.covered + "/" + t.lines.total + " = " + t.lines.pct + "%");
' || rc=1
fi
exit $rc
