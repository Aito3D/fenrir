import { describe, it, expect, afterEach } from 'vitest';
import { prefersReducedMotion } from '../../utils/motion';

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

describe('prefersReducedMotion', () => {
  it('is false when the media query does not match', () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is true when the media query matches', () => {
    window.matchMedia = ((query: string) => ({ matches: true, media: query })) as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);
  });

  it('is false when matchMedia is unavailable', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });
});
