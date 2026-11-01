/** Routes that are pages of their own but not sidebar items. Consulted before
 *  the nav list so `/files/trash` is "Trash", not "Files". */
const EXTRA: ReadonlyArray<[RegExp, string]> = [
  [/^\/system$/, 'system.title'],
  [/^\/files\/trash$/, 'libraryTrash.title'],
  [/^\/printer-locations$/, 'printers.locations.title'],
  [/^\/groups\/new$/, 'groups.editor.createTitle'],
  [/^\/groups\/\d+\/edit$/, 'groups.editor.title'],
];

/** Pages with no title of their own: the bar shows the logo alone. */
const NONE: ReadonlyArray<RegExp> = [/^\/gcode-viewer$/, /^\/external\//];

/** The i18n key of the page name the phone top bar shows for a pathname, or
 *  null when nothing fits — never a wrong name. */
export function pageTitleKey(
  pathname: string,
  nav: ReadonlyArray<{ to: string; labelKey: string }>,
): string | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const [pattern, key] of EXTRA) if (pattern.test(path)) return key;
  for (const pattern of NONE) if (pattern.test(path)) return null;
  let best: { to: string; labelKey: string } | null = null;
  for (const item of nav) {
    if (item.to === '/') {
      if (path === '/') return item.labelKey;
      continue;
    }
    if (path === item.to || path.startsWith(`${item.to}/`)) {
      if (best === null || item.to.length > best.to.length) best = item;
    }
  }
  return best?.labelKey ?? null;
}
