#!/bin/bash
# Campaign-21 coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only (the whole Aito feature: board, panel, quotes,
# invoices, payments, tracking, stats, plus the Zoho / Heimdall / Pushcut /
# OpenRouter integration services that only Aito uses).
# Run from repo root: bash tools/coverage_aito21.sh [frontend|backend|both]
#
# Backend coverage is measured wide (the whole app package) and reported
# narrow (cov_filter.py globs): the scope cannot be quietly widened to inflate
# the number, and a scope file that stops being imported reads as a miss rather
# than vanishing from the report. Globs are used so a NEW aito_* file joins the
# gate automatically; the anchor files below are existence-checked so a rename
# fails loudly.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_INCLUDES=(
  'src/pages/AitoPage.tsx'
  'src/pages/AitoTrackPage.tsx'
  'src/pages/AitoTrackEntryPage.tsx'
  'src/pages/AitoFxDemoPage.tsx'
  'src/components/aito/**'
  'src/hooks/useAito*.ts'
  'src/hooks/useTracking*.ts'
  'src/utils/aito*.ts'
  'src/utils/tracking*.ts'
  'src/utils/projectSeed.ts'
)
BE_GLOBS=(
  'backend/app/api/routes/aito*.py'
  'backend/app/api/routes/heimdall.py'
  'backend/app/api/routes/zoho.py'
  'backend/app/schemas/aito.py'
  'backend/app/schemas/heimdall.py'
  'backend/app/models/aito_*.py'
  'backend/app/services/aito_*.py'
  'backend/app/services/openrouter.py'
  'backend/app/services/heimdall.py'
  'backend/app/services/pushcut.py'
  'backend/app/services/zoho.py'
)
ANCHORS=(
  frontend/src/pages/AitoPage.tsx
  frontend/src/components/aito/ProjectDetailPanel.tsx
  frontend/src/hooks/useAitoPageMutations.ts
  frontend/src/utils/aitoBoard.ts
  backend/app/api/routes/aito.py
  backend/app/api/routes/aito_payments.py
  backend/app/services/aito_quote_sync.py
  backend/app/services/zoho.py
  backend/app/services/heimdall.py
)

missing=0
for f in "${ANCHORS[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_aito21.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Aito feature) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-aito21-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-aito21-backend.json "${BE_GLOBS[@]}" || rc=1
  # pytest-cov rewrites the (tracked, campaign-1 leak) .coverage file; put it back so it never rides into a commit.
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Aito feature) ==="
  ARGS=()
  for g in "${FE_INCLUDES[@]}"; do ARGS+=("--coverage.include=$g"); done
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
