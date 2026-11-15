#!/bin/bash
# Filament-tree campaign (F1) coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only — the filament profile tree (routes, models, schemas, the six
# services, the frontend components/filament-trees/ folder and FilamentProfilesPage).
# frontend/src/api/client.ts is deliberately NOT in the coverage scope (only a slice of it
# belongs to the feature; the ftree-api-client snapshot pins that slice instead).
# Run from repo root: bash tools/coverage_ftree.sh [frontend|backend|both]
#
# Backend coverage is measured wide (the whole app package) and reported
# narrow (cov_filter.py globs): the scope cannot be quietly widened to inflate
# the number, and a scope file that stops being imported reads as a miss rather
# than vanishing from the report. Anchor files are existence-checked so a
# rename fails loudly.
#
# Env:
#   COVERAGE_FILE        coverage.py data file (default /tmp/fenrir-ftree-coverage/.coverage);
#                        the JSON report is written next to it, never into the repo.
#   FTREE_PYTEST_ARGS    what pytest runs (default: backend/tests/ — the full suite). Narrow it
#                        only for a smoke run of this script; the gate number needs the default.
#   FTREE_VITEST_ARGS    extra vitest args / test files (default: none — the full suite).
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_INCLUDES=(
  'src/components/filament-trees/**'
  'src/components/filament-profiles/**'
  'src/pages/FilamentProfilesPage.tsx'
)
BE_GLOBS=(
  'backend/app/api/routes/filament_trees.py'
  'backend/app/models/filament_tree.py'
  'backend/app/schemas/filament_tree.py'
  'backend/app/services/filament_tree.py'
  'backend/app/services/filament_tree_*.py'
)
ANCHORS=(
  backend/app/api/routes/filament_trees.py
  backend/app/models/filament_tree.py
  backend/app/schemas/filament_tree.py
  backend/app/services/filament_tree.py
  backend/app/services/filament_tree_base.py
  backend/app/services/filament_tree_export.py
  backend/app/services/filament_tree_migration.py
  backend/app/services/filament_tree_pull.py
  backend/app/services/filament_tree_push.py
  backend/app/services/filament_tree_store.py
  frontend/src/components/filament-trees/NodePanel.tsx
  frontend/src/components/filament-trees/MaterialCards.tsx
  frontend/src/components/filament-trees/TreeSettingsPanel.tsx
  frontend/src/components/filament-trees/SyncResultModal.tsx
  frontend/src/components/filament-trees/SyncPreviewModal.tsx
  frontend/src/components/filament-profiles/usePresetSyncs.ts
  frontend/src/components/filament-profiles/useZohoSync.ts
  frontend/src/components/filament-trees/orcaLayout.ts
  frontend/src/components/filament-trees/paGcode.ts
  frontend/src/pages/FilamentProfilesPage.tsx
)

missing=0
for f in "${ANCHORS[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_ftree.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
# A report older than this stamp is a leftover of an earlier run, not this run's number
# (the script deletes nothing: staleness is detected, not cleaned up).
STAMP="$(mktemp)"
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: filament trees) ==="
  COVERAGE_FILE="${COVERAGE_FILE:-/tmp/fenrir-ftree-coverage/.coverage}"
  mkdir -p "$(dirname "$COVERAGE_FILE")"
  REPORT="$(dirname "$COVERAGE_FILE")/coverage-ftree-backend.json"
  # shellcheck disable=SC2086  # FTREE_PYTEST_ARGS is a word list on purpose
  COVERAGE_FILE="$COVERAGE_FILE" ./venv/bin/python3 -m pytest ${FTREE_PYTEST_ARGS:-backend/tests/} -q -n 10 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:"$REPORT" --cov-report= 2>&1 | tail -30 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  if [ "$REPORT" -nt "$STAMP" ] && out=$(./venv/bin/python3 tools/cov_filter.py "$REPORT" "${BE_GLOBS[@]}"); then
    echo "$out"
    echo "$out" | awk '/^SCOPED statements:/{s=$3" = "$5} /^SCOPED branches:/{b=$3" = "$5} END{print "\nFTREE BACKEND COVERAGE: statements " s " | branches " b "   <- RATCHET METRIC"}'
  else
    echo "FTREE BACKEND COVERAGE: NO NUMBER (no report from this run, or the scope matched no file)"; rc=1
  fi
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: filament trees) ==="
  ARGS=()
  for g in "${FE_INCLUDES[@]}"; do ARGS+=("--coverage.include=$g"); done
  # reportOnFailure: the documented load flakes must not suppress the report —
  # the ratchet needs a number even on a run where a known flake fires.
  # shellcheck disable=SC2086
  ( cd frontend && npx vitest run ${FTREE_VITEST_ARGS:-} --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -60 ) || rc=1
  echo "--- per-file (coverage/coverage-summary.json) ---"
  [ frontend/coverage/coverage-summary.json -nt "$STAMP" ] && node -e '
const s = require("./frontend/coverage/coverage-summary.json");
for (const [f, v] of Object.entries(s)) if (f !== "total") console.log(String(v.statements.pct).padStart(7) + "%  " + f.replace(/.*\/src\//, "src/") + "  " + v.statements.covered + "/" + v.statements.total);
const t = s.total;
console.log("\nSCOPED functions:  " + t.functions.covered + "/" + t.functions.total + " = " + t.functions.pct + "%");
console.log("SCOPED lines:      " + t.lines.covered + "/" + t.lines.total + " = " + t.lines.pct + "%");
console.log("\nFTREE FRONTEND COVERAGE: statements " + t.statements.covered + "/" + t.statements.total + " = " + t.statements.pct + "% | branches " + t.branches.covered + "/" + t.branches.total + " = " + t.branches.pct + "%   <- RATCHET METRIC");
' || { echo "FTREE FRONTEND COVERAGE: NO NUMBER (no coverage summary from this run)"; rc=1; }
fi
exit $rc
