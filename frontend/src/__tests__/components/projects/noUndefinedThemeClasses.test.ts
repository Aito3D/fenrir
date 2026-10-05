import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** `bambu-card` is not a theme colour (index.css defines bambu-dark /
 *  -secondary / -tertiary only), so `bg-bambu-card` renders a TRANSPARENT
 *  surface: a dialog's text bleeds through to the page under it. The
 *  fork-owned project UI uses the Card surface (`bg-bambu-dark-secondary`)
 *  instead. Upstream pages (ProjectsPage, ProjectDetailPage, …) are left as
 *  they ship. */
const SRC = join(__dirname, '..', '..', '..');
const FORK_OWNED = [join(SRC, 'components', 'projects'), join(SRC, 'pages', 'ProjectListPage.tsx')];

function sources(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => sources(join(path, name)));
}

describe('fork-owned project UI', () => {
  it('uses no undefined bambu-card colour', () => {
    const offenders = FORK_OWNED.flatMap(sources)
      .filter((file) => /\.tsx?$/.test(file) && /\bbambu-card\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});
