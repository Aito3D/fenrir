import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ContactPersonPicker } from '../../components/aito/ContactPersonPicker';
import type { ZohoContactPerson } from '../../api/client';

const VAEKEHU: ZohoContactPerson = {
  contact_person_id: 'cp1', first_name: 'Vaekehu', last_name: 'VARNEY', name: 'Vaekehu VARNEY',
  email: 'vaekehu@snp.pf', phone: '', mobile: '+689-40549958', is_primary: true,
};
const MOANA: ZohoContactPerson = {
  contact_person_id: 'cp2', first_name: 'Moana', last_name: 'TERIIPAIA', name: 'Moana TERIIPAIA',
  email: '', phone: '+689-87221043', mobile: '', is_primary: false,
};
const HINA: ZohoContactPerson = {
  contact_person_id: 'cp3', first_name: 'Hina', last_name: 'LO', name: 'Hina LO',
  email: 'hina.lo@snp.pf', phone: '', mobile: '', is_primary: false,
};

function mockPersons(list: ZohoContactPerson[]) {
  server.use(http.get('/api/v1/zoho/contacts/:id/persons', () => HttpResponse.json(list)));
}

const show = (over: Partial<React.ComponentProps<typeof ContactPersonPicker>> = {}) => {
  const onSelect = vi.fn();
  const onLoaded = vi.fn();
  const onUnavailable = vi.fn();
  render(
    <ContactPersonPicker
      contactId="zSNP"
      value={null}
      preferredId={null}
      onSelect={onSelect}
      onLoaded={onLoaded}
      onUnavailable={onUnavailable}
      variant="drawer"
      {...over}
    />,
  );
  return { onSelect, onLoaded, onUnavailable };
};

beforeEach(() => mockPersons([VAEKEHU, MOANA, HINA]));

describe('ContactPersonPicker', () => {
  it('lists the persons with their coordinates and the primary tag', async () => {
    show({ value: 'cp1' });
    const rows = await screen.findAllByRole('radio');
    expect(rows).toHaveLength(3);
    const first = rows[0].closest('label') as HTMLElement;
    expect(within(first).getByText('Vaekehu VARNEY')).toBeInTheDocument();
    expect(within(first).getByText(/40\.54\.99\.58/)).toBeInTheDocument();
    expect(within(first).getByText('vaekehu@snp.pf')).toBeInTheDocument();
    expect(within(first).getByText('primary')).toBeInTheDocument();
    expect(rows[0]).toBeChecked();
  });

  it('auto-selects the preferred person, else the primary, else the first', async () => {
    const a = show({ preferredId: 'cp3' });
    await waitFor(() => expect(a.onSelect).toHaveBeenCalledWith(HINA));
  });

  it('auto-selects the primary when there is no preference', async () => {
    const { onSelect } = show({ preferredId: null });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(VAEKEHU));
  });

  it('falls back to the first row when nobody is primary', async () => {
    mockPersons([MOANA, HINA]);
    const { onSelect } = show({ preferredId: 'nope' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(MOANA));
  });

  it('waits while the preference is unknown', async () => {
    const { onSelect } = show({ preferredId: undefined });
    await screen.findAllByRole('radio');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('never auto-selects when autoSelect is false, even with a value and a preference', async () => {
    const { onSelect } = show({ value: null, preferredId: null, autoSelect: false });
    await screen.findAllByRole('radio');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('radiogroup', { name: /contact/i })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
  });

  it('reports whether the account has persons, and unavailability', async () => {
    const a = show({ value: 'cp1' });
    await waitFor(() => expect(a.onLoaded).toHaveBeenCalledWith(true));
    mockPersons([]);
    const b = show({ contactId: 'zEmpty' });
    await waitFor(() => expect(b.onLoaded).toHaveBeenCalledWith(false));
    server.use(http.get('/api/v1/zoho/contacts/:id/persons', () => HttpResponse.json({ detail: 'x' }, { status: 502 })));
    const c = show({ contactId: 'zDown' });
    await waitFor(() => expect(c.onUnavailable).toHaveBeenCalled());
  });

  it('selects on click', async () => {
    const { onSelect } = show({ value: 'cp1' });
    await userEvent.click(await screen.findByRole('radio', { name: /Moana/ }));
    expect(onSelect).toHaveBeenCalledWith(MOANA);
  });

  describe('add contact', () => {
    it('gates Save on a first name and one channel, then posts and selects', async () => {
      const user = userEvent.setup();
      let posted: unknown = null;
      server.use(
        http.post('/api/v1/zoho/contacts/:id/persons', async ({ request }) => {
          posted = await request.json();
          return HttpResponse.json(HINA, { status: 201 });
        }),
      );
      const { onSelect } = show({ value: 'cp1' });
      await user.click(await screen.findByRole('button', { name: /add contact/i }));
      const save = screen.getByRole('button', { name: /save to zoho/i });
      expect(save).toBeDisabled();
      expect(screen.getByText(/phone number or an email/i)).toBeInTheDocument();

      await user.type(screen.getByLabelText(/first name/i), 'hina');
      await user.tab();
      expect(screen.getByLabelText(/first name/i)).toHaveValue('Hina');
      expect(save).toBeDisabled();

      await user.type(screen.getByLabelText(/last name/i), 'lo');
      await user.tab();
      expect(screen.getByLabelText(/last name/i)).toHaveValue('LO');
      await user.type(screen.getByLabelText(/^email/i), 'hina.lo@snp.pf');
      expect(save).toBeEnabled();

      await user.click(save);
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith(HINA));
      expect(posted).toEqual({ first_name: 'Hina', last_name: 'LO', email: 'hina.lo@snp.pf', phone: '' });
      expect(screen.queryByRole('button', { name: /save to zoho/i })).not.toBeInTheDocument();
      expect(screen.getAllByRole('radio')).toHaveLength(4);
    });

    it('keeps the form open with the server message on failure', async () => {
      const user = userEvent.setup();
      server.use(
        http.post('/api/v1/zoho/contacts/:id/persons', () =>
          HttpResponse.json({ detail: 'Email already in use' }, { status: 409 }),
        ),
      );
      show({ value: 'cp1' });
      await user.click(await screen.findByRole('button', { name: /add contact/i }));
      await user.type(screen.getByLabelText(/first name/i), 'Hina');
      await user.type(screen.getByLabelText(/^email/i), 'dup@snp.pf');
      await user.click(screen.getByRole('button', { name: /save to zoho/i }));
      expect(await screen.findByText('Email already in use')).toBeInTheDocument();
      expect(screen.getByLabelText(/first name/i)).toHaveValue('Hina');
    });

    it('cancel collapses the form and drops what was typed', async () => {
      const user = userEvent.setup();
      show({ value: 'cp1' });
      await user.click(await screen.findByRole('button', { name: /add contact/i }));
      await user.type(screen.getByLabelText(/first name/i), 'Hina');
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByLabelText(/first name/i)).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /add contact/i }));
      expect(screen.getByLabelText(/first name/i)).toHaveValue('');
    });
  });
});
