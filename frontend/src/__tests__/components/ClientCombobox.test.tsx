import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientCombobox } from '../../components/aito/ClientCombobox';

const contacts = [
  { id: 'z1', name: 'ACME SARL', company_name: 'ACME', phone: '', mobile: '+33 6 12 34 56 78', email: '' },
  { id: 'z2', name: 'Acmé Industrie', company_name: '', phone: '01 23 45 67 89', mobile: '', email: '' },
];

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: true, reachable: true })),
    http.get('/api/v1/zoho/contacts', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      return HttpResponse.json(contacts.filter(c => c.name.toLowerCase().includes(q.toLowerCase())));
    }),
  );
});

describe('ClientCombobox', () => {
  it('searches after 2+ chars and selects a client with phone fallback', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox value={null} onChange={onChange} />);
    await user.type(screen.getByRole('textbox'), 'acm');
    const option = await screen.findByText('ACME SARL');
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({ id: 'z1', name: 'ACME SARL', phone: '+33 6 12 34 56 78' });
  });

  it('shows a chip with an unselect button when a client is chosen', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ClientCombobox value={{ id: 'z1', name: 'ACME SARL', phone: '+33 6 12 34 56 78' }} onChange={onChange} />);
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /remove|retirer|clear/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders a settings link instead of the input when Zoho is not configured', async () => {
    server.use(http.get('/api/v1/zoho/status', () => HttpResponse.json({ configured: false, reachable: false })));
    render(<ClientCombobox value={null} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings?tab=zoho');
  });
});
