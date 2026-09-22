#!/bin/bash
# Campaign-18 coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only (the Aito statistics feature).
# Run from repo root: bash tools/coverage_stats.sh [frontend|backend|both]
#
# The include lists below ARE the scope definition for coverage. Non-glob
# entries are existence-checked so a rename fails loudly instead of silently
# dropping a file from the gate.
#
# Backend coverage is measured wide (the whole app package) and reported
# narrow (cov_filter.py): the scope cannot be quietly widened to inflate the
# number, and a scope file that stops being imported reads as a miss rather
# than vanishing from the report.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_FILES=(
  frontend/src/components/aito/StatsView.tsx
)
FE_GLOBS=( 'src/components/aito/stats/**' )

BE_FILES=(
  backend/app/services/aito_stats.py
)

missing=0
for f in "${FE_FILES[@]}" "${BE_FILES[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_stats.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Aito statistics) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 8 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-stats-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  ./venv/bin/python3 tools/cov_filter.py coverage-stats-backend.json \
    'backend/app/services/aito_stats.py' || rc=1
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Aito statistics) ==="
  ARGS=()
  for f in "${FE_FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
  for g in "${FE_GLOBS[@]}"; do ARGS+=("--coverage.include=$g"); done
  # reportOnFailure: the documented load flakes must not suppress the report —
  # the ratchet needs a number even on a run where a known flake fires.
  ( cd frontend && npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -30 ) || rc=1
fi
exit $rc
