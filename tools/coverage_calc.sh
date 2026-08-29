#!/bin/bash
# Campaign-8 coverage gate (campaign 6's gate refreshed 2026-08-28:
# + hooks/useSettledValue.ts, calculator-only importers; utils/motion stays
# out, it is shared with Aito): runs the FULL suites, but measures coverage over the
# campaign SCOPE only (the Calculator x Zoho feature, frontend + backend).
# Run from repo root: bash tools/coverage_calc.sh [frontend|backend|both]
#
# The include lists below ARE the scope definition for coverage. Non-glob
# entries are existence-checked so a rename fails loudly instead of silently
# dropping a file from the gate. (Campaigns 1-3 each shipped with a
# name-shaped hole in this gate; the existence check is the fix.)
#
# Two deliberate scope decisions, recorded here so they cannot drift:
#  * frontend/src/utils/pricing.ts IS included. It is the calculator's own
#    pricing engine, but utils/taskDraft.ts (Aito) and utils/archivePricing.ts
#    also consume it -- a change there is NOT calculator-local.
#  * backend/app/core/database.py is NOT included, even though the
#    calculator_filaments Zoho/margin migration block inside it is in audit
#    scope. The file is ~5.8k lines of unrelated migrations; measuring it would
#    swamp the ratchet. The migration's behaviour is pinned by
#    backend/tests/unit/test_calculator_zoho_migration.py instead.
#
# NOT in scope despite the name: utils/filamentOptions.ts (shared with the spool
# subsystem: BulkEditSpoolsModal, SpoolFormModal, spool-form/**, SpoolBuddyWriteTagPage),
# utils/filamentPresets.ts (only importer is
# components/KProfilesView.tsx), backend models/filament.py + schemas/filament.py
# + routes/filaments.py (the separate `filaments` catalogue table, not
# `calculator_filaments`), models/filament_sku_settings.py (stats reorder).
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_FILES=(
  frontend/src/pages/CalculatorPage.tsx
  frontend/src/pages/CalculatorQuotePage.tsx
  frontend/src/components/CalculatorSettingsPanels.tsx
  frontend/src/hooks/useCalculatorState.ts
  frontend/src/hooks/useSettledValue.ts
  frontend/src/utils/calculatorInsights.ts
  frontend/src/utils/quoteSummary.ts
  frontend/src/utils/pricing.ts
)
FE_GLOBS=( 'src/components/calculator/**' )

BE_FILES=(
  backend/app/api/routes/calculator.py
  backend/app/services/zoho_filaments.py
  backend/app/services/calculator_insights.py
  backend/app/schemas/calculator.py
  backend/app/models/calculator.py
)

missing=0
for f in "${FE_FILES[@]}" "${BE_FILES[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_calc.sh: scope list is stale -- fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Calculator x Zoho) ==="
  # Measure wide, report narrow: coverage.py instruments the whole backend
  # package and cov_filter.py then reports only the SCOPE files. This means the
  # scope cannot be quietly widened to inflate the number, and a scope file that
  # stops being imported shows up as a miss rather than vanishing from the gate.
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 30 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-calc-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  ./venv/bin/python3 tools/cov_filter.py coverage-calc-backend.json \
    'backend/app/api/routes/calculator.py' \
    'backend/app/services/zoho_filaments.py' \
    'backend/app/services/calculator_insights.py' \
    'backend/app/schemas/calculator.py' \
    'backend/app/models/calculator.py' || rc=1
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Calculator x Zoho) ==="
  ARGS=()
  for f in "${FE_FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
  for g in "${FE_GLOBS[@]}"; do ARGS+=("--coverage.include=$g"); done
  # This suite is documented load-flaky (PrintModal always; CalculatorPage,
  # StatsPageUserFilter1894, ModelViewerModal, LoginPage under load). Two knobs
  # keep the ratchet honest against that, and BOTH must stay -- the baseline in
  # BASELINE.md was measured with them, so dropping either makes every later
  # comparison apples-to-oranges:
  #  * --retry=3 : a flaked test re-runs and, when it passes, its lines count.
  #    Measured on this repo at setup, the same tree reported 87.34% on one run
  #    and 86.57% on the next purely from flakes -- a 0.8pt swing, wide enough
  #    to fail a clean iteration on noise alone.
  #  * --coverage.reportOnFailure : a flake that survives all 3 retries must
  #    still not suppress the report; the ratchet needs a number regardless.
  ( cd frontend && npx vitest run --retry=3 --coverage.enabled=true --coverage.all=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -40 ) || rc=1
fi
exit $rc
