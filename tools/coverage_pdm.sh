#!/bin/bash
# Campaign-24 coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only — the Projects-as-PDM feature (project files/items/
# revisions, codes, tags, filing, print traceability, re-slice, Aito task links).
# Run from repo root: bash tools/coverage_pdm.sh [frontend|backend|both]
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
  'src/pages/ProjectDetailPage.tsx'
  'src/pages/ProjectListPage.tsx'
  'src/pages/ProjectsPage.tsx'
  'src/components/projects/**'
)
BE_GLOBS=(
  'backend/app/api/routes/projects.py'
  'backend/app/api/routes/projects_pdm.py'
  'backend/app/api/routes/project_files.py'
  'backend/app/api/routes/aito_project_links.py'
  'backend/app/schemas/project.py'
  'backend/app/schemas/project_files.py'
  'backend/app/schemas/aito_project_links.py'
  'backend/app/models/project.py'
  'backend/app/models/project_item.py'
  'backend/app/models/project_tag.py'
  'backend/app/models/aito_task_delivery.py'
  'backend/app/services/project_*.py'
  'backend/app/services/aito_project_links.py'
)
ANCHORS=(
  frontend/src/pages/ProjectDetailPage.tsx
  frontend/src/pages/ProjectListPage.tsx
  frontend/src/components/projects/files/ProjectFilesPanel.tsx
  frontend/src/components/projects/filing/MoveToProjectModal.tsx
  backend/app/api/routes/projects_pdm.py
  backend/app/api/routes/project_files.py
  backend/app/api/routes/aito_project_links.py
  backend/app/services/project_files.py
  backend/app/services/project_filing.py
  backend/app/services/project_storage.py
  backend/app/services/aito_project_links.py
)

missing=0
for f in "${ANCHORS[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_pdm.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: Projects-PDM feature) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-pdm-backend.json --cov-report= 2>&1 | tail -30 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-pdm-backend.json "${BE_GLOBS[@]}" || rc=1
  # pytest-cov rewrites the (tracked, campaign-1 leak) .coverage file; put it back so it never rides into a commit.
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: Projects-PDM feature) ==="
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
