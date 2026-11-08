#!/bin/bash
# Notifications campaign (N1) SURFACE generator: the notifications stack's public contract
# (HTTP routes with their permissions, backend public callables, Pydantic schemas, the tables,
# settings keys / env vars, permissions, registration points, frontend exports, API client
# types/methods, i18n keys, React Query keys, wiring).
# Regenerate the whole file with:  bash tools/gen_surface_notif.sh > SURFACE.md
# (when comparing, write to a scratch file first and diff: a failing section
# prints a `### SURFACE FAILURE` line or comes out empty, and must not replace
# the committed copy unnoticed).
# Every section is produced by the `regen:` command printed above it, run from
# the repo root with LC_ALL=C, so the file is byte-replayable. ANY diff = a
# surface change = the iteration FAILS unless the user approved it
# (BASELINE-CHANGELOG.md entry in the same commit).
# No section pins line numbers or counts occurrences (names, routes, order only).
set -u
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C PYTHONHASHSEED=0

BE_ROUTES='backend/app/api/routes/notifications.py backend/app/api/routes/notification_templates.py backend/app/api/routes/user_notifications.py'
BE_SRC="$BE_ROUTES backend/app/models/notification.py backend/app/models/notification_inbox.py backend/app/models/notification_live_activity.py backend/app/models/notification_lock_screen_widget.py backend/app/models/notification_template.py backend/app/schemas/notification.py backend/app/schemas/notification_template.py backend/app/schemas/user_notifications.py backend/app/services/notification_service.py backend/app/services/notify_client.py backend/app/services/notify_live_activities.py backend/app/services/notify_widgets.py backend/app/services/notify_worker.py backend/app/services/spool_assignment_notifications.py backend/app/utils/notification_photos.py"
FE_SRC='frontend/src/components/AddNotificationModal.tsx frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationLogViewer.tsx frontend/src/components/NotificationPanel.tsx frontend/src/components/NotificationProviderCard.tsx frontend/src/components/NotificationTemplateEditor.tsx frontend/src/components/notificationKinds.ts frontend/src/pages/NotificationsPage.tsx frontend/src/utils/notify.ts'
CLIENT='frontend/src/api/client.ts'
PY='./venv/bin/python3 tools/probe_notif_surface.py'

