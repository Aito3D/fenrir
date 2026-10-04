import { describe, it, expect } from 'vitest';
import { depositPrefill } from '../../components/aito/depositPrefill';

describe('depositPrefill', () => {
  it('pays the invoice in full when the deposit covers it', () => {
    expect(depositPrefill(5000, 7000)).toEqual({ amount: 5000, reason: 'paysInFull' });
  });
  it('uses the whole deposit when it falls short', () => {
    expect(depositPrefill(14000, 7000)).toEqual({ amount: 7000, reason: 'usesAll' });
  });
  it('prefers paysInFull on a tie', () => {
    expect(depositPrefill(7000, 7000)).toEqual({ amount: 7000, reason: 'paysInFull' });
  });
  it('rounds to cents', () => {
    expect(depositPrefill(100.005, 1000).amount).toBe(100.01);
  });
});
