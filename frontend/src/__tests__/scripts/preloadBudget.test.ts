import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs script with no type declarations; pure JS import is fine for tests
import { auditPreloads, BUDGET_GZIP_BYTES, FORBIDDEN } from '../../../scripts/check-preload-budget.mjs';

/** The eager set is everything index.html loads before the router has read
 *  the URL: the entry script, its modulepreload links and the stylesheet.
 *  The audit sums their gzipped size and names any chunk that must only ever
 *  load on demand. */
describe('auditPreloads', () => {
  it('sums gzip size of the entry script, modulepreloads and the stylesheet', () => {
    const html = `<script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/x-BBBBBBBB.js">
<link rel="stylesheet" crossorigin href="/assets/index-CCCCCCCC.css">
<link rel="icon" href="/img/favicon-32x32.png">`;
    const r = auditPreloads(html, () => Buffer.from('a'.repeat(1000)));
    expect(r.files.map((f: { href: string }) => f.href)).toEqual([
      '/assets/index-AAAAAAAA.js',
      '/assets/x-BBBBBBBB.js',
      '/assets/index-CCCCCCCC.css',
    ]);
    expect(r.totalGzipBytes).toBeGreaterThan(0);
    expect(r.totalGzipBytes).toBeLessThan(3000);
    expect(r.forbidden).toEqual([]);
  });

  it('flags forbidden chunks', () => {
    const r = auditPreloads('<link rel="modulepreload" href="/assets/shippingLabel-B3RFijiE.js">', () => Buffer.alloc(10));
    expect(r.forbidden).toEqual(['/assets/shippingLabel-B3RFijiE.js']);
  });

  it('names every chunk the spec moved out of the eager set', () => {
    for (const name of ['shippingLabel-B3RFijiE.js', 'PrintModal-CETkFpBs.js', 'OrbitControls-CqgsxA9T.js', 'PartViewerModal-jC4Vw5lD.js', 'LibraryFileDetailsModal-C0wv3ZcN.js', 'jszip.min-DhiFe-R7.js']) {
      expect(name, name).toMatch(FORBIDDEN);
    }
    expect('index-BBdVWW1C.js').not.toMatch(FORBIDDEN);
    expect(BUDGET_GZIP_BYTES).toBe(290_000);
  });
});
