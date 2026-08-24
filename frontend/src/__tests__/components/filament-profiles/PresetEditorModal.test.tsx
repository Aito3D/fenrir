/**
 * Tests for PresetEditorModal (Task 12: shell + General tab):
 * - Create mode starts with the default compatible-printers tags and a
 *   disabled Save until a computed name exists.
 * - Picking Brand/Material/Color drives the computed name into both the
 *   header title and the footer filename, and enables Save.
 * - Selecting a base preset resolves its content and merges it onto the
 *   current (still-empty) fields.
 * - The PA K field writes the derived start G-code into the save payload.
 * - Changing nozzle size rewrites only the four quick-add printer tags.
 * - TagInput's Enter/Backspace/blur/× behavior (exercised standalone).
 * - Edit mode exposes Delete and the save payload carries the full
 *   FilamentPresetPayload shape.
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PresetEditorModal } from '../../../components/filament-profiles/PresetEditorModal';
import { TagInput } from '../../../components/filament-profiles/TagInput';
import { api } from '../../../api/client';
import type { BaseFilamentPreset, FilamentPreset } from '../../../api/client';

vi.mock('../../../api/client', () => ({
  api: {
    getBaseFilamentPresetContent: vi.fn(),
  },
}));

const getBaseContent = vi.mocked(api.getBaseFilamentPresetContent);

beforeEach(() => {
  getBaseContent.mockReset();
  getBaseContent.mockResolvedValue({ content: '{}' });
});

function editPreset(overrides: Partial<FilamentPreset> = {}): FilamentPreset {
  return {
    id: 5,
    name: 'SUNLU PETG - Magenta',
    brand: 'SUNLU',
    material: 'PETG',
    color: 'Magenta',
    color_hex: '#ff00ff',
    filename: 'sunlu_petg_magenta.json',
    content: JSON.stringify({
      filament_vendor: ['SUNLU'],
      filament_type: ['PETG'],
      default_filament_colour: ['#ff00ff'],
    }),
    ...overrides,
  };
}

describe('PresetEditorModal — create mode', () => {
  it('prefills the default compatible printers, shows the new-preset title, and disables Save', () => {
    render(
      <PresetEditorModal
        preset={null}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'New preset' })).toBeInTheDocument();
    for (const model of ['H2S', 'H2D', 'H2C', 'X2D']) {
      expect(screen.getByRole('button', { name: `Remove Bambu Lab ${model} 0.4 nozzle` })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Brand' })).toHaveFocus();
  });

  it('updates the title and filename as vendor/material/color are picked, and enables Save', async () => {
    const user = userEvent.setup();
    render(
      <PresetEditorModal
        preset={null}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Brand' }));
    await user.click(screen.getByRole('option', { name: 'SUNLU' }));

    await user.click(screen.getByRole('combobox', { name: 'Material' }));
    await user.click(screen.getByRole('option', { name: 'PETG' }));

    await user.type(screen.getByRole('textbox', { name: 'Color label' }), 'Magenta');

    expect(await screen.findByRole('heading', { name: 'SUNLU PETG - Magenta' })).toBeInTheDocument();
    expect(screen.getByText('SUNLU PETG - Magenta.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('resolves a picked base preset and merges its values onto empty fields', async () => {
    getBaseContent.mockResolvedValue({ content: JSON.stringify({ filament_cost: ['24.99'] }) });
    const basePresets: BaseFilamentPreset[] = [
      {
        id: 1,
        name: 'Bambu PETG Base',
        inherits: '',
        brand: 'Bambu Lab',
        material: 'PETG',
        color: '',
        color_hex: '',
        filename: 'bambu_petg_base.json',
      },
    ];
    const user = userEvent.setup();
    render(
      <PresetEditorModal
        preset={null}
        presets={[]}
        basePresets={basePresets}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Base preset' }));
    await user.click(screen.getByRole('option', { name: 'Bambu PETG Base' }));

    await waitFor(() => expect(getBaseContent).toHaveBeenCalledWith('bambu_petg_base.json'));
    expect(await screen.findByText('↳ Bambu PETG Base')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: /Cost/ })).toHaveValue(24.99));
  });

  it('writes the PA K value into the generated start G-code on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    const paK = screen.getByRole('spinbutton', { name: /PA K value/ });
    await user.clear(paK);
    await user.type(paK, '0.024');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0];
    expect(payload.content).toContain('M900 K0.024');
  });

  it('rewrites only the four quick-add printer tags when nozzle size changes', async () => {
    const user = userEvent.setup();
    render(
      <PresetEditorModal
        preset={null}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    // A non-matching custom tag must survive the rewrite untouched.
    const tagInput = screen.getByRole('textbox', { name: 'Bambu Lab X1C 0.4 nozzle…' });
    await user.click(tagInput);
    await user.type(tagInput, 'Custom Printer 0.4 nozzle{Enter}');

    await user.click(screen.getByRole('button', { name: '0.6' }));

    for (const model of ['H2S', 'H2D', 'H2C', 'X2D']) {
      expect(screen.getByRole('button', { name: `Remove Bambu Lab ${model} 0.6 nozzle` })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: `Remove Bambu Lab ${model} 0.4 nozzle` })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Remove Custom Printer 0.4 nozzle' })).toBeInTheDocument();
  });
});

describe('PresetEditorModal — edit mode', () => {
  it('shows Delete and calls onDelete (after requesting close)', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('saves the full FilamentPresetPayload shape', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'SUNLU PETG - Magenta',
      brand: 'SUNLU',
      material: 'PETG',
      color: 'Magenta',
      color_hex: '#ff00ff',
      filename: 'SUNLU PETG - Magenta.json',
    });
    expect(typeof payload.content).toBe('string');
  });

  it('never saves the empty rawJson placeholder when the JSON tab is active', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'JSON' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0][0];
    expect(payload.content).not.toBe('');
    // Falls back to the same generated content the General tab would save.
    expect(JSON.parse(payload.content)).toMatchObject({ name: 'SUNLU PETG - Magenta' });
  });

  it('does not dismiss while a save is in-flight', async () => {
    const user = userEvent.setup();
    let resolveSave: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onClose = vi.fn();
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    resolveSave();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled());
  });
});

describe('TagInput', () => {
  function Wrapper({ initial = '' }: { initial?: string }) {
    const [value, setValue] = useState(initial);
    return <TagInput value={value} onChange={setValue} placeholder="Add a tag…" />;
  }

  it('adds a trimmed tag on Enter and ignores a duplicate', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial="Alpha" />);

    const input = screen.getByRole('textbox');
    await user.type(input, '  Beta  {Enter}');
    expect(screen.getByRole('button', { name: 'Remove Beta' })).toBeInTheDocument();

    await user.type(input, 'Alpha{Enter}');
    expect(screen.getAllByRole('button', { name: 'Remove Alpha' })).toHaveLength(1);
  });

  it('removes the last tag on Backspace when the draft is empty', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial="Alpha, Beta" />);

    const input = screen.getByRole('textbox');
    await user.click(input);
    await user.keyboard('{Backspace}');

    expect(screen.queryByRole('button', { name: 'Remove Beta' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Alpha' })).toBeInTheDocument();
  });

  it('commits the draft on blur and removes a specific tag via its × button', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial="Alpha" />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'Gamma');
    await user.tab();

    expect(screen.getByRole('button', { name: 'Remove Gamma' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Alpha' }));
    expect(screen.queryByRole('button', { name: 'Remove Alpha' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Gamma' })).toBeInTheDocument();
  });
});

describe('PresetEditorModal — parameter tabs (Task 13)', () => {
  it('binds a bed-plate cell to its field and saves it', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Temperatures' }));
    const hotPlatePrint = screen.getByRole('spinbutton', { name: 'Hot Plate Print °C' });
    await user.type(hotPlatePrint, '60');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onSave.mock.calls[0][0].content).hot_plate_temp).toEqual(['60']);
  });

  it('writes tri-state On/nil into enable_overhang_bridge_fan', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cooling' }));
    await user.click(screen.getByRole('button', { name: 'Overhang / bridge fan: On' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onSave.mock.calls[0][0].content).enable_overhang_bridge_fan).toEqual(['1']);

    await user.click(screen.getByRole('button', { name: 'Overhang / bridge fan: nil' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(JSON.parse(onSave.mock.calls[1][0].content)).not.toHaveProperty('enable_overhang_bridge_fan');
  });

  it('disambiguates Retract tri-state rows by accessible name and saves the toggled value', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Retraction' }));
    // Retract has two tri-state rows (retractOnLayerChange, wipeOnRetract);
    // a bare "On" would be ambiguous between them.
    expect(screen.queryByRole('button', { name: 'On' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wipe on retraction: On' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onSave.mock.calls[0][0].content).filament_wipe).toEqual(['1']);
  });

  it('applies the cal popover percentage on Enter, and Escape closes without applying', async () => {
    const user = userEvent.setup();
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Extrusion' }));
    const flowRatio = screen.getByRole('spinbutton', { name: 'Flow ratio' });
    await user.clear(flowRatio);
    await user.type(flowRatio, '1.0');

    await user.click(screen.getByRole('button', { name: 'cal' }));
    const pctInput = screen.getByRole('spinbutton', { name: 'Adjust flow ratio by %' });
    await user.type(pctInput, '2{Enter}');

    expect(flowRatio).toHaveValue(1.02);
    expect(screen.queryByRole('spinbutton', { name: 'Adjust flow ratio by %' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'cal' }));
    const pctInput2 = screen.getByRole('spinbutton', { name: 'Adjust flow ratio by %' });
    await user.type(pctInput2, '50{Escape}');

    expect(screen.queryByRole('spinbutton', { name: 'Adjust flow ratio by %' })).not.toBeInTheDocument();
    expect(flowRatio).toHaveValue(1.02);
  });

  it('re-derives PA K from an edited start G-code', async () => {
    const user = userEvent.setup();
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={vi.fn()}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Extrusion' }));
    const startGcode = screen.getByRole('textbox', { name: 'Start G-code' });
    await user.clear(startGcode);
    await user.type(startGcode, 'M900 L1000 M10{Enter}M900 K0.05');

    await user.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByRole('spinbutton', { name: /PA K value/ })).toHaveValue(0.05);
  });

  it('writes the selected z-hop type into filament_z_hop_types on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PresetEditorModal
        preset={editPreset()}
        presets={[]}
        basePresets={[]}
        extraMaterials={[]}
        onSave={onSave}
        onDelete={null}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Retraction' }));
    await user.click(screen.getByRole('button', { name: 'Slope Lift' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onSave.mock.calls[0][0].content).filament_z_hop_types).toEqual(['Slope Lift']);
  });
});
