import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientCombobox } from '../../components/aito/ClientCombobox';

const contacts = [
  { id: 'z1', name: 'ACME SARL', company_name: 'ACME', phone: '', mobile: '89645864', email: 'hi@acme.pf' },
  { id: 'z2', name: 'Acmé Industrie', company_name: '', phone: '40864225', mobile: '', email: '' },
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
});
