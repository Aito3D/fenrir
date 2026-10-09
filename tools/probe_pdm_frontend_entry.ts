// Barrel entry for the Projects-PDM frontend golden probe. Bundled to CJS by
// rolldown (see PROBES.json) so tools/probe_pdm_frontend.cjs can call the real
// modules. Loop machinery, not app code — nothing in src/ imports this.
export * as filesUi from '../frontend/src/components/projects/files/filesUi';
export * as fileDrop from '../frontend/src/components/projects/files/fileDrop';
