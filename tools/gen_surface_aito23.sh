#!/bin/bash
# Campaign-23 SURFACE generator: the whole Aito feature's public contract
# (board, panel, quotes, invoices, payments, tracking, stats, and the Zoho /
# Heimdall / Pushcut / OpenRouter integration services only Aito uses).
# Regenerate the whole file with:  bash tools/gen_surface_aito23.sh > SURFACE.md
# Every section is produced by the `regen:` command printed above it, so the
# file is byte-replayable. ANY diff = a surface change = the iteration FAILS
# unless the user approved it (BASELINE-CHANGELOG.md entry in the same commit).
# No section pins line numbers (names, routes and order only) — see campaign 19.
set -u
cd "$(dirname "$0")/.." || exit 1

BE_SRC='backend/app/api/routes/aito.py backend/app/api/routes/aito_payments.py backend/app/api/routes/heimdall.py backend/app/api/routes/zoho.py backend/app/services/aito_*.py backend/app/services/openrouter.py backend/app/services/heimdall.py backend/app/services/pushcut.py backend/app/services/zoho.py backend/app/api/routes/inbox.py backend/app/services/inbox.py'
FE_SRC='frontend/src/pages/AitoPage.tsx frontend/src/pages/AitoTrackPage.tsx frontend/src/pages/AitoTrackEntryPage.tsx frontend/src/pages/AitoFxDemoPage.tsx frontend/src/components/aito frontend/src/hooks/useAitoPageMutations.ts frontend/src/hooks/useAitoPresence.ts frontend/src/hooks/useTrackingLanguage.ts frontend/src/hooks/useTrackingPanel.ts frontend/src/utils/aito*.ts frontend/src/utils/tracking*.ts frontend/src/utils/projectSeed.ts frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationPanel.tsx frontend/src/components/settings/InboxPreferences.tsx frontend/src/utils/inboxTarget.ts'

R1='./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\") and any(s in r.path for s in (\"/aito\", \"/heimdall\", \"/zoho\", \"/t/\", \"/inbox\"))]" 2>/dev/null'
R2='grep -hE "^@router\.(get|post|put|patch|delete)\(" backend/app/api/routes/aito.py backend/app/api/routes/aito_payments.py backend/app/api/routes/heimdall.py backend/app/api/routes/zoho.py backend/app/api/routes/inbox.py | sed "s/, *$//" | sort'
R3="grep -hE '^(def|class|async def) [a-zA-Z]' $BE_SRC | sed 's/) *->.*/)/; s/:\$//' | sort"
R4='grep -hoE "^class [A-Za-z0-9_]+" backend/app/schemas/aito.py backend/app/schemas/heimdall.py backend/app/models/aito_*.py backend/app/schemas/inbox.py backend/app/models/notification_inbox.py | sort'
R5='./venv/bin/python3 -c "
import json, inspect
from pydantic import BaseModel
import backend.app.schemas.aito as a, backend.app.schemas.heimdall as h, backend.app.schemas.inbox as i
out = {}
for m in (a, h, i):
    for n, c in sorted(vars(m).items()):
        if inspect.isclass(c) and issubclass(c, BaseModel) and c.__module__ == m.__name__:
            out[n] = {f: str(x.annotation) for f, x in sorted(c.model_fields.items())}
