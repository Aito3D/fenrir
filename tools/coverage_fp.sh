#!/bin/bash
# Campaign-7 coverage gate: runs the FULL suites, but measures coverage over the
# campaign SCOPE only (the filament-profiles Zoho price sync, frontend + backend).
# Run from repo root: bash tools/coverage_fp.sh [frontend|backend|both]
#
# The include lists below ARE the scope definition for coverage. Non-glob entries
# are existence-checked so a rename fails loudly instead of silently dropping a
# file from the gate (the fix campaigns 1-3 each needed).
#
# Deliberate scope decisions, recorded here so they cannot drift:
#  * backend/app/services/zoho_filaments.py IS included, and is SHARED: the
#    pricing calculator (api/routes/calculator.py) is its other consumer and was
#    campaign 6's main subject. match_profile/_normalise/ProfileMatch are this
#    campaign's additions; the catalogue fetch/cache/parse machinery is not.
#    A change there is NOT filament-profiles-local.
#  * frontend/src/components/filament-profiles/** is NOT included. That is the
#    preset editor; the user scoped this campaign to the Zoho sync and declined
#    the wider "filament profiles page (full)" option.
#  * frontend/src/api/client.ts is NOT included -- one 265KB file shared by the
#    whole app; measuring it would swamp the ratchet. Its
#    syncFilamentPresetsFromZoho method is in audit scope, pinned by the
#    FilamentProfilesPage test and the fp-openapi golden probe.
#  * backend/app/models/filament_profile.py IS included: the FilamentPreset row
#    the sync mutates lives there and it is small.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

FE_FILES=(
  frontend/src/pages/FilamentProfilesPage.tsx
)

BE_FILES=(
  backend/app/api/routes/filament_profiles.py
  backend/app/services/filament_profile_pricing.py
  backend/app/services/zoho_filaments.py
  backend/app/schemas/filament_profile.py
  backend/app/models/filament_profile.py
)

missing=0
for f in "${FE_FILES[@]}" "${BE_FILES[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_fp.sh: scope list is stale -- fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: filament-profiles Zoho sync) ==="
  # Measure wide, report narrow: coverage.py instruments the whole backend
  # package and cov_filter.py reports only the SCOPE files, so the scope cannot
  # be quietly widened to inflate the number and a scope file that stops being
  # imported shows up as a miss rather than vanishing from the gate.
  # concurrency=greenlet is NOT optional on this repo: without it every async
  # route body reads as unexecuted and the number is fiction.
  ./venv/bin/python3 -m pytest backend/tests/ -q -n 30 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-fp-backend.json --cov-report= 2>&1 | tail -6 || rc=1
  ./venv/bin/python3 tools/cov_filter.py coverage-fp-backend.json \
    'backend/app/api/routes/filament_profiles.py' \
    'backend/app/services/filament_profile_pricing.py' \
    'backend/app/services/zoho_filaments.py' \
    'backend/app/schemas/filament_profile.py' \
    'backend/app/models/filament_profile.py' || rc=1
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: filament-profiles Zoho sync) ==="
  ARGS=()
  for f in "${FE_FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
  # This suite is documented load-flaky (PrintModal always; ArchivesPage,
  # ConfigureAmsSlotModal, CalculatorPage, LoginPage and others under load).
  # Both knobs below must stay -- the BASELINE.md numbers were measured with
  # them, so dropping either makes every later comparison apples-to-oranges:
  #  * --retry=3 : a flaked test re-runs and, when it passes, its lines count.
  #  * --coverage.reportOnFailure : a flake surviving all 3 retries must still
  #    not suppress the report; the ratchet needs a number regardless.
  ( cd frontend && npx vitest run --retry=3 --coverage.enabled=true --coverage.all=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -30 ) || rc=1
fi
exit $rc
