/** The project page's filament and cost figures. */
import { describe, it, expect } from 'vitest';
import { formatFilament, projectCost } from '../../../../components/projects/detail/format';

describe('formatFilament', () => {
  it('shows whole grams below a kilogram', () => {
    expect(formatFilament(249.6)).toBe('250g');
    expect(formatFilament(999.4)).toBe('999g');
  });

  it('rounds 999.6 g up to 1000g, not 1.00kg: the kilogram switch tests the raw value', () => {
    expect(formatFilament(999.6)).toBe('1000g');
  });

  it('switches to kilograms with two decimals from 1000 g', () => {
    expect(formatFilament(1000)).toBe('1.00kg');
    expect(formatFilament(1534)).toBe('1.53kg');
    expect(formatFilament(1250)).toBe('1.25kg');
  });
});

describe('projectCost', () => {
  it('adds filament, energy and wear, with no wear counted as zero', () => {
    expect(projectCost({ estimated_cost: 10, total_energy_cost: 2.5, total_wear_cost: 1 })).toBe(13.5);
    expect(projectCost({ estimated_cost: 10, total_energy_cost: 2.5, total_wear_cost: null as unknown as number })).toBe(12.5);
    expect(projectCost({ estimated_cost: 10, total_energy_cost: 2.5, total_wear_cost: undefined as unknown as number })).toBe(12.5);
  });
});
