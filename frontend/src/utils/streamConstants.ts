/** Shared streaming threshold constants used by grid, WebRTC, and single-camera hooks. */

/** Milliseconds without frames before blurring the canvas (early warning). */
export const STREAM_STALE_MS = 3_000;

/** Milliseconds without frames before marking the stream as degraded. */
export const STREAM_DEGRADED_MS = 10_000;

/** Milliseconds without frames before marking the stream as errored. */
export const STREAM_ERROR_MS = 45_000;

/** Reconnect base delay in milliseconds. */
export const RECONNECT_BASE_DELAY_MS = 2_000;

/** Maximum reconnect delay in milliseconds. */
export const RECONNECT_MAX_DELAY_MS = 30_000;
