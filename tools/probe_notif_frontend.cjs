// Golden probe: the notification UI's pure modules — the inbox kind table
// (icon name, tone classes, family, title key per kind, and the lookup for an
// unknown kind) and utils/notify. Pure values only; TZ pinned.
process.env.TZ = "UTC";
const store = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
for (const k of ["localStorage", "sessionStorage"]) Object.defineProperty(globalThis, k, { value: store, configurable: true, writable: true });
const bundle = require("/tmp/fenrir-refactor-notif-probe/notifFrontend.cjs");
const out = {};
const K = bundle.kinds;
out.kindsExports = Object.keys(K).sort();
out.kinds = {};
for (const [kind, meta] of Object.entries(K.NOTIFICATION_KINDS || {}).sort()) {
  out.kinds[kind] = { ...meta, icon: meta.icon && (meta.icon.displayName || meta.icon.name || String(meta.icon)) };
}
for (const name of Object.keys(K)) {
  if (typeof K[name] === "function" && name !== "NOTIFICATION_KINDS") {
    out[name] = {};
    for (const arg of ["aito.paid", "printer.job_sent", "nope", "", undefined]) {
      try { const v = K[name](arg); out[name][String(arg)] = v && v.icon ? { ...v, icon: v.icon.displayName || v.icon.name } : v === undefined ? "__undefined__" : v; }
      catch (e) { out[name][String(arg)] = { __threw__: `${e.name}: ${e.message}` }; }
    }
  }
}
out.unknownKind = K.UNKNOWN_KIND && { ...K.UNKNOWN_KIND, icon: K.UNKNOWN_KIND.icon && (K.UNKNOWN_KIND.icon.displayName || K.UNKNOWN_KIND.icon.name) };
out.notifyExports = Object.keys(bundle.notify).sort();
out.notify = {};
for (const name of out.notifyExports) {
  out.notify[name] = {};
  for (const arg of ["ABCDEFGH1234", "WB123456", "wb123456", "GRP12345", "MC123456", " WB1 ", "", null, undefined, 42]) {
    try { out.notify[name][String(arg)] = bundle.notify[name](arg); } catch (e) { out.notify[name][String(arg)] = { __threw__: `${e.name}: ${e.message}` }; }
  }
}
console.log(JSON.stringify(out, null, 1));
