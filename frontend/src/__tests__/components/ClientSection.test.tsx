import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientSection } from '../../components/aito/ClientSection';
import { defaultClientDraft, draftFromContact } from '../../utils/clientDraft';

const DEFAULT_ID = '66407000001237340';
const DEFAULT_NAME = 'Client de passage';

const acme = {
  id: 'z1', name: 'ACME SARL', company_name: 'ACME',
  phone: '', mobile: '89645864', email: 'hi@acme.pf',
};

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: DEFAULT_NAME,
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([acme])),
  );
});

const renderSection = (value = defaultClientDraft(DEFAULT_ID, DEFAULT_NAME), onChange = vi.fn()) => {
  render(
    <ClientSection
      value={value}
      onChange={onChange}
      onCreateNew={vi.fn()}
      defaultContactId={DEFAULT_ID}
      defaultContactName={DEFAULT_NAME}
    />,
  );
  return onChange;
};

describe('ClientSection', () => {
  it('shows the default client with empty phone and email', () => {
    renderSection();
    expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue(DEFAULT_NAME);
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('');
    expect(screen.getByLabelText(/^email/i)).toHaveValue('');
  });

  it('does not mark an untouched parsed phone as dirty', () => {
    renderSection(draftFromContact(acme, DEFAULT_ID));
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('89645864');
    expect(screen.getByRole('button', { name: /revert phone/i })).toHaveClass('opacity-0');
  });

  it('marks the phone touched once edited and reverts on the reset control', async () => {
    let draft = draftFromContact(acme, DEFAULT_ID);
    const onChange = vi.fn((next) => {
      draft = next;
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <ClientSection
        value={draft}
        onChange={onChange}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
      />,
    );
    await user.type(screen.getByLabelText(/^phone/i), '9');
    expect(onChange).toHaveBeenCalled();
    expect(draft.touched.phone).toBe(true);

    rerender(
      <ClientSection
        value={draft}
        onChange={onChange}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
      />,
    );
    await user.click(screen.getByRole('button', { name: /revert phone/i }));
    expect(draft.touched.phone).toBe(false);
    expect(draft.blurred.phone).toBe(false);
    expect(draft.nationalNumber).toBe('89645864');
  });

  it('stays quiet while an email is being typed, then errors on blur', async () => {
    // ClientSection is controlled, so the test plays the parent: every onChange
    // is fed straight back in as the new value.
    let draft = defaultClientDraft(DEFAULT_ID, DEFAULT_NAME);
    const section = (value: typeof draft) => (
      <ClientSection
        value={value}
        onChange={(next) => {
          draft = next;
          rerender(section(next));
        }}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
      />
    );
    const user = userEvent.setup();
    const { rerender } = render(section(draft));

    await user.type(screen.getByLabelText(/^email/i), 'cli');
    expect(draft.email).toBe('cli');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(screen.getByLabelText(/^email/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the email error live once the value becomes valid', () => {
    const draft = {
      ...defaultClientDraft(DEFAULT_ID, DEFAULT_NAME),
      email: 'client@example.pf',
      touched: { phone: false, email: true },
      blurred: { phone: false, email: true },
    };
    renderSection(draft);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('errors on a too-short phone number once blurred', () => {
    const draft = {
      ...defaultClientDraft(DEFAULT_ID, DEFAULT_NAME),
      nationalNumber: '12',
      touched: { phone: true, email: false },
      blurred: { phone: true, email: false },
    };
    renderSection(draft);
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
  });

  it('resets the whole draft to the default client', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderSection(draftFromContact(acme, DEFAULT_ID), onChange);
    await user.click(screen.getByRole('button', { name: /default client/i }));
    expect(onChange).toHaveBeenCalledWith(defaultClientDraft(DEFAULT_ID, DEFAULT_NAME));
  });

  it('replaces the whole block with a settings link when Zoho is not configured', async () => {
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: false, reachable: false,
          default_contact_id: DEFAULT_ID, default_contact_name: DEFAULT_NAME,
        }),
      ),
    );
    renderSection();
    await waitFor(() => expect(screen.queryByLabelText(/^phone/i)).not.toBeInTheDocument());
    expect(screen.getByRole('link')).toHaveAttribute('href', '/settings?tab=zoho');
  });
});
