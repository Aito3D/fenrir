import { describe, it, expect } from 'vitest';
import { findingCase } from '@/components/revenue/lib/finding';

describe('findingCase', () => {
  it('target and a change pick the ahead or behind sentence', () => {
    expect(findingCase(0.62, 0.08)).toBe('targetAhead');
    expect(findingCase(0.62, 0)).toBe('targetAhead');
    expect(findingCase(0.62, -0.03)).toBe('targetBehind');
  });

  it('a target without a change says the share only', () => {
    expect(findingCase(1.1, null)).toBe('target');
  });

  it('a change without a target says the change only', () => {
    expect(findingCase(null, 0.08)).toBe('ahead');
    expect(findingCase(null, -0.2)).toBe('behind');
  });

  it('neither figure: no finding', () => {
    expect(findingCase(null, null)).toBeNull();
  });
});
