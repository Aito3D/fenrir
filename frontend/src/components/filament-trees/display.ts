/** A preset value as text: Orca stores most as one-item lists. */
export const display = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