print(json.dumps(out, indent=1, sort_keys=True))" 2>/dev/null'
R6='./venv/bin/python3 -c "import backend.app.main; from sqlalchemy.schema import CreateTable; from sqlalchemy.dialects import sqlite; from backend.app.core.database import Base; [print(str(CreateTable(t).compile(dialect=sqlite.dialect())).strip() + \";\") for n, t in sorted(Base.metadata.tables.items()) if n.startswith((\"aito\", \"notification_inbox\"))]" 2>/dev/null'
R7="grep -hoE 'get_setting\(db, \"[a-z_]+\"|os\.environ\.get\(\"[A-Z_]+\"' $BE_SRC | sort -u"
R8='grep -hoE "Permission\.AITO[A-Z_]*|Permission\.ZOHO[A-Z_]*|Permission\.HEIMDALL[A-Z_]*|Permission\.INBOX[A-Z_]*|Permission\.NOTIFICATION[A-Z_]*" backend/app/api/routes/inbox.py backend/app/api/routes/aito.py backend/app/api/routes/aito_payments.py backend/app/api/routes/heimdall.py backend/app/api/routes/zoho.py | sort | uniq -c | sed "s/^ *//"'
R9='grep -E "^\s*#\s*Migration:.*(aito|Aito|zoho|Zoho|heimdall|Heimdall|tracking (link|page)|payment[- ]link|payment rating|invoice payment|inbox|Inbox)" backend/app/core/database.py | sed "s/^[[:space:]]*//"'
R10="grep -rhoE --include='*.ts' --include='*.tsx' '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' $FE_SRC | sort | uniq -c | sed 's/^ *//'"
R11='grep -E "Aito|/t/|/track" frontend/src/App.tsx | sed "s/^[[:space:]]*//"'
R12='grep -oE "^  [a-zA-Z][A-Za-z0-9_]*(:|\\()" frontend/src/api/client.ts | grep -iE "aito|zoho|heimdall|tracking|inbox" | tr -d ":(" | sort -u'
# Nested aito.*.* literals, plus quoted single-segment keys ('aito.smsMaybeSent') the nested regex cannot see (campaign-20 lead).
R13="{ grep -rhoE --include='*.ts' --include='*.tsx' 'aito\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+' $FE_SRC; grep -rhoE --include='*.ts' --include='*.tsx' \"['\\\"\\\`]aito\\.[a-zA-Z0-9_]+['\\\"\\\`]\" $FE_SRC | tr -d \"'\\\"\\\`\"; } | sort -u"
R14='grep -oE "^\s+--color-aito-[a-z0-9-]+" frontend/src/index.css | sed "s/^\s*//" | sort -u'
R15="grep -rhoE --include='*.ts' --include='*.tsx' 'inbox\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*' frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationPanel.tsx frontend/src/components/settings/InboxPreferences.tsx frontend/src/pages/AitoPage.tsx frontend/src/components/aito | sort -u"

emit() { # emit <heading> <cmd>
  local heading="$1" cmd="$2"
  echo "## $heading"
  echo "\`\`\`regen: $cmd\`\`\`"
  echo '```'
  eval "$cmd"
  echo '```'
  echo ''
}

echo '# SURFACE.md — campaign-23 public contract: the Aito feature (+ Aito-fed inbox; frozen at setup)'
echo ''
echo 'Generated by `bash tools/gen_surface_aito23.sh > SURFACE.md`. Each section is'
echo 'replayable by the `regen:` command shown above it. Any diff against the'
echo 'committed copy is a change to something outside the feature`s own'
echo 'internals — a route, a schema field, a table column, an exported symbol,'
echo 'a setting or permission the feature reads, a translation key, an API'
echo 'client method — and fails the iteration unless the user approved it.'
echo ''

emit 'HTTP routes (paths under /aito, /heimdall, /zoho, /t/)' "$R1"
emit 'Route decorators (aito, aito_payments, heimdall, zoho)' "$R2"
emit 'Backend public callables (services + routes)' "$R3"
emit 'Pydantic schemas + ORM model class names' "$R4"
emit 'Pydantic schema fields (aito + heimdall)' "$R5"
emit 'aito* tables — DDL' "$R6"
emit 'Settings keys and env vars read by the Aito backend' "$R7"
emit 'Permissions guarding Aito routes (count per permission)' "$R8"
emit 'Migrations touching the feature (core/database.py comments)' "$R9"
emit 'Frontend exported symbols (count per symbol name)' "$R10"
emit 'App.tsx — Aito routes' "$R11"
emit 'API client — Aito / Zoho / Heimdall / tracking methods' "$R12"
emit 'Translation keys the Aito UI reads (aito.* literals)' "$R13"
emit 'CSS tokens — aito palette' "$R14"
emit 'Translation keys the inbox UI reads (inbox.* literals)' "$R15"
