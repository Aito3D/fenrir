import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientCombobox } from '../../components/aito/ClientCombobox';

const contacts = [
  {
    id: 'z1',
    name: 'ACME SARL',
    company_name: 'ACME',
    customer_sub_type: 'business',
    phone: '',
    mobile: '89645864',
    email: 'hi@acme.pf',
  },
  {
    id: 'z2',
    name: 'Acmé Industrie',
    company_name: '',
    customer_sub_type: 'business',
    phone: '40864225',
    mobile: '',
    email: '',
  },
];

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/contacts', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      return HttpResponse.json(contacts.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())));
    }),
  );
});

const props = {
  clientName: 'Client de passage',
  onSelect: vi.fn(),
  onCreateNew: vi.fn(),
  onReset: vi.fn(),
  showReset: false,
};

describe('ClientCombobox', () => {
  it('shows the current client name in the input', () => {
    render(<ClientCombobox {...props} />);
    expect(screen.getByRole('combobox')).toHaveValue('Client de passage');
  });

  it('searches on typing and reports the picked contact', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox {...props} onSelect={onSelect} />);
    await user.clear(screen.getByRole('combobox'));
    await user.type(screen.getByRole('combobox'), 'acm');
    await user.click(await screen.findByText('ACME SARL'));
    expect(onSelect).toHaveBeenCalledWith(contacts[0]);
  });

  it('reverts the text to the current client when blurred without picking', async () => {
    const user = userEvent.setup();
    render(<ClientCombobox {...props} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'nonsense');
    await user.tab();
    expect(input).toHaveValue('Client de passage');
  });

  it('offers the create footer even when there are no results', async () => {
    const onCreateNew = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox {...props} onCreateNew={onCreateNew} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    expect(onCreateNew).toHaveBeenCalledWith();
  });

  it('disables browser autocomplete on the search input', () => {
    render(<ClientCombobox {...props} />);
    expect(screen.getByRole('combobox')).toHaveAttribute('autocomplete', 'new-password');
  });

  it('hides the reset control unless showReset is set', async () => {
    const onReset = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ClientCombobox {...props} />);
    expect(screen.getByRole('button', { name: /default client/i })).toHaveClass('opacity-0');
    rerender(<ClientCombobox {...props} showReset onReset={onReset} />);
    await user.click(screen.getByRole('button', { name: /default client/i }));
    expect(onReset).toHaveBeenCalled();
  });

  it('moves the highlight down through the results and wraps back to the first', async () => {
    const user = userEvent.setup();
    render(<ClientCombobox {...props} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'acm');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false']);

    await user.keyboard('{ArrowDown}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');

    await user.keyboard('{ArrowDown}');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    // Wraps back to the first result past the last one.
    await user.keyboard('{ArrowDown}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('moves the highlight up through the results, wrapping to the last from the top', async () => {
    const user = userEvent.setup();
    render(<ClientCombobox {...props} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'acm');
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);

    // From no selection, up goes to the last result.
    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'false');

    // Wraps back to the last result past the first one.
    await user.keyboard('{ArrowUp}');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('picks the highlighted contact on Enter and closes the list', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox {...props} onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'acm');
    await screen.findAllByRole('option');

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onSelect).toHaveBeenCalledWith(contacts[1]);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Client de passage');
  });

  it('closes the list on Escape without picking a contact', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox {...props} onSelect={onSelect} />);
    const input = screen.getByRole('combobox');
    await user.clear(input);
    await user.type(input, 'acm');
    await screen.findAllByRole('option');

    await user.keyboard('{ArrowDown}{Escape}');

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveValue('Client de passage');
  });
});