R1="$PY routes 2>/dev/null"
R2="grep -HE '^@router\.(get|post|put|patch|delete)\(|^router = APIRouter' $BE_ROUTES | sed 's/, *\$//'"
R3="$PY callables 2>/dev/null"
R4="$PY schemas 2>/dev/null"
R5="$PY ddl 2>/dev/null"
R6="grep -hoE '(get_setting|set_setting|get_settings_value)\([a-z_]+, *\"[a-z_]+\"|Settings\.key == \"[a-z_]+\"|key=\"[a-z_]+\"' $BE_SRC | sort -u; echo 'env vars:'; grep -hoE 'os\.environ[^)]*\)|os\.getenv\([^)]*\)|env_get\([^)]*\)|settings\.[a-z_]+' $BE_SRC | sort -u"
R7="$PY permissions 2>/dev/null; grep -oE \"'(notifications|notification_templates):[a-z_]+'\" $CLIENT | sort -u | sed 's/^/frontend Permission union: /'; grep -rhoE \"hasPermission\('(notifications|notification_templates):[a-z_]+'\)\" frontend/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ | sort -u"
R8='grep -nE "notification|notify_|Notify|NotificationProvider|user_notifications" backend/app/main.py backend/app/models/__init__.py | sed -E "s/:[0-9]+:[[:space:]]*/: /" | grep -vE "^backend/app/main.py: *#|^backend/app/main.py: +(logger|\"\"\")" | sort -u; grep -nE "def seed_notification_templates|notification_providers|notification_logs|notification_templates|notification_live_activities|notification_lock_screen_widgets|user_inbox_preferences|aito_watches|notification_digest_queue|telegram_pending_verdicts" backend/app/core/database.py | sed -E "s/:[0-9]+:[[:space:]]*/: /" | sort -u'
R9="grep -HoE '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' $FE_SRC | sort"
R10="sed -n '/^export interface NotificationProvider {/,/^export interface NotificationLogStats {/p' $CLIENT | grep -E '^export |^  [a-zA-Z_]+\??: |^}'; sed -n '/^export interface NotificationLogStats {/,/^}/p' $CLIENT | grep -E '^export |^  [a-zA-Z_]+\??: |^}'; grep -nE '^export (interface|type) (Inbox[A-Za-z]*|UserEmailPreference[A-Za-z]*|AppMessage[A-Za-z]*|NotificationLogEntry|NotifyConfig)' $CLIENT | sed -E 's/^[0-9]+://'"
R11="grep -E '^  [a-zA-Z]+: ' $CLIENT | grep -iE 'notification|inbox|appmessage' | sed -E 's/^  //; s/ =>.*//'; grep -oE \"(request<[^(]*>|requestBlob)\((\\\`|')/(notifications|notification-templates|user-notifications|inbox)[^\\\`']*(\\\`|')(, \{ method: '[A-Z]+'|, '[A-Z]+')?\" $CLIENT | sed -E 's/^request<.*>\(/request(/' | sort"
R12="mkdir -p /tmp/fenrir-refactor-notif-probe && frontend/node_modules/.bin/rolldown tools/probe_notif_i18n_entry.ts --format cjs --file /tmp/fenrir-refactor-notif-probe/notifI18n.cjs >/dev/null 2>&1 && node tools/probe_notif_i18n.cjs | sed -n '/^--- en notifications/,/^--- es notifications/p' | grep -v '^--- es ' | sed -E 's/ = .*  placeholders=(.*)\$/  \1/; s/ = .*//'"
R13="grep -hoE --include='*.ts' --include='*.tsx' \"'(notifications|notificationLog|notificationTemplates|inbox|nav|common|settings)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*'|\\\`(notifications|inbox)\.[a-zA-Z0-9_.]*\\\$\{[^}]*\}[a-zA-Z0-9_]*\\\`\" $FE_SRC | sort -u"
R14="grep -hoE --include='*.ts' --include='*.tsx' 'useQuery|useMutation|useIsMutating|(query|mutation)Key: [^,}]*|[A-Z_]+_KEY = \[[^]]*\]|(invalidate|remove|cancel)Queries\([^)]*\)|setQueryData\([^,]*,' $FE_SRC | sort -u"
R15='grep -nE "NotificationsPage|path=\"notifications\"" frontend/src/App.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "NotificationBell|id: .notifications.|notifications: .notifications:read." frontend/src/components/Layout.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//" | sort -u; grep -hoE "searchParams\.get\(.[a-z_]+.\)|[?&](provider|tab|template)=" frontend/src/pages/NotificationsPage.tsx | sort -u'

emit() { # emit <heading> <cmd>
  local heading="$1" cmd="$2"
  echo "## $heading"
  echo "\`\`\`regen: $cmd\`\`\`"
  echo '```'
  eval "$cmd"
  echo '```'
  echo ''
}

echo '# SURFACE.md — notifications campaign (N1) public contract: the notifications stack (frozen at setup)'
echo ''
echo 'Regenerate with: `bash tools/gen_surface_notif.sh > SURFACE.md` (from the repo root).'
echo 'Each section is replayable by the `regen:` command shown above it (repo root,'
echo '`LC_ALL=C`). Any diff against the committed copy is a change to something'
echo 'outside the feature`s own internals — a route or its permission, a public'
echo 'function signature, a request schema, a table column, a setting or permission'
echo 'the feature reads, an exported symbol, an API client type or method, a'
echo 'translation key, the wiring — and fails the iteration unless the user approved it.'
echo ''

emit 'HTTP routes under /notifications, /notification-templates, /user-notifications: method, path, handler, doors' "$R1"
emit 'Route decorators and routers (the three route modules)' "$R2"
emit 'Backend public functions, classes, methods and constants of the in-scope modules, with signatures' "$R3"
emit 'Pydantic schemas (schemas/notification.py, notification_template.py, user_notifications.py): fields, types, defaults' "$R4"
emit 'Tables the in-scope models own — DDL, SQLite and PostgreSQL' "$R5"
emit 'Settings keys and env vars the stack reads or writes' "$R6"
emit 'Permissions: values, default groups, categories, API keys, and where the frontend checks them' "$R7"
emit 'Registration points (main.py, models/__init__.py, core/database.py)' "$R8"
emit 'Frontend exported symbols, per file' "$R9"
emit 'API client — notification exported types and their fields' "$R10"
emit 'API client — notification / inbox methods and the endpoints they call' "$R11"
emit 'Translation keys of the notifications, notificationLog, notificationTemplates and inbox namespaces (en; placeholders after the key)' "$R12"
emit 'Translation keys the notification UI reads (string literals and templates)' "$R13"
emit 'React Query hooks, keys and invalidations in the notification components' "$R14"
emit 'Wiring — route path, bell placement, URL parameters' "$R15"
