import { describe, it, expect, vi, afterEach } from 'vitest';
import { toSafeExternalUrl, openSafeExternalUrl } from '../../utils/safeExternalUrl';

describe('toSafeExternalUrl', () => {
  it('passes through a normal https:// URL unchanged', () => {
    expect(toSafeExternalUrl('https://printables.com/model/12345')).toBe('https://printables.com/model/12345');
  });

  it('passes through a normal http:// URL unchanged', () => {
    expect(toSafeExternalUrl('http://printables.com/model/12345')).toBe('http://printables.com/model/12345');
  });

  it('normalises a scheme-less URL to https:// instead of dropping it', () => {
    expect(toSafeExternalUrl('example.com/thing')).toBe('https://example.com/thing');
  });

  it('rejects a javascript: URL', () => {
    expect(toSafeExternalUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects a data: URL', () => {
    expect(toSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects a case-varied javascript: URL', () => {
    expect(toSafeExternalUrl('JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('returns null for null/undefined/empty input', () => {
    expect(toSafeExternalUrl(null)).toBeNull();
    expect(toSafeExternalUrl(undefined)).toBeNull();
    expect(toSafeExternalUrl('')).toBeNull();
    expect(toSafeExternalUrl('   ')).toBeNull();
  });
});

describe('openSafeExternalUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls window.open for a normal https:// URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openSafeExternalUrl('https://printables.com/model/12345');
    expect(openSpy).toHaveBeenCalledWith('https://printables.com/model/12345', '_blank');
  });

  it('never calls window.open for a javascript: URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openSafeExternalUrl('javascript:alert(document.cookie)');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('never calls window.open for a data: URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openSafeExternalUrl('data:text/html,<script>alert(1)</script>');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('normalises a scheme-less URL before opening it', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openSafeExternalUrl('example.com/thing');
    expect(openSpy).toHaveBeenCalledWith('https://example.com/thing', '_blank');
  });

  it('is a no-op for a nullish/empty URL', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    openSafeExternalUrl(null);
    openSafeExternalUrl(undefined);
    openSafeExternalUrl('');
    expect(openSpy).not.toHaveBeenCalled();
  });
});
