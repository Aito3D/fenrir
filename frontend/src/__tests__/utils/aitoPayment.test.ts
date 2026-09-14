import { describe, it, expect } from 'vitest';
import { requiredAmount } from '../../utils/aitoPayment';

describe('requiredAmount', () => {
  it('rounds to the nearest franc with no deposit configured', () => {
    expect(requiredAmount(12500, 0)).toBe(12500);
  });

  it('rounds a fractional total with no deposit configured', () => {
    expect(requiredAmount(12500.4, 0)).toBe(12500);
  });

  it('takes the deposit share, ceiled', () => {
    expect(requiredAmount(12500, 30)).toBe(3750);
  });

  it('never rounds a franc short', () => {
    expect(requiredAmount(10001, 30)).toBe(3001);
  });

  it('is null without a total', () => {
    expect(requiredAmount(null, 0)).toBeNull();
  });

  it('is null for a non-positive total', () => {
    expect(requiredAmount(0, 30)).toBeNull();
  });
});
