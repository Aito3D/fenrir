#!/bin/bash
# Aito campaign coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only (Aito frontend + Aito backend).
# Run from repo root: bash tools/coverage_aito.sh [frontend|backend|both]
# The include lists below ARE the scope definition for coverage. Non-glob
# entries are existence-checked so a rename fails loudly instead of silently
# dropping a file from the gate.
set -u
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_FILES=(
  frontend/src/pages/AitoPage.tsx
  frontend/src/hooks/useAitoPageMutations.ts
  frontend/src/hooks/useAitoPresence.ts
  frontend/src/utils/aitoAging.ts
  frontend/src/utils/aitoBoard.ts
  frontend/src/utils/aitoBoardRules.ts
  frontend/src/utils/aitoOptimistic.ts
  frontend/src/utils/aitoSearch.ts
  frontend/src/utils/aitoSummary.ts
)
FE_GLOBS=( 'src/components/aito/**' )

BE_FILES=(
  backend/app/api/routes/aito.py
  backend/app/schemas/aito.py
  backend/app/models/aito_event.py
  backend/app/models/aito_project.py
  backend/app/models/aito_task.py
  backend/app/services/aito_board_rules.py
  backend/app/services/aito_events.py
  backend/app/services/aito_quote_export.py
  backend/app/services/aito_quote_import.py
  backend/app/services/aito_quote_status.py
  backend/app/services/aito_quote_sync.py
  backend/app/services/aito_shipping.py
  backend/app/services/aito_zoho_comments.py
)

missing=0
for f in "${FE_FILES[@]}" "${BE_FILES[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_aito.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Aito) ==="
  # coverage.py measures the whole backend package; cov_filter.py then reports
  # only the SCOPE files. Measuring wide and filtering narrow is deliberate —
  # the scope cannot be quietly widened to inflate the number, and a scope file
  # that stops being imported shows up as a miss rather than vanishing.
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 30 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-aito-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  ./venv/bin/python3 tools/cov_filter.py coverage-aito-backend.json \
    'backend/app/api/routes/aito.py' \
    'backend/app/schemas/aito.py' \
    'backend/app/models/aito_*.py' \
    'backend/app/services/aito_*.py' || rc=1
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Aito) ==="
  ARGS=()
  for f in "${FE_FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
  for g in "${FE_GLOBS[@]}"; do ARGS+=("--coverage.include=$g"); done
  # reportOnFailure: the documented load-flakes (PrintModal, CalculatorPage,
  # ModelViewerModal, StatsPageUserFilter1894) must not suppress the report —
  # the ratchet needs a number even on a run where a known flake fires.
  ( cd frontend && npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -40 ) || rc=1
fi
exit $rc
