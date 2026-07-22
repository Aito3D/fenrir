// Shared class strings for form controls. Extracted from the calculator page
// and settings panels so every form input in the feature looks identical.

export const inputCls =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white placeholder-bambu-gray no-spinner transition-colors focus:border-bambu-green focus:ring-2 focus:ring-bambu-green/20 focus:outline-none';

export const inputErrorCls =
  'w-full px-3 py-2 bg-bambu-dark border border-status-error/70 rounded-lg text-white placeholder-bambu-gray no-spinner transition-colors focus:border-status-error focus:ring-2 focus:ring-status-error/20 focus:outline-none';

export const labelCls = 'block text-sm text-bambu-gray mb-1';

// Branded keyboard-focus ring for custom controls (tabs, chips, icon buttons)
// that would otherwise fall back to the browser default outline.
export const focusRingCls =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40';
