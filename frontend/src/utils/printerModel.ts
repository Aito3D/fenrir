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

// Map SSDP model codes to display names
export function mapModelCode(ssdpModel: string | null): string {
  if (!ssdpModel) return '';
  const modelMap: Record<string, string> = {
    // H2 Series
    'O1D': 'H2D',
    'O1E': 'H2D Pro',
    'O2D': 'H2D Pro',
    'O1C': 'H2C',
    'O1C2': 'H2C',
    'O1S': 'H2S',
    // X1 Series
    'BL-P001': 'X1C',
    'BL-P002': 'X1',
    'BL-P003': 'X1E',
    'C13': 'X1E',
    // X2 Series
    'N6': 'X2D',
    // A2 Series
    'N9': 'A2L',
    // P Series. A real P1P 3MF carries C11 next to "Bambu Lab P1P"; the
    // backend's PRINTER_MODEL_ID_MAP and the virtual printer use the same codes.
    'C11': 'P1P',
    'C12': 'P1S',
    'N7': 'P2S',
    // A1 Series
    'N2S': 'A1',
    'N1': 'A1 Mini',
    'A11': 'A1',
    'A12': 'A1 Mini',
    'A04': 'A1 Mini',
    // Direct matches
    'X1C': 'X1C',
    'X1': 'X1',
    'X1E': 'X1E',
    'X2D': 'X2D',
    'P1S': 'P1S',
    'P1P': 'P1P',
    'P2S': 'P2S',
    'A1': 'A1',
    'A1 Mini': 'A1 Mini',
    'A2L': 'A2L',
    'H2D': 'H2D',
    'H2D Pro': 'H2D Pro',
    'H2C': 'H2C',
    'H2S': 'H2S',
  };
  return modelMap[ssdpModel] || ssdpModel;
}
