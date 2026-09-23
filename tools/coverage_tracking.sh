#!/bin/bash
# Campaign-19 coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only (the client tracking feature).
# Run from repo root: bash tools/coverage_tracking.sh [frontend|backend|both]
#
# The include lists below ARE the scope definition for coverage. Non-glob
# entries are existence-checked so a rename fails loudly instead of silently
# dropping a file from the gate.
#
# Backend coverage is measured wide (the whole app package) and reported
# narrow (cov_filter.py): the scope cannot be quietly widened to inflate the
# number, and a scope file that stops being imported reads as a miss rather
# than vanishing from the report. The RATCHET is the two files the feature
# owns outright; routes/aito.py (which holds the tracking routes among ~4000
# lines of unrelated board code) is printed whole for information only.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_FILES=(
  frontend/src/pages/AitoTrackPage.tsx
  frontend/src/pages/AitoTrackEntryPage.tsx
  frontend/src/components/aito/TrackCollapse.tsx
  frontend/src/components/aito/TrackingCodeInput.tsx
  frontend/src/components/aito/TrackingInvoice.tsx
  frontend/src/components/aito/TrackingLanguageSelect.tsx
  frontend/src/components/aito/TrackingLinkControl.tsx
  frontend/src/components/aito/TrackingPanel.tsx
  frontend/src/components/aito/TrackingPayment.tsx
  frontend/src/components/aito/TrackingPaymentMethods.tsx
  frontend/src/components/aito/TrackingRail.tsx
  frontend/src/components/aito/TrackingShopPanel.tsx
  frontend/src/components/aito/trackingShell.tsx
  frontend/src/hooks/useTrackingLanguage.ts
  frontend/src/hooks/useTrackingPanel.ts
  frontend/src/utils/aitoTracking.ts
  frontend/src/utils/trackingCode.ts
  frontend/src/utils/trackingShell.ts
)

BE_FILES=(
  backend/app/services/aito_tracking.py
  backend/app/models/aito_tracking_view.py
)
BE_INFO=(
  backend/app/api/routes/aito.py
)

missing=0
for f in "${FE_FILES[@]}" "${BE_FILES[@]}" "${BE_INFO[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_tracking.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: client tracking) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 8 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-tracking-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  echo "--- RATCHET (feature-owned files) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-tracking-backend.json "${BE_FILES[@]}" || rc=1
  echo "--- INFO ONLY (routes/aito.py, whole file) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-tracking-backend.json "${BE_INFO[@]}" || true
  # pytest-cov rewrites the (tracked, campaign-1 leak) .coverage file; put it back so it never rides into a commit.
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: client tracking) ==="
  ARGS=()
  for f in "${FE_FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
  # reportOnFailure: the documented load flakes must not suppress the report —
  # the ratchet needs a number even on a run where a known flake fires.
  ( cd frontend && npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -12 ) || rc=1
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
