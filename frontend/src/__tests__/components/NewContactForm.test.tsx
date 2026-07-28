import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewContactForm } from '../../components/aito/NewContactForm';

const created = {
  id: 'n1', name: 'Jean-Pierre DUPONT', company_name: '',
  phone: '', mobile: '+689-87123456', email: '',
};

beforeEach(() => {
  server.use(http.post('/api/v1/zoho/contacts', () => HttpResponse.json(created, { status: 201 })));
});

describe('NewContactForm', () => {
  it('starts with an empty company field', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
  });

  it('disables the name fields while a company name is present, and vice versa', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME');
    expect(screen.getByLabelText(/first name/i)).toBeDisabled();
    expect(screen.getByLabelText(/last name/i)).toBeDisabled();

    await user.clear(screen.getByLabelText(/company name/i));
    await user.type(screen.getByLabelText(/first name/i), 'Paul');
    expect(screen.getByLabelText(/company name/i)).toBeDisabled();
  });

  it('previews the enforced display name on blur', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/first name/i), 'jean-pierre');
    await user.type(screen.getByLabelText(/last name/i), 'dupont');
    await user.tab();
    expect(await screen.findByText(/Jean-Pierre DUPONT/)).toBeInTheDocument();
  });

  it('submits the parts and reports the created contact', async () => {
    const onCreated = vi.fn();
    let body: unknown;
    server.use(
      http.post('/api/v1/zoho/contacts', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/first name/i), 'jean-pierre');
    await user.type(screen.getByLabelText(/last name/i), 'dupont');
    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(body).toMatchObject({
      first_name: 'Jean-Pierre',
      last_name: 'DUPONT',
      phone: '+689-87123456',
      company_name: '',
    });
  });

  it('shows the Zoho duplicate message inline', async () => {
    server.use(
      http.post('/api/v1/zoho/contacts', () =>
        HttpResponse.json({ detail: 'Contact name already exists.' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('blocks submission until a name is present', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
  });

  it('shows an email error only after the field is left, and disables submit', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);

    await user.clear(screen.getByLabelText(/^email/i));
    await user.type(screen.getByLabelText(/^email/i), 'hi@acme.pf');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create client/i })).toBeEnabled();
  });

  it('rejects a too-short phone number and never calls the API', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/^phone/i), '12');
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
