# Filament-tree (F1) slice of frontend/src/api/client.ts, by content rather than line range:
#   types    every `export interface|type FilamentTree*` declaration, whole
#   methods  every 2-space-indented member (of the `api` object) whose text mentions /filament-trees
# usage: awk -v what=types|methods|both -f tools/probe_ftree_client.awk frontend/src/api/client.ts
function flush() { if (blk ~ /\/filament-trees/ && what != "types") printf "%s", blk; blk = "" }
BEGIN { if (what == "") what = "both" }
/^export (interface|type) FilamentTree/ { if (what != "methods") print; if ($0 !~ /[;}]$/) decl = 1; next }
decl { if (what != "methods") print; if ($0 ~ /^}/) decl = 0; next }
/^  [A-Za-z0-9_]+[:(]/ { flush(); member = 1 }
/^[^ \t]/ { flush(); member = 0 }
member { blk = blk $0 "\n" }
END { flush() }
