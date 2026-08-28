import { describe, it, expect } from 'vitest';
import { parsedExample, QTY_DOMAIN, qtyDomainMax, roundK, roundKQ, sizeDomainMax, xToValue } from '../../../components/calculator/curveGeometry';

describe('curveGeometry', () => {
  it('size domain is 10K unless the example sits beyond it', () => {
    expect(sizeDomainMax(5000)).toBe(50000);
    expect(sizeDomainMax(5000, 20000)).toBe(50000);
    expect(sizeDomainMax(5000, 80000)).toBeCloseTo(88000, 6);
  });
  it('quantity domain is 100 unless the example sits beyond it', () => {
    expect(QTY_DOMAIN).toEqual([1, 100]);
    expect(qtyDomainMax()).toBe(100);
    expect(qtyDomainMax(50)).toBe(100);
    expect(qtyDomainMax(250)).toBeCloseTo(275, 6);
  });
  it('maps pixels linearly across the plot area and clamps outside it', () => {
    expect(xToValue(60, 60, 200, 0, 1000)).toBe(0);
    expect(xToValue(160, 60, 200, 0, 1000)).toBe(500);
    expect(xToValue(260, 60, 200, 0, 1000)).toBe(1000);
    expect(xToValue(-999, 60, 200, 0, 1000)).toBe(0);
    expect(xToValue(9999, 60, 200, 1, 100)).toBe(100);
    expect(xToValue(160, 60, 0, 0, 1000)).toBe(0); // zero-width plot never divides by zero
  });
  it('rounds K to three significant figures and KQ to an integer, both at least 1', () => {
    expect(roundK(12345)).toBe(12300);
    expect(roundK(4.567)).toBe(4.57);
    expect(roundK(0)).toBe(1);
    expect(roundKQ(19.6)).toBe(20);
    expect(roundKQ(0.2)).toBe(1);
  });
  it('parses the example job, nulling an unusable unit cost and flooring the quantity to at least 1', () => {
    expect(parsedExample({ unitCost: '', quantity: '5' })).toBeNull();
    expect(parsedExample({ unitCost: '0', quantity: '5' })).toBeNull();
    expect(parsedExample({ unitCost: '-5', quantity: '5' })).toBeNull();
    expect(parsedExample({ unitCost: 'abc', quantity: '5' })).toBeNull();
    expect(parsedExample({ unitCost: '10', quantity: '2.9' })).toEqual({ unitCost: 10, quantity: 2 });
    expect(parsedExample({ unitCost: '10', quantity: '0' })).toEqual({ unitCost: 10, quantity: 1 });
  });
});
