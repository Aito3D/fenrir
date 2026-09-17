#!/bin/bash
# Campaign-17 coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE — the Heimdall payment-link feature.
#
# Run from repo root:  bash tools/coverage_c17.sh [frontend|backend|both]
#
# The lists below ARE the scope definition for coverage. Every non-glob entry
# is existence-checked first, so a rename fails loudly instead of silently
# dropping a file from the gate. coverage.py measures the whole backend
# package and cov_filter.py then reports only the scope: measuring wide and
# filtering narrow means the scope cannot be quietly widened to inflate the
# number, and a scope file that stops being imported reads as a miss rather
# than vanishing.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

BE_FILES=(
  backend/app/services/heimdall.py
  backend/app/services/aito_payment_links.py
  backend/app/api/routes/heimdall.py
  backend/app/schemas/heimdall.py
  backend/app/models/aito_payment_link.py
  backend/app/api/routes/aito.py
  backend/app/schemas/aito.py
  backend/app/services/aito_quote_sync.py
  backend/app/services/aito_tracking.py
)
FE_FILES=(
  frontend/src/components/HeimdallSettings.tsx
  frontend/src/components/aito/PaymentLinkRow.tsx
)

missing=0
for f in "${BE_FILES[@]}" "${FE_FILES[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_c17.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Heimdall payment links) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 12 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-c17-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  ./venv/bin/python3 tools/cov_filter.py coverage-c17-backend.json \
    'backend/app/services/heimdall.py' \
    'backend/app/services/aito_payment_links.py' \
    'backend/app/api/routes/heimdall.py' \
    'backend/app/schemas/heimdall.py' \
    'backend/app/models/aito_payment_link.py' \
    'backend/app/api/routes/aito.py' \
    'backend/app/schemas/aito.py' \
    'backend/app/services/aito_quote_sync.py' \
    'backend/app/services/aito_tracking.py' || rc=1
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Heimdall payment links) ==="
  ARGS=()
  for f in "${FE_FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
  # reportOnFailure: the documented load-flakes (PrintModal, CalculatorPage,
  # ModelViewerModal) must not suppress the report — the ratchet needs a
  # number even on a run where a known flake fires.
  ( cd frontend && npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -30 ) || rc=1
fi
exit $rc
