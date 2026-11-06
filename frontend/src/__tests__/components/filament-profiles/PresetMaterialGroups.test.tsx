import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';

import type { FilamentPreset } from '../../../api/client';
import { PresetMaterialGroups } from '../../../components/filament-profiles/PresetMaterialGroups';
import { groupPresetsByMaterial } from '../../../components/filament-profiles/presetGroups';
import { render } from '../../utils';

let nextId = 1;
function preset(brand: string, material: string, color: string, temp = '246', pa = '0.035'): FilamentPreset {
  return {
    id: nextId++,
    name: `${brand} ${material} - ${color}`,
    brand,
    material: '',
    color: '',
    color_hex: '#123456',
    filename: `${brand}-${material}-${color}.json`,
    content: JSON.stringify({
      nozzle_temperature: [temp],
      filament_flow_ratio: ['0.970'],
      filament_start_gcode: [`M900 K${pa}`],
      compatible_printers: ['Bambu Lab H2S 0.4 nozzle'],
    }),
    created_at: '',
    updated_at: '',
  } as FilamentPreset;
}

describe('groupPresetsByMaterial', () => {
  it('sections by material (largest first), one row per brand', () => {
    const groups = groupPresetsByMaterial([
      preset('SUNLU', 'PLA', 'Black'),
      preset('Polymaker', 'PETG', 'Red'),
      preset('SUNLU', 'PETG', 'Blue'),
    ]);
    expect(groups.map((g) => g.material)).toEqual(['PETG', 'PLA']);
    expect(groups[0].brands.map((b) => b.brand)).toEqual(['Polymaker', 'SUNLU']);
  });

  it('a lone differing colour is an outlier, 2+ sharing settings form a variant line', () => {
    const [group] = groupPresetsByMaterial([
      preset('SUNLU', 'PETG', 'Red'),
      preset('SUNLU', 'PETG', 'Blue'),
      preset('SUNLU', 'PETG', 'Green'),
      preset('SUNLU', 'PETG', 'Silver', '250'),
      preset('SUNLU', 'PETG', 'Black', '246', '0.04'),
      preset('SUNLU', 'PETG', 'White', '246', '0.04'),
    ]);
    const row = group.brands[0];
    expect(row.lines.map((l) => l.map((e) => e.color))).toEqual([
      ['Blue', 'Green', 'Red'],
      ['Black', 'White'],
    ]);
    expect(row.outliers.map((e) => e.color)).toEqual(['Silver']);
  });

  it('with no shared settings the first colour alphabetically sets the line', () => {
    const [group] = groupPresetsByMaterial([preset('eSUN', 'PLA', 'White', '220'), preset('eSUN', 'PLA', 'Black', '210')]);
    expect(group.brands[0].lines[0].map((e) => e.color)).toEqual(['Black']);
    expect(group.brands[0].outliers.map((e) => e.color)).toEqual(['White']);
  });
});

describe('PresetMaterialGroups', () => {
  it('shows only the differing value on an outlier and wires open/add-colour', () => {
    const red = preset('Polymaker', 'PETG', 'Red');
    const silver = preset('Polymaker', 'PETG', 'Silver', '250');
    const onOpen = vi.fn();
    const onAddColor = vi.fn();
    render(<PresetMaterialGroups presets={[red, preset('Polymaker', 'PETG', 'Blue'), silver]} onOpen={onOpen} onAddColor={onAddColor} />);

    expect(screen.getByText('246°C')).toBeInTheDocument();
    expect(screen.getByText('250°C')).toBeInTheDocument();
    expect(screen.getAllByText('PA 0.035')).toHaveLength(1);

    fireEvent.click(screen.getByText('Silver'));
    expect(onOpen).toHaveBeenCalledWith(silver);
    fireEvent.click(screen.getByRole('button', { name: 'Add a colour with these settings' }));
    expect(onAddColor).toHaveBeenCalledWith(expect.objectContaining({ brand: 'Polymaker' }));
  });

  it('hides add-colour without create permission', () => {
    render(<PresetMaterialGroups presets={[preset('Prusa', 'PETG', 'Grey')]} onOpen={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Add a colour with these settings' })).not.toBeInTheDocument();
  });
});
