/** Pressure advance lives in `filament_start_gcode` as `M900 K…` (54/56 live presets). */
const PA_RE = /M900[ \t]+K(\d*\.?\d+)/;

export function readPaK(gcode: string): string {
  return gcode.match(PA_RE)?.[1] ?? '';
}

/** User input → a K value ('' clears it), accepting a comma decimal; null when it is not a number. */
export function normalizePaK(input: string): string | null {
  const k = input.trim().replace(',', '.');
  return k === '' || /^\d*\.?\d+$/.test(k) ? k : null;
}

export function writePaK(gcode: string, k: string): string {
  const value = normalizePaK(k);
  if (value === null) return gcode;
  if (value === '') {
    return gcode.replace(/\n?M900[ \t]+K\d*\.?\d+[^\n]*\n?/, (m) => (m.startsWith('\n') && m.endsWith('\n') ? '\n' : ''));
  }
  const line = `M900 K${value}`;
  if (PA_RE.test(gcode)) return gcode.replace(PA_RE, line);
  return gcode ? `${gcode}\n${line}` : line;
}
