import { beforeEach, describe, expect, it } from 'vitest';
import {
  readBrandFilter,
  writeBrandFilter,
  readMaterialFilter,
  writeMaterialFilter,
  readGridSize,
  writeGridSize,
} from '../../utils/filamentProfilePrefs';

describe('filamentProfilePrefs', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('brand filter', () => {
    it('returns default when unset', () => {
      expect(readBrandFilter()).toBe('');
    });

    it('persists write→read roundtrip', () => {
      writeBrandFilter('FuturumWorks');
      expect(readBrandFilter()).toBe('FuturumWorks');
    });

    it('allows clearing via empty string', () => {
      writeBrandFilter('FuturumWorks');
      writeBrandFilter('');
      expect(readBrandFilter()).toBe('');
    });
  });

  describe('material filter', () => {
    it('returns default when unset', () => {
      expect(readMaterialFilter()).toBe('');
    });

    it('persists write→read roundtrip', () => {
      writeMaterialFilter('PETG');
      expect(readMaterialFilter()).toBe('PETG');
    });

    it('allows clearing via empty string', () => {
      writeMaterialFilter('PLA');
      writeMaterialFilter('');
      expect(readMaterialFilter()).toBe('');
    });
  });

  describe('grid size', () => {
    it('returns default "medium" when unset', () => {
      expect(readGridSize()).toBe('medium');
    });

    it('persists write→read roundtrip for "small"', () => {
      writeGridSize('small');
      expect(readGridSize()).toBe('small');
    });

    it('persists write→read roundtrip for "large"', () => {
      writeGridSize('large');
      expect(readGridSize()).toBe('large');
    });

    it('rejects invalid stored value and returns "medium"', () => {
      localStorage.setItem('profiles-grid-size', 'huge');
      expect(readGridSize()).toBe('medium');
    });

    it('rejects null stored value and returns "medium"', () => {
      localStorage.setItem('profiles-grid-size', 'null');
      expect(readGridSize()).toBe('medium');
    });

    it('rejects non-string stored value and returns "medium"', () => {
      localStorage.setItem('profiles-grid-size', '123');
      expect(readGridSize()).toBe('medium');
    });
  });
});
