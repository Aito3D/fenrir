/**
 * Tests for PresetCard component:
 * - Renders brand, display material, chips, and nozzle pill from preset content
 * - Card click fires onOpen
 * - Menu button click stops propagation (no onOpen) and opens the menu
 * - Edit/Duplicate/Delete menu items fire their callbacks (not onOpen)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PresetCard } from '../../../components/filament-profiles/PresetCard';
import type { FilamentPreset } from '../../../api/client';

function makeContent(): string {
  return JSON.stringify({
    name: 'Bambu Lab PLA Basic - Black',
    nozzle_temperature: ['230'],
    filament_flow_ratio: ['0.98'],
    filament_start_gcode: ['M900 L1000 M10\nM900 K0.04'],
    compatible_printers: ['Bambu Lab X1C 0.4 nozzle'],
  });
}

function makePreset(overrides: Partial<FilamentPreset> = {}): FilamentPreset {
  return {
    id: 1,
    name: 'Bambu Lab PLA Basic - Black',
    brand: 'Bambu Lab',
    material: 'PLA',
    color: 'Black',
    color_hex: '#111111',
    filename: 'bambu-pla-basic-black.json',
    content: makeContent(),
    ...overrides,
  };
}

describe('PresetCard', () => {
  it('renders brand, display material, chips, and nozzle pill', () => {
    render(
      <PresetCard preset={makePreset()} onOpen={vi.fn()} onEdit={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />
    );

    expect(screen.getByText('Bambu Lab')).toBeDefined();
    expect(screen.getByText('PLA Basic')).toBeDefined();
    expect(screen.getByText('230°C')).toBeDefined();
    expect(screen.getByText('×0.98')).toBeDefined();
    expect(screen.getByText('PA 0.04')).toBeDefined();
    expect(screen.getByText('⌀0.4mm')).toBeDefined();
  });

  it('fires onOpen when the card is clicked', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(
      <PresetCard preset={makePreset()} onOpen={onOpen} onEdit={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />
    );

    await user.click(screen.getByText('PLA Basic'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens the menu on three-dot click without firing onOpen', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(
      <PresetCard preset={makePreset()} onOpen={onOpen} onEdit={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: /menu/i }));

    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Edit')).toBeDefined();
    expect(screen.getByText('Duplicate')).toBeDefined();
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('fires onEdit and closes the menu, without firing onOpen', async () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    const user = userEvent.setup();
    render(
      <PresetCard preset={makePreset()} onOpen={onOpen} onEdit={onEdit} onDuplicate={vi.fn()} onDelete={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: /menu/i }));
    await user.click(screen.getByText('Edit'));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('fires onDuplicate and closes the menu, without firing onOpen', async () => {
    const onOpen = vi.fn();
    const onDuplicate = vi.fn();
    const user = userEvent.setup();
    render(
      <PresetCard preset={makePreset()} onOpen={onOpen} onEdit={vi.fn()} onDuplicate={onDuplicate} onDelete={vi.fn()} />
    );

    await user.click(screen.getByRole('button', { name: /menu/i }));
    await user.click(screen.getByText('Duplicate'));

    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByText('Duplicate')).toBeNull();
  });

  it('fires onDelete and closes the menu, without firing onOpen', async () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <PresetCard preset={makePreset()} onOpen={onOpen} onEdit={vi.fn()} onDuplicate={vi.fn()} onDelete={onDelete} />
    );

    await user.click(screen.getByRole('button', { name: /menu/i }));
    await user.click(screen.getByText('Delete'));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete')).toBeNull();
  });
});
