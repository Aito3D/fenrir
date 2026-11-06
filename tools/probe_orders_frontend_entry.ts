// Barrel entry for the Order Board frontend golden probe. Bundled to CJS by
// rolldown (see PROBES.json) so tools/probe_orders_frontend.cjs can call the
// real modules. Loop machinery, not app code — nothing in src/ imports this.
export * as orderBoard from '../frontend/src/components/orders/orderBoard';
export * as orderStatus from '../frontend/src/components/orders/orderStatus';
export * as orderErrors from '../frontend/src/components/orders/orderErrors';
export { ApiError } from '../frontend/src/api/client';
