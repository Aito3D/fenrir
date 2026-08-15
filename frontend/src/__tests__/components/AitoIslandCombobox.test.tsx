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

  // ALSO FIX 8: before the services query resolves, `value` may already be
  // set (e.g. the panel's edit mode seeding from the project) while
  // `services` is still `[]`. The old '' fallback rendered this required
  // field blank with no error shown; it must instead show a readable
  // degrade, same as every other surface `islandLabel` backs.
  it('degrades to a readable label instead of blank while services has not resolved', () => {
    render(<IslandCombobox value="bora-bora" services={[]} onSelect={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('Bora Bora');
  });

  it('says so when nothing matches', async () => {
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText('No island found')).toBeInTheDocument();
  });

  // Islands render as one flat, navigable sequence (see the component's own
  // comment): the group headings are not stops, so ArrowDown/ArrowUp must
  // walk straight across the Tuamotu/Australes boundary.
  it('moves the highlight down through the flattened list and wraps past the group boundary', async () => {
    const user = userEvent.setup();
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Rangiroa', 'Tikehau', 'Rurutu']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);

    await user.keyboard('{ArrowDown}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);

    await user.keyboard('{ArrowDown}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);

    await user.keyboard('{ArrowDown}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);

    // Wraps back to the first entry past the last one, across services.
    await user.keyboard('{ArrowDown}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
  });

  it('moves the highlight up through the flattened list, wrapping to the last from the top', async () => {
    const user = userEvent.setup();
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option');

    // From no selection, up goes to the last entry.
    await user.keyboard('{ArrowUp}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);

    await user.keyboard('{ArrowUp}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);

    await user.keyboard('{ArrowUp}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);

    // Wraps back to the last entry past the first one.
    await user.keyboard('{ArrowUp}');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
  });

  it('picks the highlighted island by key (not its label) on Enter and closes the list', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<IslandCombobox value="" services={SERVICES} onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox'));

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledWith('tikehau');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does nothing on Enter when nothing is highlighted', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<IslandCombobox value="" services={SERVICES} onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox'));

    await user.keyboard('{Enter}');

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('closes the list on Escape without picking an island, reverting the input', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<IslandCombobox value="rangiroa" services={SERVICES} onSelect={onSelect} />);
    await user.click(screen.getByRole('combobox'));

    await user.keyboard('{ArrowDown}{Escape}');

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('Rangiroa');
  });

  it('ignores ArrowDown/ArrowUp when the filtered list is empty', async () => {
    const user = userEvent.setup();
    render(<IslandCombobox value="" services={SERVICES} onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'zzz');

    await user.keyboard('{ArrowDown}{ArrowUp}');

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No island found')).toBeInTheDocument();
  });
});
