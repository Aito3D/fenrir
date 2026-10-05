/** Item name for a dropped file: the file name without its extension. */
export function itemNameFromFile(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.gcode.3mf') && name.length > '.gcode.3mf'.length) return name.slice(0, -'.gcode.3mf'.length);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function filesFromDataTransfer(dt: DataTransfer): File[] {
  return Array.from(dt.files ?? []);
}

const FORBIDDEN_CHARS = '<>:"/\\|?*';
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** The backend's item `name_key` (`sanitize_component` then `casefold`), so a drop finds the item the
 * backend would call a duplicate. Lengths count code points, like Python. */
export function itemNameKey(name: string): string {
  let s = Array.from(name.trim().normalize('NFC'))
    .filter((c) => !FORBIDDEN_CHARS.includes(c) && c.charCodeAt(0) >= 0x20)
    .join('');
  s = s.trim().replace(/^\.+|\.+$/g, '').trim();
  s = Array.from(s).slice(0, 100).join('').replace(/[ .]+$/, '');
  if (!s) return '';
  if (WINDOWS_RESERVED.has(s.split('.')[0].toUpperCase())) s = `_${s}`;
  // Upper-then-lower approximates Python's casefold (ß → ss, ﬁ → fi).
  return s.toUpperCase().toLowerCase();
}
