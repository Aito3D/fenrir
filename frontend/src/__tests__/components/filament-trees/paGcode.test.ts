import { describe, expect, it } from 'vitest';
import { normalizePaK, readPaK, writePaK } from '../../../components/filament-trees/paGcode';

describe('paGcode', () => {
  it('reads the M900 K value', () => {
    expect(readPaK('M900 L1000 M10\nM900 K0.035')).toBe('0.035');
    expect(readPaK('; nothing here')).toBe('');
  });

  it('replaces an existing K value', () => {
    expect(writePaK('M900 L1000 M10\nM900 K0.035', '0.028')).toBe('M900 L1000 M10\nM900 K0.028');
  });

  it('appends the line when absent', () => {
    expect(writePaK('; start', '0.02')).toBe('; start\nM900 K0.02');
    expect(writePaK('', '0.02')).toBe('M900 K0.02');
  });

  it('removes the line when k is empty', () => {
    expect(writePaK('M900 L1000 M10\nM900 K0.035', '')).toBe('M900 L1000 M10');
    expect(writePaK('M900 K0.035\n; after', '')).toBe('; after');
  });

  it('normalises user input and refuses non-numbers', () => {
    expect(normalizePaK(' 0,028 ')).toBe('0.028');
    expect(normalizePaK('.02')).toBe('.02');
    expect(normalizePaK('')).toBe('');
    expect(normalizePaK('abc')).toBeNull();
    expect(normalizePaK('0.0.2')).toBeNull();
    expect(writePaK('M900 K0.035', 'abc')).toBe('M900 K0.035');
    expect(writePaK('M900 K0.035', '0,03')).toBe('M900 K0.03');
  });

  it('tolerates extra spaces and trailing arguments', () => {
    expect(readPaK('M900  K0.04 L1000')).toBe('0.04');
    expect(writePaK('M900 K0.04 L1000', '0.05')).toBe('M900 K0.05 L1000');
  });
});
