/**
 * Archive thumbnail URLs are stable between renders and change only when the
 * image may have.
 *
 * The URL ended in `?v=${Date.now()}`: every render of a card built a new
 * URL, so the browser re-downloaded every thumbnail on every hover, search
 * keystroke and list refetch. The version still has to move when an archive's
 * image can change (the id-reuse bug e97d697d9 fixed), so it is a per-load
 * stamp plus a per-archive counter bumped by create/update/delete.
 */
import { describe, it, expect } from 'vitest';
import { api, bumpArchiveThumbnail } from '../../api/client';

describe('archive thumbnail URL', () => {
  it('is the same on every call', () => {
    expect(api.getArchiveThumbnail(41)).toBe(api.getArchiveThumbnail(41));
  });

  it('changes for that archive when its image may have changed', () => {
    const before = api.getArchiveThumbnail(42);
    const other = api.getArchiveThumbnail(43);
    bumpArchiveThumbnail(42);
    expect(api.getArchiveThumbnail(42)).not.toBe(before);
    expect(api.getArchiveThumbnail(43)).toBe(other);
  });

  it('still points at the thumbnail route', () => {
    expect(api.getArchiveThumbnail(44)).toMatch(/\/archives\/44\/thumbnail\?v=/);
  });
});
