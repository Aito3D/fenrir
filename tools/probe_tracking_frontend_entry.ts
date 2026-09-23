// Entry bundled by rolldown for the tracking-page frontend probe.
//
// Only the PURE modules of the feature: the copy/ETA/date rules the page
// derives its words from, the motion clocks the rail and the entry page are
// choreographed by, the client-side code normaliser, and the shell tokens.
// Components and hooks are deliberately absent — they need React, i18n and a
// query client to say anything, and the vitest suite already renders them.
export * as tracking from '../frontend/src/utils/aitoTracking';
export * as code from '../frontend/src/utils/trackingCode';
export * as shell from '../frontend/src/utils/trackingShell';
