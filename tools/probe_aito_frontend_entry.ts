// Barrel entry for the frontend golden probe. Bundled to CJS by rolldown (see
// PROBES.json) so tools/probe_aito_frontend.cjs can call the real modules.
// Loop machinery, not app code — nothing in src/ imports this.
export * as optimistic from '../frontend/src/utils/aitoOptimistic';
export * as board from '../frontend/src/utils/aitoBoard';
export * as aging from '../frontend/src/utils/aitoAging';
export * as search from '../frontend/src/utils/aitoSearch';
export * as summary from '../frontend/src/utils/aitoSummary';
export * as rules from '../frontend/src/utils/aitoBoardRules';
