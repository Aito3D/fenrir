import { describe, it, expect } from 'vitest';
import {
  alnum, digits, fold, foldWithMap, numericTail, phoneDigits, stripZeros, typedPhoneDigits, withinOneEdit,
  withoutCountryPrefix,
} from '../../utils/aitoSearchNormalize';

describe('aitoSearchNormalize', () => {
  it('folds case and accents', () => {
    expect(fold('Caméra ÉTÉ')).toBe('camera ete');
  });

  it('maps folded offsets back to the original string', () => {
    const { text, map } = foldWithMap('Pièce Ø');
    expect(text).toBe('piece ø');
    expect(map[2]).toBe(2); // 'e' of 'è'
    expect(map[text.length - 1]).toBe(6);
  });

  it('keeps digits only and drops the 689 prefix on long numbers', () => {
    expect(digits('+689 87.12-34 56')).toBe('68987123456');
    expect(phoneDigits('+689 87 12 34 56')).toBe('87123456');
    expect(phoneDigits('87 12 34 56')).toBe('87123456');
    expect(phoneDigits('689123')).toBe('689123');
  });

  it('strips a typed country prefix at any length', () => {
    for (const prefix of ['+689', '00689', '0689', '(689)']) {
      expect(withoutCountryPrefix(`${prefix}87`), prefix).toBe('87');
      expect(typedPhoneDigits(`${prefix}87`), prefix).toBe('87');
    }
    expect(withoutCountryPrefix('87123456')).toBeNull();
    expect(typedPhoneDigits('87.12.34.56')).toBe('87123456');
    expect(typedPhoneDigits('68987123456')).toBe('87123456');
  });

  it('normalises identifiers', () => {
    expect(alnum('DEV-00123')).toBe('dev00123');
    expect(stripZeros('00123')).toBe('123');
    expect(stripZeros('000')).toBe('0');
    expect(numericTail('DEV26-2638')).toBe('2638');
    expect(numericTail('INV-000123')).toBe('123');
    expect(numericTail('ABC')).toBe('');
  });

  it('accepts exactly one edit or one adjacent swap', () => {
    expect(withinOneEdit('dupont', 'dupont')).toBe(true);
    expect(withinOneEdit('dupnt', 'dupont')).toBe(true);
    expect(withinOneEdit('dupoont', 'dupont')).toBe(true);
    expect(withinOneEdit('dupomt', 'dupont')).toBe(true);
    expect(withinOneEdit('dpuont', 'dupont')).toBe(true);
    expect(withinOneEdit('dpunot', 'dupont')).toBe(false);
    expect(withinOneEdit('dup', 'dupont')).toBe(false);
  });
});
