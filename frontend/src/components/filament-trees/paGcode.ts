import { extractPaK } from '../filament-profiles/presetJson';

/** Pressure advance lives in `filament_start_gcode` as `M900 K…` (54/56 live presets). */
export const readPaK = extractPaK;

export function writePaK(gcode: string, k: string): string {
  if (k === '') return gcode.replace(/\n?M900 K[\d.]+[^\n]*\n?/, (m) => (m.startsWith('\n') && m.endsWith('\n') ? '\n' : ''));
  const line = `M900 K${k}`;
  if (/M900 K[\d.]+/.test(gcode)) return gcode.replace(/M900 K[\d.]+/, line);
  return gcode ? `${gcode}\n${line}` : line;
}
