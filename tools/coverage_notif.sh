#!/bin/bash
# Notifications campaign (N1) coverage gate: runs the FULL suites, but measures coverage over
# the campaign SCOPE only — the notifications stack (providers, templates, logs, inbox,
# Notify client / live activities / widgets, the digest, the frontend notification UI).
# Run from repo root: bash tools/coverage_notif.sh [frontend|backend|both]
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
  'src/components/AddNotificationModal.tsx'
  'src/components/NotificationBell.tsx'
  'src/components/NotificationLogViewer.tsx'
  'src/components/NotificationPanel.tsx'
  'src/components/NotificationProviderCard.tsx'
  'src/components/NotificationTemplateEditor.tsx'
  'src/components/notificationKinds.ts'
  'src/pages/NotificationsPage.tsx'
  'src/utils/notify.ts'
)
BE_GLOBS=(
  'backend/app/api/routes/notifications.py'
  'backend/app/api/routes/notification_templates.py'
  'backend/app/api/routes/user_notifications.py'
  'backend/app/models/notification*.py'
  'backend/app/schemas/notification*.py'
  'backend/app/schemas/user_notifications.py'
  'backend/app/services/notification_service.py'
  'backend/app/services/notify_*.py'
  'backend/app/services/spool_assignment_notifications.py'
  'backend/app/utils/notification_photos.py'
)
ANCHORS=(
  backend/app/api/routes/notifications.py
  backend/app/api/routes/notification_templates.py
  backend/app/api/routes/user_notifications.py
  backend/app/models/notification.py
  backend/app/models/notification_inbox.py
  backend/app/models/notification_template.py
  backend/app/schemas/notification.py
  backend/app/schemas/notification_template.py
  backend/app/services/notification_service.py
  backend/app/services/notify_client.py
  backend/app/services/notify_worker.py
  backend/app/services/notify_widgets.py
  backend/app/services/notify_live_activities.py
  backend/app/services/spool_assignment_notifications.py
  backend/app/utils/notification_photos.py
  frontend/src/components/AddNotificationModal.tsx
  frontend/src/components/NotificationProviderCard.tsx
  frontend/src/components/NotificationBell.tsx
  frontend/src/pages/NotificationsPage.tsx
)

missing=0
for f in "${ANCHORS[@]}"; do
  [ -f "$f" ] || { echo "SCOPE FILE MISSING: $f" >&2; missing=1; }
done
[ "$missing" = 1 ] && { echo "coverage_notif.sh: scope list is stale — fix before trusting any coverage number" >&2; exit 2; }

rc=0
if [ "$WHICH" = both ] || [ "$WHICH" = backend ]; then
  echo "=== BACKEND coverage (scope: notifications) ==="
  COVERAGE_FILE="${COVERAGE_FILE:-/tmp/fenrir-notif-coverage/.coverage}"
  mkdir -p "$(dirname "$COVERAGE_FILE")"
  COVERAGE_FILE="$COVERAGE_FILE" ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 -p no:randomly \
    --ignore=backend/tests/unit/services/test_bambu_ftp.py \
    --cov=backend/app --cov-branch \
    --cov-report=json:coverage-notif-backend.json --cov-report= 2>&1 | tail -30 || rc=1
  echo "--- RATCHET (scoped statements) ---"
  ./venv/bin/python3 tools/cov_filter.py coverage-notif-backend.json "${BE_GLOBS[@]}" || rc=1
  git checkout -q -- .coverage 2>/dev/null || true
fi

if [ "$WHICH" = both ] || [ "$WHICH" = frontend ]; then
  echo "=== FRONTEND coverage (scope: notifications) ==="
  ARGS=()
  for g in "${FE_INCLUDES[@]}"; do ARGS+=("--coverage.include=$g"); done
  # reportOnFailure: the documented load flakes must not suppress the report —
  # the ratchet needs a number even on a run where a known flake fires.
  ( cd frontend && npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true \
      --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}" 2>&1 | tail -60 ) || rc=1
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
