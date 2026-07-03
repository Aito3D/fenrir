/**
 * Open the standalone camera window for a printer, restoring the user's saved
 * window size/position from localStorage. Shared by the printer-card camera
 * button and the camera-grid tile expand action.
 *
 * No `noopener`: the same-origin popup needs `opener` so the browser copies
 * sessionStorage (auth token) into the new window.
 */
export function openCameraWindow(printerId: number): void {
  let state: { width?: unknown; height?: unknown; left?: unknown; top?: unknown } = {};
  try {
    state = JSON.parse(localStorage.getItem('cameraWindowState') || '{}');
  } catch {
    // Corrupted saved state — fall back to defaults
  }
  const width = typeof state.width === 'number' ? state.width : 640;
  const height = typeof state.height === 'number' ? state.height : 400;
  const features = [
    `width=${width}`,
    `height=${height}`,
    typeof state.left === 'number' ? `left=${state.left}` : '',
    typeof state.top === 'number' ? `top=${state.top}` : '',
    'menubar=no,toolbar=no,location=no,status=no',
  ].filter(Boolean).join(',');
  window.open(`/camera/${printerId}`, `camera-${printerId}`, features);
}
