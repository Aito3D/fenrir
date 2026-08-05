/**
 * ALSO FIX 7: `SHIPPING_PHONE_RE` in useAitoPageMutations.ts mirrors
 * `_SHIPPING_PHONE_RE` in backend/app/api/routes/aito.py, bound only by a
 * comment on each side. This reads the backend's actual source at test time
 * — rather than hardcoding a second copy of the pattern here, which would
 * only ever catch a divergence the test author remembered to update — so a
 * future edit to either side that is not mirrored on the other fails loudly.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SHIPPING_PHONE_RE } from '../../hooks/useAitoPageMutations';

const here = dirname(fileURLToPath(import.meta.url));

describe('SHIPPING_PHONE_RE', () => {
  it('matches _SHIPPING_PHONE_RE in backend/app/api/routes/aito.py exactly', () => {
    const backendSource = readFileSync(
      resolve(here, '../../../../backend/app/api/routes/aito.py'),
      'utf-8',
    );
    const match = backendSource.match(/_SHIPPING_PHONE_RE\s*=\s*re\.compile\(r"([^"]+)"\)/);
    expect(match, 'backend _SHIPPING_PHONE_RE definition not found — did it move or get renamed?').not.toBeNull();
    expect(SHIPPING_PHONE_RE.source).toBe(match![1]);
  });
});
