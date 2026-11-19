import { describe, it, expect } from 'vitest';
import { findingCase, isLevel } from '@/components/revenue/lib/finding';

describe('findingCase', () => {
  it('target and a change pick the ahead or behind sentence', () => {
    expect(findingCase(0.62, 0.08)).toBe('targetAhead');
    expect(findingCase(0.62, -0.03)).toBe('targetBehind');
  });

  it('a target without a change says the share only', () => {
    expect(findingCase(1.1, null)).toBe('target');
  });

  it('a change without a target says the change only', () => {
    expect(findingCase(null, 0.08)).toBe('ahead');
    expect(findingCase(null, -0.2)).toBe('behind');
  });

  it('a change under half a percent either way reads as level', () => {
    expect(findingCase(0.62, 0)).toBe('targetLevel');
    expect(findingCase(0.62, 0.0049)).toBe('targetLevel');
    expect(findingCase(0.62, -0.0049)).toBe('targetLevel');
    expect(findingCase(null, 0.0049)).toBe('level');
    expect(findingCase(null, -0.0049)).toBe('level');
  });

  it('half a percent is a change, not level', () => {
    expect(findingCase(0.62, 0.005)).toBe('targetAhead');
    expect(findingCase(0.62, -0.005)).toBe('targetBehind');
    expect(findingCase(null, 0.005)).toBe('ahead');
    expect(findingCase(null, -0.005)).toBe('behind');
    expect(isLevel(0.005)).toBe(false);
    expect(isLevel(-0.0049)).toBe(true);
  });

  it('neither figure: no finding', () => {
    expect(findingCase(null, null)).toBeNull();
  });
});
