import { describe, it, expect } from 'vitest';
import { printProfileLine } from '../../../../components/projects/files/filesUi';

describe('printProfileLine', () => {
  it('is empty without a profile', () => {
    expect(printProfileLine(null)).toBe('');
  });

  it('joins every field of a full profile', () => {
    expect(
      printProfileLine({ printer_model: 'X1C', nozzle_diameter: 0.4, layer_height: 0.2, filament_types: ['PETG', 'PLA'] }),
    ).toBe('X1C · 0.4 mm · 0.2 mm · PETG, PLA');
  });

  it('skips the missing or empty fields of a partial profile', () => {
    expect(printProfileLine({ printer_model: 'P1S' })).toBe('P1S');
    expect(printProfileLine({ nozzle_diameter: 0, layer_height: 0.28, filament_types: 'PLA' })).toBe('0.28 mm');
    expect(printProfileLine({})).toBe('');
  });
});
