// Barrel entry for the Revenue (RV1) frontend golden probe. Bundled to CJS by rolldown (see
// PROBES.json) so tools/probe_revenue_frontend.cjs can call the real modules. Loop machinery,
// not app code — nothing in src/ imports this. Only components/revenue/lib/*: the rest of
// components/revenue/ are React components and hooks. types.ts holds types only.
export * as analysis from '../frontend/src/components/revenue/lib/analysis';
export * as basket from '../frontend/src/components/revenue/lib/basket';
export * as buckets from '../frontend/src/components/revenue/lib/buckets';
export * as chart from '../frontend/src/components/revenue/lib/chart';
export * as csv from '../frontend/src/components/revenue/lib/csv';
export * as dashboard from '../frontend/src/components/revenue/lib/dashboard';
export * as dates from '../frontend/src/components/revenue/lib/dates';
export * as finding from '../frontend/src/components/revenue/lib/finding';
export * as format from '../frontend/src/components/revenue/lib/format';
export * as insights from '../frontend/src/components/revenue/lib/insights';
export * as kpis from '../frontend/src/components/revenue/lib/kpis';
export * as products from '../frontend/src/components/revenue/lib/products';
export * as search from '../frontend/src/components/revenue/lib/search';
export * as url from '../frontend/src/components/revenue/lib/url';
