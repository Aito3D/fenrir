import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../../utils/mathExpression';

const value = (text: string) => evaluateExpression(text)?.value ?? null;

describe('evaluateExpression', () => {
  it('reads a plain number as a literal', () => {
    expect(evaluateExpression('42')).toEqual({ value: 42, literal: true });
    expect(evaluateExpression('-3.5')).toEqual({ value: -3.5, literal: true });
    expect(evaluateExpression('5.')).toEqual({ value: 5, literal: true });
    expect(evaluateExpression('.5')).toEqual({ value: 0.5, literal: true });
  });

  it('accepts a decimal comma and ignores spaces', () => {
    expect(evaluateExpression('1,5')).toEqual({ value: 1.5, literal: true });
    expect(evaluateExpression('10 000')).toEqual({ value: 10000, literal: true });
    expect(evaluateExpression('10 000')).toEqual({ value: 10000, literal: true });
    expect(value('2,5 * 2')).toBe(5);
  });

  it('computes the four operations with precedence', () => {
    expect(evaluateExpression('4/2')).toEqual({ value: 2, literal: false });
    expect(value('1247-250')).toBe(997);
    expect(value('2+3*4')).toBe(14);
    expect(value('(2+3)*4')).toBe(20);
    expect(value('10-4-3')).toBe(3);
    expect(value('100/5/2')).toBe(10);
  });

  it('accepts x, X, × and ÷ as operators', () => {
    expect(value('3x4')).toBe(12);
    expect(value('3X4')).toBe(12);
    expect(value('3×4')).toBe(12);
    expect(value('12÷4')).toBe(3);
  });

  it('handles unary signs', () => {
    expect(value('-(2+3)')).toBe(-5);
    expect(value('4*-2')).toBe(-8);
    expect(value('+7')).toBe(7);
  });

  it('smooths floating-point noise', () => {
    expect(value('0.1+0.2')).toBe(0.3);
    expect(value('1.1*3')).toBe(3.3);
  });

  it.each(['', '   ', '4/', '*2', '2**3', '(1+2', '1+2)', '()', 'abc', '2a', '1.2.3', '1..2', '1/0', '0/0', '4/(2-2)'])(
    'rejects %j',
    (text) => {
      expect(evaluateExpression(text)).toBeNull();
    },
  );

  it('rejects input longer than 100 characters', () => {
    expect(evaluateExpression(`${'1+'.repeat(50)}1`)).toBeNull();
    expect(value(`${'1+'.repeat(49)}1`)).toBe(50);
  });
});
