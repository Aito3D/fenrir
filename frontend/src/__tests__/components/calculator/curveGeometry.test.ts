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
  // T-049: qty_k (kq) renders the KQ handle at kq + 1, so the domain must
  // stretch to always contain it — otherwise the handle clamps to the
  // domain's edge and a single click/arrow key collapses the field back
  // down (a stored qty_k of 500 rewriting itself to 99).
  it('quantity domain also stretches to always contain kq + 1, unlike the un-stretched size floor', () => {
    // Small kq (including every value used by today's shipped defaults and
    // existing tests) fits comfortably inside the un-stretched 100 floor —
    // domain/ticks stay byte-for-byte what they were before this fix.
    expect(qtyDomainMax(undefined, 5)).toBe(100);
    expect(qtyDomainMax(undefined, 1)).toBe(100);
    expect(qtyDomainMax(undefined, 0)).toBe(100);
    expect(qtyDomainMax(undefined, 99)).toBe(100); // kq + 1 = 100, still exactly at the floor
    // kq large enough that kq + 1 would sit at/past the floor stretches the
    // domain to comfortably contain it (additively, not proportionally —
    // see the KQ_HEADROOM comment on qtyDomainMax).
    expect(qtyDomainMax(undefined, 500)).toBe(551);
    expect(qtyDomainMax(undefined, 100)).toBe(151);
    // An example quantity beyond the kq-stretched base still stretches
    // further, exactly as it does past the un-stretched 100 floor.
    expect(qtyDomainMax(1000, 500)).toBeCloseTo(1100, 6);
    // A NaN/negative/zero kq is treated as "no kq coupling", same as
    // omitting it — never collapses or inflates the floor.
    expect(qtyDomainMax(undefined, NaN)).toBe(100);
    expect(qtyDomainMax(undefined, -5)).toBe(100);
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
