import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { IslandCombobox } from '../../components/aito/IslandCombobox';
import type { AitoShippingService } from '../../api/client';

const SERVICES: AitoShippingService[] = [
  {
    key: 'tuamotu',
    name: 'Livraison Avion Tuamotu',
    rate: 3200,
    islands: [
      { key: 'rangiroa', label: 'Rangiroa' },
      { key: 'tikehau', label: 'Tikehau' },
    ],
  },
  {
    key: 'australes',
    name: 'Livraison Avion Australes',
    rate: 4100,
    islands: [{ key: 'rurutu', label: 'Rurutu' }],
  },
];

describe('IslandCombobox', () => {
  it('lists islands under their service heading', async () => {
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('Livraison Avion Tuamotu')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Rangiroa' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Rurutu' })).toBeInTheDocument();
  });

  it('filters as you type, across every service', async () => {
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByRole('combobox'), 'ru');
    expect(screen.getByRole('option', { name: 'Rurutu' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Tikehau' })).not.toBeInTheDocument();
  });

  it('reports the island key on pick, not the label', async () => {
    const onSelect = vi.fn();
    render(<IslandCombobox value="" services={SERVICES} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Rangiroa' }));
    expect(onSelect).toHaveBeenCalledWith('rangiroa');
  });

  it('shows the chosen island when closed', () => {
    render(<IslandCombobox value="rangiroa" services={SERVICES} onSelect={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('Rangiroa');
  });

  it('says so when nothing matches', async () => {
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText('No island found')).toBeInTheDocument();
  });
});
