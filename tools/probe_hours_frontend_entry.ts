// Barrel entry for the Hours-page frontend golden probe. Bundled to CJS by
// rolldown (see PROBES.json) so tools/probe_hours_frontend.cjs can call the
// real module. Loop machinery, not app code — nothing in src/ imports this.
export * as hoursSeries from '../frontend/src/utils/hoursSeries';
