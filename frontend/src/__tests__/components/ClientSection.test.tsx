import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ClientSection } from '../../components/aito/ClientSection';
import { defaultClientDraft, draftFromContact } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import type { AitoShippingService } from '../../api/client';

const DEFAULT_ID = '66407000001237340';
const DEFAULT_NAME = 'Client de passage';

const acme = {
  id: 'z1', name: 'ACME SARL', company_name: 'ACME',
  customer_sub_type: 'business',
  phone: '', mobile: '89645864', email: 'hi@acme.pf',
};

// Same fixture as AitoShippingFields.test.tsx / AitoIslandCombobox.test.tsx.
const SHIPPING_SERVICES: AitoShippingService[] = [
  {
    key: 'tuamotu',
    name: 'Livraison Avion Tuamotu',
    rate: 3200,
    islands: [{ key: 'rangiroa', label: 'Rangiroa' }],
  },
  {
    key: 'australes',
    name: 'Livraison Avion Australes',
    rate: 4100,
    islands: [{ key: 'rurutu', label: 'Rurutu' }],
  },
];

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: DEFAULT_NAME,
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([acme])),
    http.get('/api/v1/aito/shipping/services', () =>
      HttpResponse.json({ services: SHIPPING_SERVICES, catalogue_resolved: true }),
    ),
    // Default: no persons, so the pre-existing `acme` (company) tests keep
    // seeing the plain phone/email inputs, not the picker.
    http.get('/api/v1/zoho/contacts/:id/persons', () => HttpResponse.json([])),
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
      shipping={null}
      onShippingChange={vi.fn()}
      onReuseTasks={vi.fn()}
      preferredPersonId={null}
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
        shipping={null}
        onShippingChange={vi.fn()}
        onReuseTasks={vi.fn()}
        preferredPersonId={null}
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
        shipping={null}
        onShippingChange={vi.fn()}
        onReuseTasks={vi.fn()}
        preferredPersonId={null}
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
        shipping={null}
        onShippingChange={vi.fn()}
        onReuseTasks={vi.fn()}
        preferredPersonId={null}
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

  it('normalizes the phone field on blur without losing the blurred flag', async () => {
    // Regression test: PhoneInput's blur fires onChange(stripped) and onBlur()
    // synchronously in the same native event. ClientSection must merge both
    // into a single onChange, or the second call (built from the stale
    // pre-blur value) clobbers the digit-stripping the first one just did.
    let draft = draftFromContact(acme, DEFAULT_ID);
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
        shipping={null}
        onShippingChange={vi.fn()}
        onReuseTasks={vi.fn()}
        preferredPersonId={null}
      />
    );
    const user = userEvent.setup();
    const { rerender } = render(section(draft));

    const phoneInput = screen.getByLabelText(/^phone/i);
    await user.clear(phoneInput);
    await user.type(phoneInput, '1-2');
    await user.tab();

    expect(screen.getByLabelText(/^phone/i)).toHaveValue('12');
    expect(draft.blurred.phone).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent(/4 and 14 digits/i);
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

  it('does not mark the phone touched while searching the country picker by name', async () => {
    // Regression test: SearchableSelect(allowCustom) used to call onChange on
    // every keystroke, including free-text searches. Typing "France" to find
    // +33 must never reach the draft — it isn't a phone edit, so it must not
    // set touched.phone (which would trigger a Zoho PATCH on submit and
    // silently reformat a contact's stored phone) or corrupt countryCode into
    // literal text like 'Fra'.
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderSection(draftFromContact(acme, DEFAULT_ID), onChange);
    const countryInput = screen.getByRole('combobox', { name: /country code/i });
    await user.click(countryInput);
    await user.type(countryInput, 'France');
    expect(onChange).not.toHaveBeenCalled();
    // The positive half, and the reason this test is named after searching BY
    // NAME: the picker now shows only the dialling code once one is chosen
    // (SearchableSelect's `shortLabel`), so if that short form ever leaked
    // into the option rows the filter would match nothing here and the
    // assertion above would still pass while country search quietly died.
    expect(screen.getByRole('option', { name: '+33 France' })).toBeInTheDocument();
  });

  it('resets the whole draft to the default client', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderSection(draftFromContact(acme, DEFAULT_ID), onChange);
    await user.click(screen.getByRole('button', { name: /default client/i }));
    expect(onChange).toHaveBeenCalledWith(defaultClientDraft(DEFAULT_ID, DEFAULT_NAME));
  });

  it('reveals shipping fields on Add shipping, and clears them on Remove shipping', async () => {
    let shipping: import('../../utils/shippingDraft').ShippingDraft | null = null;
    const section = () => (
      <ClientSection
        value={defaultClientDraft(DEFAULT_ID, DEFAULT_NAME)}
        onChange={vi.fn()}
        onCreateNew={vi.fn()}
        defaultContactId={DEFAULT_ID}
        defaultContactName={DEFAULT_NAME}
        shipping={shipping}
        onShippingChange={(next) => {
          shipping = next;
          rerender(section());
        }}
        onReuseTasks={vi.fn()}
        preferredPersonId={null}
      />
    );
    const user = userEvent.setup();
    const { rerender } = render(section());

    expect(screen.queryByLabelText(/destination island/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add shipping/i }));
    expect(screen.getByLabelText(/destination island/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove shipping/i }));
    expect(screen.queryByLabelText(/destination island/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
  });

  it('reports a picked network and typed handle on the draft', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderSection(defaultClientDraft(DEFAULT_ID, DEFAULT_NAME), onChange);

    await user.click(screen.getByRole('radio', { name: 'Instagram' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ socialNetwork: 'instagram', socialHandle: '' }),
    );
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

const goodRating = {
  tier: 'good', reason: 'punctual',
  settled_count: 8, on_time_count: 8, overdue_count: 0, past_due_count: 0,
  worst_overdue_days: 0, worst_overdue_number: null,
  computed_at: new Date().toISOString(), stale: false,
};

describe('client rating in the drawer', () => {
  it('shows the rating pill beside the chosen client once it resolves', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/v1/aito/clients/:clientId/rating', ({ params }) => {
        seen.push(String(params.clientId));
        return HttpResponse.json(goodRating);
      }),
    );
    renderSection(draftFromContact(acme, DEFAULT_ID));
    expect(await screen.findByText('Good')).toBeInTheDocument();
    expect(seen).toEqual(['z1']);
  });

  it('shows the grey New pill in the drawer (the masthead hides it, the drawer does not)', async () => {
    server.use(
      http.get('/api/v1/aito/clients/:clientId/rating', () =>
        HttpResponse.json({ ...goodRating, tier: 'new', reason: 'new', settled_count: 0, on_time_count: 0 }),
      ),
    );
    renderSection(draftFromContact(acme, DEFAULT_ID));
    expect(await screen.findByText('New')).toBeInTheDocument();
  });

  it('never asks for the walk-in default contact', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/v1/aito/clients/:clientId/rating', ({ params }) => {
        seen.push(String(params.clientId));
        return HttpResponse.json(goodRating);
      }),
    );
    renderSection();
    await waitFor(() => expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue(DEFAULT_NAME));
    expect(seen).toEqual([]);
    expect(screen.queryByText('Good')).not.toBeInTheDocument();
  });
});

