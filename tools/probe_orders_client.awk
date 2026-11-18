# Order Board (O3) slice of frontend/src/api/client.ts, by content rather than line range:
#   types    every `export interface|type Order*|FinishedOrder*` declaration, whole (not Aito's OrderProjectLinks)
#   methods  every 2-space-indented member (of the `api` object) whose text mentions /order-board
# usage: awk -v what=types|methods|both -f tools/probe_orders_client.awk frontend/src/api/client.ts
function flush() { if (blk ~ /\/order-board/ && what != "types") printf "%s", blk; blk = "" }
BEGIN { if (what == "") what = "both" }
# a declaration runs until its braces balance on a line ending in ; or } (one-line or multi-line)
function depth(line,  o, c) { o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line); return o - c }
/^export (interface|type) (Order[A-Z]|FinishedOrder)/ && !/OrderProjectLinks/ { if (what != "methods") print; bal = depth($0); decl = !(bal == 0 && $0 ~ /[;}]$/); next }
decl { if (what != "methods") print; bal += depth($0); if (bal == 0 && $0 ~ /[;}]$/) decl = 0; next }
/^  [A-Za-z0-9_]+[:(]/ { flush(); member = 1 }
/^[^ \t]/ { flush(); member = 0 }
member { blk = blk $0 "\n" }
END { flush() }
