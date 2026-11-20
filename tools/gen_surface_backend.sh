#!/bin/bash
# Campaign-B1 SURFACE.md generator: the backend's public contract.
# Regenerate with:  bash tools/gen_surface_backend.sh > SURFACE.md
# Same sections as gen_surface_all.sh minus the frontend ones. ANY diff fails the iteration.
set -u
cd "$(dirname "$0")/.." || exit 1

R1='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\")]" 2>/dev/null'
R2='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.permissions import ALL_PERMISSIONS; [print(p) for p in sorted(ALL_PERMISSIONS)]" 2>/dev/null'
R3='PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.config import settings; [print(n, \"=\", repr(f.default)) for n, f in sorted(type(settings).model_fields.items())]" 2>/dev/null'
R4='grep -rhoE "env_get\(\"[A-Z_]+\"|os\.(environ\.get|getenv)\(\"[A-Z_]+\"" backend/app | grep -oE "\"[A-Z_]+\"" | sort -u'
R5='grep -hE "^(def|class|async def) [a-zA-Z]" backend/app/services/*.py backend/app/core/*.py | sort | uniq -c | sed "s/^ *//"'
R6='PYTHONHASHSEED=0 ./venv/bin/python3 -c "import backend.app.main; from backend.app.core.database import Base; [print(n, len(t.columns)) for n, t in sorted(Base.metadata.tables.items())]" 2>/dev/null'

emit() {  # emit <heading> <regen-cmd>
  echo "## $1"
  echo "\`\`\`regen: $2\`\`\`"
  echo '```'
  eval "$2"
  echo '```'
  echo ''
}

echo '# SURFACE.md — campaign-B1 public contract: THE BACKEND (frozen at setup)'
echo ''
echo 'Regenerate every section with `bash tools/gen_surface_backend.sh > SURFACE.md`.'
echo 'Each section names the exact command that produces it. ANY diff against this'
echo 'file is a change to the backend'"'"'s public contract and fails the iteration.'
echo ''
emit 'HTTP routes (path + methods)' "$R1"
emit 'Permission catalogue' "$R2"
emit 'Settings surface (name = default)' "$R3"
emit 'Environment variables read' "$R4"
emit 'Backend services + core top-level defs (count per signature)' "$R5"
emit 'Database tables (name, column count)' "$R6"
