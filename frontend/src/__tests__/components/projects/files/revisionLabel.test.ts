import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  outdatedParams,
  revisionLabel,
  revisionNumberLabel,
  sectionRevisionLabel,
} from '../../../../components/projects/files/revisionLabel';

describe('revisionNumberLabel', () => {
  it('is the bare revision number with an R prefix', () => {
    expect(revisionNumberLabel(3)).toBe('R3');
    expect(revisionNumberLabel(0)).toBe('R0');
    expect(revisionNumberLabel(12)).toBe('R12');
  });
});

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

describe('sectionRevisionLabel', () => {
  it('prefixes the translated section label and a single right angle quote to the revision label', () => {
    const t = ((key: string) => `<${key}>`) as unknown as TFunction;
    expect(sectionRevisionLabel(t, 'impression', 'Support', 3)).toBe(
      '<projectsPdm.files.sectionImpression> \u203a Support R3',
    );
    expect(sectionRevisionLabel(t, 'docs', '', 1)).toBe('<projectsPdm.files.sectionDocs> \u203a  R1');
  });
});
