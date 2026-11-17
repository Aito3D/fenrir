// Barrel entry for the Order Board (O3) frontend golden probe. Bundled to CJS by rolldown
// (see PROBES.json) so tools/probe_orders_frontend.cjs can call the real modules. Loop
// machinery, not app code — nothing in src/ imports this. Only the pure modules: the rest
// of components/orders/ are React components and hooks.
export * as board from '../frontend/src/components/orders/orderBoard';
export * as status from '../frontend/src/components/orders/orderStatus';
export * as errors from '../frontend/src/components/orders/orderErrors';
export * as kinds from '../frontend/src/components/orders/orderEventKinds';
export * as tracking from '../frontend/src/utils/orderTracking';
export { ApiError } from '../frontend/src/api/client';