const VAEKEHU = {
  contact_person_id: 'cp1', first_name: 'Vaekehu', last_name: 'VARNEY', name: 'Vaekehu VARNEY',
  email: 'vaekehu@snp.pf', phone: '', mobile: '+689-40549958', is_primary: true,
};
const MOANA = {
  contact_person_id: 'cp2', first_name: 'Moana', last_name: 'TERIIPAIA', name: 'Moana TERIIPAIA',
  email: '', phone: '+689-87221043', mobile: '', is_primary: false,
};

/** Controlled harness: feeds every onChange back in, like the drawer does. */
function Harness({ initial, preferred = null }: { initial: ClientDraft; preferred?: string | null | undefined }) {
  const [draft, setDraft] = useState(initial);
  return (
    <ClientSection
      value={draft}
      onChange={setDraft}
      onCreateNew={vi.fn()}
      defaultContactId={DEFAULT_ID}
      defaultContactName={DEFAULT_NAME}
      shipping={null}
      onShippingChange={vi.fn()}
      onReuseTasks={vi.fn()}
      preferredPersonId={preferred}
    />
  );
}

describe('ClientSection — company contacts', () => {
  beforeEach(() => {
    server.use(http.get('/api/v1/zoho/contacts/:id/persons', () => HttpResponse.json([VAEKEHU, MOANA])));
  });

  it('swaps the social chooser for the contact list and hides the plain inputs', async () => {
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} />);
    await screen.findByRole('radio', { name: 'Vaekehu VARNEY' });
    expect(screen.queryByText(/social network/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^phone/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use a different phone/i })).toBeInTheDocument();
  });

  it('an individual gets the contact list too and keeps the social chooser', async () => {
    // An individual is a Books contact with persons like any other (themselves
    // first); the social handle stays because for them it is a real channel.
    const person = { ...acme, customer_sub_type: 'individual' };
    render(<Harness initial={draftFromContact(person, DEFAULT_ID)} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Vaekehu VARNEY' })).toBeChecked());
    expect(screen.getByText(/social network/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^phone/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /use a different phone/i })).toBeInTheDocument();
  });

  it('the walk-in default client has no contact list', async () => {
    render(<Harness initial={defaultClientDraft(DEFAULT_ID, DEFAULT_NAME)} />);
    expect(await screen.findByText(/social network/i)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /contacts/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^phone/i)).toBeInTheDocument();
  });

  it('auto-selects the primary and copies its coordinates', async () => {
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} />);
    const primary = await screen.findByRole('radio', { name: 'Vaekehu VARNEY' });
    await waitFor(() => expect(primary).toBeChecked());
    await userEvent.click(screen.getByRole('button', { name: /use a different phone/i }));
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('40549958');
    expect(screen.getByLabelText(/^email/i)).toHaveValue('vaekehu@snp.pf');
  });

  it('prefers the recalled person over the primary', async () => {
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} preferred="cp2" />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Moana TERIIPAIA' })).toBeChecked());
  });

  it('switching person re-prefills untouched fields and keeps a typed one', async () => {
    const user = userEvent.setup();
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Vaekehu VARNEY' })).toBeChecked());
    await user.click(screen.getByRole('button', { name: /use a different phone/i }));
    await user.clear(screen.getByLabelText(/^email/i));
    await user.type(screen.getByLabelText(/^email/i), 'me@snp.pf');

    await user.click(screen.getByRole('radio', { name: 'Moana TERIIPAIA' }));
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('87221043');
    expect(screen.getByLabelText(/^email/i)).toHaveValue('me@snp.pf');
  });

  it('revert returns to the selected person, not the account', async () => {
    const user = userEvent.setup();
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Vaekehu VARNEY' })).toBeChecked());
    await user.click(screen.getByRole('button', { name: /use a different phone/i }));
    await user.type(screen.getByLabelText(/^phone/i), '9');
    await user.click(screen.getByRole('button', { name: /revert phone/i }));
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('40549958');
  });

  it('an account with no persons shows the add row and the plain inputs', async () => {
    server.use(http.get('/api/v1/zoho/contacts/:id/persons', () => HttpResponse.json([])));
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} />);
    expect(await screen.findByRole('button', { name: /add contact/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('89645864');
    expect(screen.queryByRole('button', { name: /use a different phone/i })).not.toBeInTheDocument();
  });

  it('falls back to the plain inputs with a notice when the list cannot be read', async () => {
    server.use(http.get('/api/v1/zoho/contacts/:id/persons', () => HttpResponse.json({ detail: 'x' }, { status: 502 })));
    render(<Harness initial={draftFromContact(acme, DEFAULT_ID)} />);
    expect(await screen.findByText(/could not read the contacts/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^phone/i)).toHaveValue('89645864');
  });
});
