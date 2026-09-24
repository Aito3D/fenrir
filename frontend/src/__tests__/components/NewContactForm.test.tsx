import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { api } from '../../api/client';
import { NewContactForm } from '../../components/aito/NewContactForm';

const created = {
  id: 'n1', name: 'Jean-Pierre DUPONT', company_name: '',
  customer_sub_type: 'individual',
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

  it('keeps the name fields enabled while a company name is present: they become the contact person', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.queryByText(/contact person at the company/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/company name/i), 'ACME');
    expect(screen.getByLabelText(/first name/i)).toBeEnabled();
    expect(screen.getByLabelText(/last name/i)).toBeEnabled();
    expect(screen.getByText(/contact person at the company/i)).toBeInTheDocument();

    await user.clear(screen.getByLabelText(/company name/i));
    expect(screen.queryByText(/contact person at the company/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/first name/i), 'Paul');
    expect(screen.getByLabelText(/company name/i)).toBeEnabled();
  });

  it('sends the person as the company contact when both are filled', async () => {
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
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/first name/i), 'teva');
    await user.type(screen.getByLabelText(/last name/i), 'temarii');
    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(body).toMatchObject({
      company_name: 'ACME SARL',
      first_name: 'Teva',
      last_name: 'TEMARII',
      phone: '+689-87123456',
    });
  });

  it('accepts a company contact with only a first name', async () => {
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
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/first name/i), 'Teva');
    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    expect(screen.getByRole('button', { name: /create client/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(body).toMatchObject({ company_name: 'ACME SARL', first_name: 'Teva', last_name: '' });
  });

  it('previews the company with its contact person', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    expect(screen.getByText(/ACME SARL · no contact person yet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/first name/i), 'teva');
    await user.type(screen.getByLabelText(/last name/i), 'temarii');
    await user.tab();
    expect(screen.getByText(/ACME SARL · contact: Teva TEMARII/)).toBeInTheDocument();
  });

  it('hides the social chooser for a company and does not count a handle typed before it', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'acme.3d');

    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    expect(screen.queryByRole('radio', { name: 'Instagram' })).not.toBeInTheDocument();
    // The handle alone no longer reaches anyone: a company needs a phone or an email.
    expect(screen.getByText(/phone number or an email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();

    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, { network: null, handle: '' }));
  });

  it('brings the social chooser back, handle intact, when the company name is cleared', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'acme.3d');
    await user.type(screen.getByLabelText(/company name/i), 'ACME');
    await user.clear(screen.getByLabelText(/company name/i));
    expect(screen.getByRole('radio', { name: 'Instagram' })).toBeChecked();
    expect(screen.getByLabelText(/username/i)).toHaveValue('acme.3d');
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
    // No social network picked here, so the second argument carries the null/empty pair.
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created, { network: null, handle: '' }));
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
    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    await user.click(screen.getByRole('button', { name: /create client/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('blocks submission until a name is present', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
  });

  it('shows an email error only after the field is left', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();

    await user.clear(screen.getByLabelText(/^email/i));
    await user.type(screen.getByLabelText(/^email/i), 'hi@acme.pf');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The phone is empty, but an email alone makes the client reachable.
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

  it('blocks submission when the client has neither a phone nor an email', async () => {
    let called = false;
    server.use(
      http.post('/api/v1/zoho/contacts', () => {
        called = true;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');

    // The phone alone is not required, but some way to reach the client is —
    // the same rule the drawer and the backend enforce. For a company the
    // social handle is off the table, so the hint names the two that count.
    expect(screen.getByText(/phone number or an email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /create client/i }));
    expect(called).toBe(false);
  });

  it('accepts the submission with an email and no phone', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    await user.type(screen.getByLabelText(/^email/i), 'hi@acme.pf');
    expect(screen.queryByText(/needs a phone or an email/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /create client/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  // The social channel belongs to an individual: a company's people are its
  // contact list, so these three walk the individual path.
  it('enables submit for a client reachable only on a social network', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/first name/i), 'Moana');
    await user.type(screen.getByLabelText(/last name/i), 'Teiki');
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'aito.3d');

    expect(screen.getByRole('button', { name: /create client/i })).toBeEnabled();
  });

  it('hands the typed handle back alongside the created contact', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/first name/i), 'Moana');
    await user.type(screen.getByLabelText(/last name/i), 'Teiki');
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'aito.3d');
    await user.click(screen.getByRole('button', { name: /create client/i }));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(created, { network: 'instagram', handle: 'aito.3d' }),
    );
  });

  it('does not send the handle to Zoho', async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, 'createZohoContact');
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/first name/i), 'Moana');
    await user.type(screen.getByLabelText(/last name/i), 'Teiki');
    await user.click(screen.getByRole('radio', { name: 'Instagram' }));
    await user.type(screen.getByLabelText(/username/i), 'aito.3d');
    await user.click(screen.getByRole('button', { name: /create client/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(JSON.stringify(spy.mock.calls[0][0])).not.toContain('aito.3d');
  });

  it('does not mark the phone field as required', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/^phone/i)).not.toHaveAttribute('aria-required');
  });

  it('rejects a non-digit phone submitted via Enter and never calls the API', async () => {
    const onCreated = vi.fn();
    let called = false;
    server.use(
      http.post('/api/v1/zoho/contacts', () => {
        called = true;
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={onCreated} />);
    await user.type(screen.getByLabelText(/company name/i), 'ACME SARL');
    // Typing a non-digit value like "n/a" leaves the phone field non-empty by
    // `.trim()` but empty once stripped to digits, so the client counts as
    // having no phone (and no email) at all. Enter submits the form
    // implicitly without blurring the field, which is exactly the path a
    // mouse click on the button does not take.
    await user.type(screen.getByLabelText(/^phone/i), 'n/a');
    await user.keyboard('{Enter}');
    expect(screen.getByText(/phone number or an email/i)).toBeInTheDocument();
    expect(called).toBe(false);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('disables submission with only a first name and explains why', async () => {
    const user = userEvent.setup();
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/first name/i), 'Paul');
    await user.type(screen.getByLabelText(/^phone/i), '87123456');
    await user.tab();
    expect(screen.getByRole('button', { name: /create client/i })).toBeDisabled();
    expect(screen.getByText(/enter a company name, or a first and last name/i)).toBeInTheDocument();
  });

  it('disables browser autocomplete on the new-client inputs', () => {
    render(<NewContactForm onCancel={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/company name/i)).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText(/first name/i)).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText(/last name/i)).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText(/^email/i)).toHaveAttribute('autocomplete', 'new-password');
  });
});
