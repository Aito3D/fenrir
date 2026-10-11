import { describe, expect, it } from 'vitest';
import { outdatedParams, revisionLabel } from '../../../../components/projects/files/revisionLabel';

describe('revisionLabel', () => {
  it('joins the item name and the revision number', () => {
    expect(revisionLabel('Support', 3)).toBe('Support R3');
    expect(revisionLabel('', 1)).toBe(' R1');
  });
});

describe('outdatedParams', () => {
  it('labels the source revision in full and the newer one by number only', () => {
    expect(outdatedParams({ item_name: 'Support', number: 1 }, { number: 2 })).toEqual({
      source: 'Support R1',
      newer: 'R2',
    });
  });
});
