/**
 * Check if a printer model supports RTSP streaming (mirrors backend supports_rtsp()).
 *
 * RTSP supported: X1, X1C, X1E, H2C, H2D, H2DPRO, H2S, P2S
 * Chamber image only: A1, A1MINI, P1P, P1S
 */
export function supportsRtsp(model: string | null | undefined): boolean {
  if (!model) return false;
  const upper = model.toUpperCase();
  // Display names
  if (upper.startsWith('X1') || upper.startsWith('H2') || upper.startsWith('P2')) {
    return true;
  }
  // Internal codes from MQTT/SSDP
  const internalCodes = new Set(['BL-P001', 'C13', 'O1D', 'O1C', 'O1C2', 'O1S', 'O1E', 'O2D', 'N7']);
  return internalCodes.has(upper);
}
