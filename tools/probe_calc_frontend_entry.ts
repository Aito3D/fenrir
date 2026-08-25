// Entry point bundled by rolldown for the calc-frontend-pure golden probe.
// Re-exports the campaign-6 frontend scope's PURE modules under stable
// namespaces so the probe script can reach them by name.
export * as insights from '../frontend/src/utils/calculatorInsights';
export * as quote from '../frontend/src/utils/quoteSummary';
