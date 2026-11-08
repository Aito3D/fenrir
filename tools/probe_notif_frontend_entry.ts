// Barrel entry for the notifications frontend golden probe. Bundled to CJS by
// rolldown (see PROBES.json) so tools/probe_notif_frontend.cjs can call the
// real modules. Loop machinery, not app code — nothing in src/ imports this.
export * as kinds from '../frontend/src/components/notificationKinds';
export * as notify from '../frontend/src/utils/notify';
