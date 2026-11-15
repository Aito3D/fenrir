import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TreeNav } from '../../../components/filament-trees/TreeNav';
import type { FilamentTreeSummary, FilamentTreeTargets } from '../../../api/client';

const targets: FilamentTreeTargets = { machines: ['X2D', 'H2S'], nozzles: ['0.2', '0.4', '0.6'] };

function tree(overrides: Partial<FilamentTreeSummary> = {}): FilamentTreeSummary {
  return {
    id: 1,
    name: 'Polymaker PETG',
    brand: 'Polymaker',
    material: 'PETG',
    skip_02: null,
    abrasive: false,
    source: { machine: 'X2D', nozzle: '0.4', color_id: 10 },
    colors: [
      { id: 10, name: 'White', hex: '#ffffff' },
      { id: 11, name: 'Red', hex: '#dd3333' },
    ],
    own_counts: { root: 5, H2S: 1, 'H2S/0.6': 2, 'H2S/0.6/11': 3, 'color:11': 4 },
    ...overrides,
  };
}

const toggle = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Show or hide ${name}` }));

describe('TreeNav', () => {
  it('folds open level by level with aria-expanded', () => {
    render(<TreeNav trees={[tree()]} targets={targets} selected={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'H2S' })).toBeNull();
    const fold = screen.getByRole('button', { name: 'Show or hide Polymaker PETG' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'H2S' })).toBeInTheDocument();
    toggle('H2S');
    toggle('H2S › 0.6');
    expect(screen.getAllByRole('button', { name: /Red/ }).length).toBeGreaterThan(0);
  });

  it('shows own-value count badges', () => {
    render(<TreeNav trees={[tree()]} targets={targets} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByLabelText('5 own values')).toHaveTextContent('5');
    toggle('Polymaker PETG');
    expect(screen.getByLabelText('1 own value')).toHaveTextContent('1');
    toggle('Colours — all machines');
    expect(screen.getByLabelText('4 own values')).toBeInTheDocument();
  });

  it('hides 0.2 for an abrasive tree', () => {
    render(
      <TreeNav
        trees={[tree({ name: 'SUNLU PA6-CF', material: 'PA6-CF', abrasive: true })]}
        targets={targets}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    toggle('SUNLU PA6-CF');
    toggle('X2D');
    expect(screen.queryByRole('button', { name: 'X2D › 0.2' })).toBeNull();
    expect(screen.getByRole('button', { name: 'X2D › 0.4' })).toBeInTheDocument();
  });

  it('shows 0.2 for a non-abrasive tree', () => {
    render(<TreeNav trees={[tree()]} targets={targets} selected={null} onSelect={vi.fn()} />);
    toggle('Polymaker PETG');
    toggle('X2D');
    expect(screen.getByRole('button', { name: 'X2D › 0.2' })).toBeInTheDocument();
  });

  it('selects a colour leaf and a colour-wide node', () => {
    const onSelect = vi.fn();
    render(<TreeNav trees={[tree()]} targets={targets} selected={null} onSelect={onSelect} />);
    toggle('Polymaker PETG');
    toggle('H2S');
    toggle('H2S › 0.6');
    fireEvent.click(screen.getByRole('button', { name: 'H2S › 0.6 › Red' }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 });
    toggle('Colours — all machines');
    fireEvent.click(screen.getByRole('button', { name: 'Red (all machines)' }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, colorId: 11 });
  });

  it('marks the calibration source and opens the selected path', () => {
    render(
      <TreeNav
        trees={[tree()]}
        targets={targets}
        selected={{ treeId: 1, machine: 'X2D', nozzle: '0.4', colorId: 10 }}
        onSelect={vi.fn()}
      />,
    );
    const leaf = screen.getByRole('button', { name: 'X2D › 0.4 › White' });
    expect(leaf).toHaveAttribute('aria-current', 'true');
    expect(screen.getAllByLabelText('Calibration source').length).toBeGreaterThan(0);
  });
});
