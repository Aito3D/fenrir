import { describe, it, expect } from 'vitest';
import { queueItemDisplayName } from '../../utils/queueItemName';

const more = (n: number) => `+${n} more`;

describe('queueItemDisplayName', () => {
  it('prefers archive_name over everything else', () => {
    expect(
      queueItemDisplayName({
        archive_name: 'A',
        library_file_name: 'L',
        variants: [{ filename: 'V' }],
        archive_id: 1,
      }),
    ).toBe('A');
  });

  it('uses library_file_name when there is no archive_name', () => {
    expect(
      queueItemDisplayName({ archive_name: null, library_file_name: 'L', variants: [{ filename: 'V' }] }),
    ).toBe('L');
  });

  it('names a cross-model item after its first variant plus a more label', () => {
    const variants = [{ filename: 'first.3mf' }, { filename: 'b.3mf' }, { filename: 'c.3mf' }];
    expect(queueItemDisplayName({ variants }, more)).toBe('first.3mf +2 more');
  });

  it('gives just the first filename with a single variant', () => {
    expect(queueItemDisplayName({ variants: [{ filename: 'only.3mf' }] }, more)).toBe('only.3mf');
  });

  it('gives just the first filename when no moreLabel is passed', () => {
    const variants = [{ filename: 'first.3mf' }, { filename: 'b.3mf' }];
    expect(queueItemDisplayName({ variants })).toBe('first.3mf');
  });

  it('falls back to the archive id, which wins over the library file id', () => {
    expect(queueItemDisplayName({ archive_id: 5, library_file_id: 9 })).toBe('File #5');
    expect(queueItemDisplayName({ archive_id: null, library_file_id: 9 })).toBe('File #9');
  });

  it('treats empty variants as none', () => {
    expect(queueItemDisplayName({ variants: [], library_file_id: 3 }, more)).toBe('File #3');
  });

  it('renders File #undefined when nothing is available (current behavior)', () => {
    expect(queueItemDisplayName({})).toBe('File #undefined');
  });
});
