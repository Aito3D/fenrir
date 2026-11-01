#!/usr/bin/env node
/**
 * Fail the build when the eager preload set grows past its budget or carries
 * a chunk that must only ever load on demand.
 *
 * The eager set is what index.html fetches before React Router has looked at
 * the URL: the entry script, every `modulepreload` link and the stylesheet.
 * Every page load pays for it, on every device. In 2026-10 it had quietly
 * grown to 67 files / 491 KB gzipped because one constant in the public
 * tracking page was imported from the shipping-label module (react-dom/server
 * + a QR renderer) and the shell's confirm dialog statically imported the
 * print modal. Nothing failed; the app just got slower. This script turns
 * that into a build error.
 *
 * Two checks:
 *   1. `BUDGET_GZIP_BYTES`: the gzipped sum of the eager set. Lower it when a
 *      change shrinks the set; never raise it without a reason in the commit.
 *   2. `FORBIDDEN`: chunk names that belong behind a `React.lazy` boundary.
 *      If one shows up here, a static import has crept back in.
 *
 * Runs after `vite build` (see package.json). `node scripts/check-preload-budget.mjs [static-dir]`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export const BUDGET_GZIP_BYTES = 460_000;

/** Chunk basenames (Vite's `<name>-<hash>.<ext>`) that only load on demand. */
export const FORBIDDEN = /^(shippingLabel|PrintModal|OrbitControls|PartViewerModal|LibraryFileDetailsModal|jszip\.min)-/;

/**
 * @param {string} html index.html as built
 * @param {(href: string) => Buffer} readAsset reads the file an href points to
 */
export function auditPreloads(html, readAsset) {
  const hrefs = [];
  for (const m of html.matchAll(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g)) hrefs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)) hrefs.push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)) hrefs.push(m[1]);

  const files = hrefs.map((href) => ({ href, gzipBytes: gzipSync(readAsset(href), { level: 9 }).length }));
  const totalGzipBytes = files.reduce((sum, f) => sum + f.gzipBytes, 0);
  const forbidden = hrefs.filter((href) => FORBIDDEN.test(href.slice(href.lastIndexOf('/') + 1)));
  return { files, totalGzipBytes, forbidden };
}

function main() {
  const staticDir = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'static');
  const html = readFileSync(resolve(staticDir, 'index.html'), 'utf8');
  const { files, totalGzipBytes, forbidden } = auditPreloads(html, (href) => readFileSync(resolve(staticDir, href.replace(/^\//, ''))));

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  for (const f of [...files].sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 12)) {
    console.log(`  ${kb(f.gzipBytes).padStart(9)}  ${f.href}`);
  }
  console.log(`Eager preload set: ${files.length} files, ${kb(totalGzipBytes)} gzipped (budget ${kb(BUDGET_GZIP_BYTES)})`);

  let failed = false;
  if (forbidden.length) {
    failed = true;
    console.error(`✗ Lazy-only chunk(s) in the eager set:\n  ${forbidden.join('\n  ')}\n  A static import pulled them back in; find it with: grep -rn "from '.*/<name>'" src`);
  }
  if (totalGzipBytes > BUDGET_GZIP_BYTES) {
    failed = true;
    console.error(`✗ Eager set is ${kb(totalGzipBytes - BUDGET_GZIP_BYTES)} over budget.`);
  }
  if (failed) process.exit(1);
  console.log('✓ Eager preload set within budget.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
