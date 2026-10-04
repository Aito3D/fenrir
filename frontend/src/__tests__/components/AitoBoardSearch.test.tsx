import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { BoardSearch } from '../../components/aito/BoardSearch';
import { AitoSearchContext, type TrashSearchState } from '../../components/aito/search/AitoSearchContext';
import { searchProjects } from '../../utils/aitoSearch';
import { makeProject } from '../fixtures/aitoProject';

const projects = [
  makeProject({ id: 1, description: 'Support GoPro', client_name: 'Dupont', client_phone: '87 12 34 56', client_email: null }),
  // makeProject defaults every card to the same phone and email; null them
  // so a phone query matches only card 1.
  makeProject({ id: 2, description: 'Plaque laiton', client_name: 'Teva', column: 'done', client_phone: null, client_email: null }),
  makeProject({ id: 3, description: 'Trophée', client_name: 'Dupuis', status: 'deleted', client_phone: null, client_email: null }),
];

function Harness({ onSelect = vi.fn(), trash = 'ready' as TrashSearchState, rows = projects }) {
  const [value, setValue] = useState('');
  return (
    <AitoSearchContext.Provider value={{ hits: searchProjects(rows, value), trash, onSelect }}>
      <BoardSearch value={value} onChange={setValue} />
      <span data-testid="value">{value}</span>
    </AitoSearchContext.Provider>
  );
}

describe('BoardSearch combobox', () => {
  it('stays a plain input without a provider', async () => {
    render(<BoardSearch value="dup" onChange={() => {}} />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens a ranked listbox with location and match chip', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole('combobox'), '87123456');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Support GoPro');
    expect(options[0]).toHaveTextContent('87 12 34 56');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'true');
  });

  it('labels Done and Trash results', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole('combobox'), 'du');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Trash')]),
    );
  });

  it('arrow keys move, Enter opens the highlighted card', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'dup');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[1].id);
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Enter with nothing highlighted opens the top result', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.type(screen.getByRole('combobox'), 'gopro{Enter}');
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('click on an option opens the card', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.type(screen.getByRole('combobox'), 'plaque');
    await userEvent.click(screen.getByRole('option'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('Escape closes, a second Escape clears, and neither bubbles', async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness />
      </div>,
    );
    const input = screen.getByRole('combobox');
    await userEvent.type(input, 'dup');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByTestId('value')).toHaveTextContent('dup');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('value')).toHaveTextContent('');
    expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Escape' }));
  });

  it('lets Escape bubble when there is nothing to close or clear', async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => outer(e.key)}>
        <Harness />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(outer).toHaveBeenCalledWith('Escape');
  });

  it('shows the no-results hint', async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole('combobox'), 'zzzz');
    expect(screen.getByText('No order matches')).toBeInTheDocument();
    expect(screen.getByText('Try phone digits, a quote or invoice number')).toBeInTheDocument();
  });

  it('shows board hits and a quiet line when trash failed', async () => {
    render(<Harness trash="error" />);
    await userEvent.type(screen.getByRole('combobox'), 'gopro');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('The trash could not be searched')).toBeInTheDocument();
  });

  it('shows a loading line while trash loads', async () => {
    render(<Harness trash="loading" />);
    await userEvent.type(screen.getByRole('combobox'), 'gopro');
    expect(screen.getByText('Searching the trash…')).toBeInTheDocument();
  });

  it('caps at 8 rows with a +N footer', async () => {
    const many = Array.from({ length: 11 }, (_, i) => makeProject({ id: i + 1, client_name: `Tane ${i}` }));
    render(<Harness rows={many} />);
    await userEvent.type(screen.getByRole('combobox'), 'tane');
    expect(screen.getAllByRole('option')).toHaveLength(8);
    expect(screen.getByText('+3 more matches')).toBeInTheDocument();
  });
});
