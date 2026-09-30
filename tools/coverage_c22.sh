#!/bin/bash
# Campaign-22 coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only — the camera wall (grid-stream hub in routes/camera.py,
# the MJPEG fan-out service, the frontend camera grid + stream hooks) and the
# Aito card hover dwell (CardView + hoverWarmth).
# Run from repo root: bash tools/coverage_c22.sh [frontend|backend|both]
#
# Backend coverage is measured wide (the whole app package) and reported
# narrow (cov_filter.py globs): the scope cannot be quietly widened to inflate
# the number, and a scope file that stops being imported reads as a miss rather
# than vanishing from the report. routes/camera.py is measured as a WHOLE file
# even though only its grid-hub slice is in scope — the number therefore also
# moves with out-of-scope camera code, which is fine for a ratchet (it may only
# go up). PrintersPage.tsx is deliberately NOT in the frontend ratchet: only its
# camera-wall slice is in scope and a 10k-line whole-file number would be
# dominated by out-of-scope code.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_INCLUDES=(
  'src/components/CameraGrid.tsx'
  'src/components/cameraGrid/**'
  'src/components/cameraGridLayout.ts'
  'src/components/cameraDefaults.ts'
  'src/hooks/useGridStream.ts'
  'src/hooks/useGridReconnect.ts'
  'src/hooks/useCombinedGridStats.ts'
  'src/hooks/useWebRTCStream.ts'
  'src/hooks/useMjpegStream.ts'
  'src/hooks/useStreamReconnect.ts'
  'src/hooks/useCameraStreamToken.ts'
  'src/utils/streamBuffer.ts'
  'src/utils/streamConstants.ts'
  'src/workers/cameraGridDecoder.worker.ts'
  'src/components/aito/CardView.tsx'
  'src/components/aito/hoverWarmth.ts'
)
BE_GLOBS=(
  'backend/app/api/routes/camera.py'
  'backend/app/services/camera_fanout.py'
)
ANCHORS=(
  frontend/src/components/CameraGrid.tsx
  frontend/src/components/cameraGrid/CameraGridCard.tsx
  frontend/src/components/cameraGridLayout.ts
  frontend/src/hooks/useGridStream.ts
  frontend/src/hooks/useWebRTCStream.ts
  frontend/src/components/aito/CardView.tsx
  frontend/src/components/aito/hoverWarmth.ts
  backend/app/api/routes/camera.py
  backend/app/services/camera_fanout.py
)

missing=0
for f in "${ANCHORS[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_c22.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: camera wall) ==="
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-c22-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-c22-backend.json "${BE_GLOBS[@]}" || rc=1
  # pytest-cov rewrites the (tracked, campaign-1 leak) .coverage file; put it back so it never rides into a commit.
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: camera wall + card hover) ==="
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
