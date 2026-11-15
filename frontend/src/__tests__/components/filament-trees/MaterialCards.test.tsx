import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaterialCards } from '../../../components/filament-trees/MaterialCards';
import type { NodeRef } from '../../../components/filament-trees/NodePanel';
import { api } from '../../../api/client';
import type { FilamentTreeSummary, FilamentTreeTargets } from '../../../api/client';

const targets: FilamentTreeTargets = { machines: ['X2D', 'H2S'], nozzles: ['0.2', '0.4', '0.6'] };

function tree(overrides: Partial<FilamentTreeSummary>): FilamentTreeSummary {
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

const TREES = [
  tree({}),
  tree({ id: 2, name: 'SUNLU PETG', brand: 'SUNLU', colors: [{ id: 20, name: 'Black', hex: '#000000' }], own_counts: {} }),
  tree({ id: 3, name: 'SUNLU PLA', brand: 'SUNLU', material: 'PLA', colors: [{ id: 30, name: 'Green', hex: '#00ff00' }], own_counts: {} }),
];

/** Holds the page's level state: one machine/nozzle picker for every card. */
function Harness({ trees, onSelect }: { trees: FilamentTreeSummary[]; onSelect: (node: NodeRef) => void }) {
  const [level, setLevel] = useState({ machine: '', nozzle: '' });
  return (
    <MaterialCards
      trees={trees}
      targets={targets}
      selected={null}
      onSelect={onSelect}
      machine={level.machine}
      nozzle={level.nozzle}
      onLevel={(machine, nozzle) => setLevel({ machine, nozzle })}
    />
  );
}

function renderCards(trees = TREES, onSelect = vi.fn()) {
  vi.spyOn(api, 'getFilamentTreeNode').mockImplementation(async (_id, node = {}) => [
    { key: 'nozzle_temperature', value: [node.nozzle ? '250' : '240'], source: 'root', own: true },
    { key: 'filament_flow_ratio', value: ['0.95'], source: 'root', own: true },
    { key: 'filament_start_gcode', value: ['M900 K0.028'], source: 'root', own: true },
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = <Harness trees={trees} onSelect={onSelect} />;
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return onSelect;
}

/** The card whose header names the material. */
const card = (material: string) => screen.getByText(material, { selector: 'span.font-mono' }).closest('details') as HTMLElement;

afterEach(() => vi.restoreAllMocks());

describe('MaterialCards', () => {
  it('groups trees into one card per material with a colour count', () => {
    renderCards();
    const petg = card('PETG');
    expect(within(petg).getByRole('button', { name: 'Polymaker PETG' })).toBeInTheDocument();
    expect(within(petg).getByRole('button', { name: 'SUNLU PETG' })).toBeInTheDocument();
    expect(within(petg).getByText('3 colours')).toBeInTheDocument();
    expect(within(card('PLA')).getByRole('button', { name: 'SUNLU PLA' })).toBeInTheDocument();
    expect(within(card('PLA')).getByText('1 colour')).toBeInTheDocument();
  });

  it('filters by brand pill and by search', () => {
    renderCards();
    fireEvent.click(screen.getByRole('button', { name: 'Polymaker' }));
    expect(screen.queryByText('PLA', { selector: 'span.font-mono' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SUNLU PETG' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All brands' }));

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'red' } });
    expect(screen.getByRole('button', { name: /Red/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /White/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SUNLU PLA' })).not.toBeInTheDocument();
  });

  it('shows values from the node rows and the own-value badge for the level', async () => {
    renderCards();
    const petg = card('PETG');
    await waitFor(() => expect(within(petg).getAllByText('240°C')).toHaveLength(2));
    expect(within(petg).getAllByText('×0.95')).toHaveLength(2);
    expect(within(petg).getAllByText('PA 0.028')).toHaveLength(2);
    expect(within(petg).getByLabelText('5 own values')).toBeInTheDocument();
    expect(within(petg).getByLabelText('4 own values')).toBeInTheDocument(); // color:11 on Red
  });

  it('reveals the nozzle picker after a machine and maps every click to its node', async () => {
    const onSelect = renderCards();
    const petg = within(card('PETG'));
    expect(screen.queryByRole('group', { name: 'Nozzle' })).not.toBeInTheDocument();

    fireEvent.click(petg.getByRole('button', { name: 'Polymaker PETG' }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, machine: undefined, nozzle: undefined });
    fireEvent.click(petg.getByRole('button', { name: /Red/ }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, colorId: 11 });

    fireEvent.click(within(screen.getByRole('group', { name: 'Printer' })).getByRole('button', { name: 'H2S' }));
    fireEvent.click(petg.getByRole('button', { name: 'Polymaker PETG' }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, machine: 'H2S', nozzle: undefined });
    const red = petg.getByRole('button', { name: /Red/ });
    expect(red).toBeDisabled();
    expect(red).toHaveAttribute('title', 'Pick a nozzle to open this colour');

    fireEvent.click(within(screen.getByRole('group', { name: 'Nozzle' })).getByRole('button', { name: '0.6' }));
    await waitFor(() => expect(petg.getAllByText('250°C')).toHaveLength(2));
    expect(petg.getAllByText('⌀0.6mm')).toHaveLength(2);
    expect(petg.getByLabelText('2 own values')).toBeInTheDocument();
    expect(petg.getByLabelText('3 own values')).toBeInTheDocument();
    fireEvent.click(petg.getByRole('button', { name: 'Polymaker PETG' }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, machine: 'H2S', nozzle: '0.6' });
    fireEvent.click(petg.getByRole('button', { name: /Red/ }));
    expect(onSelect).toHaveBeenLastCalledWith({ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 });
  });

  it('hides 0.2 when every tree skips it and blocks only the abrasive tree otherwise', () => {
    renderCards([tree({ abrasive: true }), tree({ id: 2, name: 'SUNLU PETG', brand: 'SUNLU', own_counts: {} })]);
    const petg = within(card('PETG'));
    fireEvent.click(within(screen.getByRole('group', { name: 'Printer' })).getByRole('button', { name: 'X2D' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Nozzle' })).getByRole('button', { name: '0.2' }));
    expect(petg.getByRole('button', { name: 'Polymaker PETG' })).toBeDisabled();
    expect(petg.getByRole('button', { name: 'SUNLU PETG' })).toBeEnabled();
    expect(petg.getByText('No 0.2 nozzle for this filament')).toBeInTheDocument();
  });

  it('drops 0.2 from the nozzle picker when every filament is abrasive', () => {
    renderCards([tree({ abrasive: true })]);
    fireEvent.click(within(screen.getByRole('group', { name: 'Printer' })).getByRole('button', { name: 'X2D' }));
    expect(within(screen.getByRole('group', { name: 'Nozzle' })).queryByRole('button', { name: '0.2' })).not.toBeInTheDocument();
  });

  it('marks stock, changed-since-export filaments and colours past the 24 dots', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ id: 100 + i, name: `C${i}`, hex: '#111111', spools: i === 0 ? 3 : 0, price: i === 0 ? 19.9 : null }));
    renderCards([tree({ colors: many, export_pending: 4 })]);
    const petg = within(card('PETG'));
    expect(petg.getByLabelText('3 spools in stock')).toHaveTextContent('×3');
    expect(petg.getByRole('button', { name: /C0/ })).toHaveAttribute('title', '19.9/kg');
    expect(petg.getByLabelText('4 profiles changed since the last export')).toBeInTheDocument();
    expect(petg.getByText('+2')).toBeInTheDocument();
  });
});
