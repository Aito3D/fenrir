#!/bin/bash
# Campaign-9 SURFACE.md generator: the WHOLE app's public contract.
# Regenerate with:  bash tools/gen_surface_all.sh > SURFACE.md
# Every section below is produced by the `regen:` command printed above it, so
# the file is byte-replayable by re-running that exact command. ANY diff is a
# surface change and fails the iteration.
set -u
cd "$(dirname "$0")/.." || exit 1

R1='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\")]" 2>/dev/null'
R2='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.permissions import ALL_PERMISSIONS; [print(p) for p in sorted(ALL_PERMISSIONS)]" 2>/dev/null'
R3='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.config import settings; [print(n, \"=\", repr(f.default)) for n, f in sorted(type(settings).model_fields.items())]" 2>/dev/null'
R4='grep -hE "^(def|class|async def) [a-zA-Z]" backend/app/services/*.py | sort | uniq -c | sed "s/^ *//"'
R5='grep -rhoE "^export (default function|function|const|type|interface|class|enum) [A-Za-z0-9_]+" frontend/src/utils frontend/src/hooks --include="*.ts" --include="*.tsx" | sort'
# The client is one big `export const api = {` object literal plus a handful of
# top-level helpers. Take BOTH: the object'"'"'s 2-space-indented method keys (from
# the `export const api` line to its closing brace) and the module'"'"'s own exports.
R6='{ awk "/^export const api = \\{/{f=1} f&&/^  [a-zA-Z0-9_]+:/{gsub(/:.*/,\"\"); gsub(/ /,\"\"); print} f&&/^\\};?$/{exit}" frontend/src/api/client.ts; grep -oE "^export (const|async function|function) [a-zA-Z0-9_]+" frontend/src/api/client.ts | sed "s/^export [a-z ]*//"; } | sort'
R7='ls frontend/src/pages/*.tsx | xargs -n1 basename | sort'
R8='PYTHONHASHSEED=0 ./venv/bin/python3 -c "import backend.app.main; from backend.app.core.database import Base; [print(n, len(t.columns)) for n, t in sorted(Base.metadata.tables.items())]" 2>/dev/null'

emit() {  # emit <heading> <regen-cmd>
  echo "## $1"
  echo "\`\`\`regen: $2\`\`\`"
  echo '```'
  eval "$2"
  echo '```'
  echo ''
}

echo '# SURFACE.md — campaign-9 public contract: THE WHOLE APP (frozen at setup)'
echo ''
echo 'Regenerate every section with `bash tools/gen_surface_all.sh > SURFACE.md`.'
echo 'Each section names the exact command that produces it. ANY diff against this'
echo 'file is a change to the app'"'"'s public contract and fails the iteration.'
echo ''
emit 'HTTP routes (path + methods)' "$R1"
emit 'Permission catalogue' "$R2"
emit 'Settings / environment surface (name = default)' "$R3"
emit 'Backend service top-level defs (count per signature)' "$R4"
emit 'Frontend exported symbols — utils + hooks' "$R5"
emit 'Frontend API client methods' "$R6"
emit 'Frontend pages' "$R7"
emit 'Database tables (name, column count)' "$R8"
