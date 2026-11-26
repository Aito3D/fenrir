import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    getArchiveThumbnail: vi.fn((id: number) => `archive:${id}`),
    getArchivePlateThumbnail: vi.fn((id: number, plate: number) => `archive:${id}:plate:${plate}`),
    getLibraryFileThumbnailUrl: vi.fn((id: number) => `lib:${id}`),
    getLibraryFilePlateThumbnail: vi.fn((id: number, plate: number) => `lib:${id}:plate:${plate}`),
  },
}));

import { queueItemThumbnailUrl } from '../../utils/queueItemThumbnail';

describe('queueItemThumbnailUrl', () => {
  it('uses the archive file thumbnail without a plate', () => {
    expect(queueItemThumbnailUrl({ archive_id: 1, archive_thumbnail: 't' })).toBe('archive:1');
    expect(queueItemThumbnailUrl({ archive_id: 1, archive_thumbnail: 't', plate_id: null })).toBe('archive:1');
  });

  it('uses the archive plate thumbnail when plate_id is set, including 0', () => {
    expect(queueItemThumbnailUrl({ archive_id: 1, archive_thumbnail: 't', plate_id: 2 })).toBe('archive:1:plate:2');
    expect(queueItemThumbnailUrl({ archive_id: 1, archive_thumbnail: 't', plate_id: 0 })).toBe('archive:1:plate:0');
  });

  it('uses the library file thumbnail without a plate', () => {
    expect(queueItemThumbnailUrl({ library_file_id: 7, library_file_thumbnail: 't' })).toBe('lib:7');
  });

  it('uses the library plate thumbnail when plate_id is set, including 0', () => {
    expect(queueItemThumbnailUrl({ library_file_id: 7, library_file_thumbnail: 't', plate_id: 3 })).toBe('lib:7:plate:3');
    expect(queueItemThumbnailUrl({ library_file_id: 7, library_file_thumbnail: 't', plate_id: 0 })).toBe('lib:7:plate:0');
  });

  it('prefers the archive source over the library source', () => {
    expect(
      queueItemThumbnailUrl({
        archive_id: 1,
        archive_thumbnail: 't',
        library_file_id: 7,
        library_file_thumbnail: 't',
      }),
    ).toBe('archive:1');
  });

  it('falls through to the library when the archive thumbnail has no id', () => {
    expect(
      queueItemThumbnailUrl({
        archive_thumbnail: 't',
        library_file_id: 7,
        library_file_thumbnail: 't',
      }),
    ).toBe('lib:7');
  });

  it('treats id 0 as a valid id (null check, not truthiness)', () => {
    expect(queueItemThumbnailUrl({ archive_id: 0, archive_thumbnail: 't' })).toBe('archive:0');
    expect(queueItemThumbnailUrl({ library_file_id: 0, library_file_thumbnail: 't' })).toBe('lib:0');
  });

  it('returns null for a thumbnail without its id, or with no source', () => {
    expect(queueItemThumbnailUrl({ archive_thumbnail: 't' })).toBeNull();
    expect(queueItemThumbnailUrl({ library_file_thumbnail: 't', library_file_id: null })).toBeNull();
    expect(queueItemThumbnailUrl({ archive_id: 1, library_file_id: 2 })).toBeNull();
    expect(queueItemThumbnailUrl({})).toBeNull();
  });
});
