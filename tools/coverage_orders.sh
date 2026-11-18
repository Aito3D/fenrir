#!/bin/bash
# Campaign O3 (Order Board) coverage gate: runs the FULL suites, measures coverage over the campaign SCOPE only.
# Run from repo root: bash tools/coverage_orders.sh [frontend|backend|both]
#
# Scope is given as globs so a file a worker splits out of a scope module is counted automatically.
# Backend is measured wide (whole app package) and reported narrow (cov_filter.py), so the scope cannot be
# quietly widened to inflate the number. RATCHET = scoped statements on each side.
# Set COVERAGE_FILE / OUT_DIR to keep concurrent runs apart (defaults write into /tmp).
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"
OUT_DIR="${OUT_DIR:-/tmp/fenrir-orders-cov}"
mkdir -p "$OUT_DIR"

BE_GLOBS=(
  'backend/app/api/routes/order_board/*.py'
  'backend/app/services/order_board*.py'
  'backend/app/services/order_board_actions/*.py'
  'backend/app/services/order_board_sync/*.py'
  'backend/app/models/order_board_*.py'
)
FE_GLOBS=(
  'src/components/orders/**'
  'src/pages/OrderBoardPage.tsx'
  'src/pages/OrderTrackPage.tsx'
  'src/utils/orderTracking.ts'
)

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Order Board) ==="
  COVERAGE_FILE="${COVERAGE_FILE:-$OUT_DIR/.coverage}" ./venv/bin/python3 -m pytest backend/tests/ -q -n 8 -p no:randomly \
    -p no:cacheprovider --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report="json:$OUT_DIR/backend.json" --cov-report= 2>&1 | tail -15 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  ./venv/bin/python3 tools/cov_filter.py "$OUT_DIR/backend.json" "${BE_GLOBS[@]}" || rc=1
  # pytest-cov may still touch the tracked root .coverage; put it back so it never rides into a commit.
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Order Board) ==="
  ARGS=()
  for g in "${FE_GLOBS[@]}"; do ARGS+=("--coverage.include=$g"); done
  # reportOnFailure: a load flake must not suppress the report. The dot reporter keeps the pass/fail line visible.
  ( cd frontend && node_modules/.bin/vitest run --reporter=dot --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reportsDirectory="$OUT_DIR/frontend" \
      --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | grep -E "Test Files|Tests |FAIL|failed" | tail -30 ) || rc=1
  echo "--- per-file ($OUT_DIR/frontend/coverage-summary.json) ---"
  node -e '
const s = require(process.argv[1]);
for (const [f, v] of Object.entries(s)) if (f !== "total") console.log(String(v.statements.pct).padStart(7) + "%  " + f.replace(/.*\/src\//, "src/") + "  " + v.statements.covered + "/" + v.statements.total);
const t = s.total;
console.log("\nSCOPED statements: " + t.statements.covered + "/" + t.statements.total + " = " + t.statements.pct + "%   <- RATCHET METRIC");
console.log("SCOPED branches:   " + t.branches.covered + "/" + t.branches.total + " = " + t.branches.pct + "%");
console.log("SCOPED functions:  " + t.functions.covered + "/" + t.functions.total + " = " + t.functions.pct + "%");
console.log("SCOPED lines:      " + t.lines.covered + "/" + t.lines.total + " = " + t.lines.pct + "%");
' "$OUT_DIR/frontend/coverage-summary.json" || rc=1
fi
exit $rc
