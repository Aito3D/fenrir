#!/bin/bash
# Filament-tree campaign (F1) SURFACE generator: the filament profile tree's public contract
# (HTTP routes with their doors, request/response schemas, the tables, backend public
# callables, settings keys / env vars, permissions, registration points, frontend exports,
# API client types/methods, i18n keys, React Query keys, wiring).
# Regenerate the whole file with:  bash tools/gen_surface_ftree.sh > SURFACE.md
# (when comparing, write to a scratch file first and diff: a failing section
# comes out empty, and must not replace the committed copy unnoticed).
# Every section is produced by the `regen:` command printed above it, run from
# the repo root with LC_ALL=C, so the file is byte-replayable. ANY diff = a
# surface change = the iteration FAILS unless the user approved it
# (BASELINE-CHANGELOG.md entry in the same commit).
# No section pins line numbers or counts occurrences (names, routes, order only).
set -u
cd "$(dirname "$0")/.." || exit 1
export LC_ALL=C PYTHONHASHSEED=0

BE_ROUTES='backend/app/api/routes/filament_trees.py'
BE_SRC="$BE_ROUTES backend/app/models/filament_tree.py backend/app/schemas/filament_tree.py backend/app/services/filament_tree.py backend/app/services/filament_tree_*.py"
FE_SRC='frontend/src/components/filament-trees/*.ts frontend/src/components/filament-trees/*.tsx frontend/src/components/filament-profiles/*.ts frontend/src/components/filament-profiles/*.tsx frontend/src/pages/FilamentProfilesPage.tsx'
CLIENT='frontend/src/api/client.ts'
PY='./venv/bin/python3 tools/probe_ftree_surface.py'
AWK='awk -f tools/probe_ftree_client.awk'

R1="$PY routes 2>/dev/null"
R2="grep -HE '^@router\.(get|post|put|patch|delete)\(|^router = APIRouter' $BE_ROUTES | sed 's/, *\$//'"
R3="$PY schemas 2>/dev/null"
R4="$PY ddl 2>/dev/null"
R5="$PY callables 2>/dev/null"
R6="grep -hoE '(get_setting|set_setting)\([a-z_]+, *[A-Za-z_\"]+|[A-Z_]+_KEY = \"[a-z_]+\"|Settings\.key == \"[a-z_]+\"' $BE_SRC | sort -u; echo 'env vars / app settings:'; grep -hoE 'os\.environ[^)]*\)|os\.getenv\([^)]*\)|env_get\([^)]*\)|settings\.[a-z_]+' $BE_SRC | sort -u; echo 'limits and helpers borrowed from other modules:'; grep -hE '^from backend\.app\.(schemas\.filament_profile|api\.routes\.(settings|cloud|orca_cloud)|services\.(bambu_studio|orca_cloud)) import' $BE_SRC | sort -u"
R7="$PY permissions 2>/dev/null; grep -oE \"'(filaments|orca_cloud):[a-z_]+'\" $CLIENT | sort -u | sed 's/^/frontend Permission union: /'; grep -hoE \"hasPermission\('[a-z_]+:[a-z_]+'\)|hasAnyPermission\([^)]*\)\" $FE_SRC | sort -u"
R8='grep -nE "filament_tree|FilamentTree" backend/app/main.py backend/app/models/__init__.py backend/app/core/database.py | sed -E "s/:[0-9]+:[[:space:]]*/: /" | sort -u'
R9="grep -HoE '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' $FE_SRC | sort"
R10="$AWK -v what=types $CLIENT"
R11="$AWK -v what=methods $CLIENT"
R12="node tools/probe_ftree_i18n.cjs | sed -n '/^--- en values/,/^\$/p' | grep -E '^(filamentTrees|nav)\.' | sed -E 's/ = .*  placeholders=(.*)\$/  \1/; s/ = .*//'"
R13="grep -hoE \"'(filamentTrees|filamentProfiles|nav|common)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*'|\\\`filamentTrees\.[a-zA-Z0-9_.]*\\\$\{[^}]*\}[a-zA-Z0-9_.]*\\\`|L\('[a-zA-Z0-9_]+'\)\" $FE_SRC | sort -u"
R14="grep -hoE 'useQuery|useMutation|useQueryClient|useIsMutating|(query|mutation)Key: [^,}]*|[A-Z_]+_KEY = \[[^]]*\]|(invalidate|remove|cancel|refetch)Queries\([^)]*\)|setQueryData\([^,]*,' $FE_SRC | sort -u"
R15='grep -nE "filament_trees" backend/app/main.py | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "FilamentProfilesPage|path=\"filament-profiles\"" frontend/src/App.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "filament-profiles" frontend/src/components/Layout.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//" | sort -u; grep -hoE "useSearchParams|useParams|useNavigate|searchParams\.(get|set|delete)\([^)]*\)|localStorage\.(get|set|remove)Item\([^,)]*" frontend/src/pages/FilamentProfilesPage.tsx frontend/src/components/filament-trees/*.tsx | sort -u; grep -rlE "components/filament-trees/|pages/FilamentProfilesPage" frontend/src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ | sort | sed "s/^/imports the feature: /"'

emit() { # emit <heading> <cmd>
  local heading="$1" cmd="$2"
  echo "## $heading"
  echo "\`\`\`regen: $cmd\`\`\`"
  echo '```'
  eval "$cmd"
  echo '```'
  echo ''
}

echo '# SURFACE.md — filament-tree campaign (F1) public contract: the filament profile tree (frozen at setup)'
echo ''
echo 'Regenerate with: `bash tools/gen_surface_ftree.sh > SURFACE.md` (from the repo root).'
echo 'Each section is replayable by the `regen:` command shown above it (repo root,'
echo '`LC_ALL=C`). Any diff against the committed copy is a change to something'
echo 'outside the feature`s own internals — a route or its permission, a public'
echo 'function signature, a request schema, a table column, a setting or permission'
echo 'the feature reads, an exported symbol, an API client type or method, a'
echo 'translation key, the wiring — and fails the iteration unless the user approved it.'
echo ''

emit 'HTTP routes under /api/v1/filament-trees: method, path, handler, doors (dependencies, permissions; sub-dependencies after <-)' "$R1"
emit 'Route decorators and router (routes/filament_trees.py)' "$R2"
emit 'Pydantic request/response schemas (schemas/filament_tree.py): fields, types, defaults' "$R3"
emit 'Tables the filament tree models own — DDL, SQLite and PostgreSQL' "$R4"
emit 'Backend public functions, classes, methods and constants of the in-scope modules, with signatures' "$R5"
emit 'Settings keys, env vars / app settings and borrowed helpers the feature reads' "$R6"
emit 'Permissions the routes require: values, default groups, categories, API keys, and where the frontend checks them' "$R7"
emit 'Registration points (main.py, models/__init__.py, core/database.py)' "$R8"
emit 'Frontend exported symbols, per file' "$R9"
emit 'API client — FilamentTree* exported types' "$R10"
emit 'API client — methods calling /filament-trees' "$R11"
emit 'Translation keys of the filamentTrees namespace (en key paths; placeholders after the key)' "$R12"
emit 'Translation keys the filament-tree UI reads (string literals, templates, orcaLayout L(...) labels)' "$R13"
emit 'React Query hooks, keys and invalidations in the filament-tree components' "$R14"
emit 'Wiring — router registration, page route, sidebar item, URL / storage state, importers' "$R15"
