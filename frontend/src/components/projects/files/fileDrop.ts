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
