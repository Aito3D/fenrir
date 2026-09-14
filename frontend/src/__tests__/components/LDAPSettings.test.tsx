/**
 * Tests for LDAPSettings — the LDAP authentication configuration panel.
 *
 * Covers handleSave's required-field validation (blocking the save call
 * rather than merely showing a toast), the bind-password-only-if-entered
 * payload behavior, and handleToggle's two refusal guards (auth disabled /
 * LDAP not yet configured).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { LDAPSettings } from '../../components/LDAPSettings';
import { server } from '../mocks/server';

describe('LDAPSettings', () => {
  let putBodies: Record<string, unknown>[];

  beforeEach(() => {
    putBodies = [];

    server.use(
      // No LDAP settings saved yet — the component keeps its blank defaults.
      http.get('/api/v1/settings/', () => HttpResponse.json({})),
      http.put('/api/v1/settings/', async ({ request }) => {
        putBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ message: 'saved' });
      }),
      http.get('/api/v1/auth/ldap/status', () =>
        HttpResponse.json({ ldap_enabled: false, ldap_configured: false }),
      ),
      http.get('/api/v1/groups/', () => HttpResponse.json([])),
      // Auth disabled by default (matches the default handler, made
      // explicit here since the "refuses when disabled" test depends on it).
      http.get('*/api/v1/auth/status', () =>
        HttpResponse.json({ auth_enabled: false, requires_setup: false }),
      ),
    );
  });

  it('shows a required-fields toast and does not save when the server URL is blank', async () => {
    const user = userEvent.setup();
    render(<LDAPSettings />);

    const saveButton = await screen.findByRole('button', { name: 'Save' });
    await user.click(saveButton);

    expect(await screen.findByText('LDAP server URL is required')).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it('shows a search-base-required toast and does not save when only the search base is blank', async () => {
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.type(
      await screen.findByPlaceholderText('ldaps://ldap.example.com:636'),
      'ldaps://ldap.example.com',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Search base DN is required')).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it('omits ldap_bind_password from the payload when the field is left blank', async () => {
    const user = userEvent.setup();
    render(<LDAPSettings />);

    await user.type(
      await screen.findByPlaceholderText('ldaps://ldap.example.com:636'),
      'ldaps://ldap.example.com',
    );
    await user.type(
      screen.getByPlaceholderText('ou=users,dc=example,dc=com'),
      'ou=users,dc=example,dc=com',
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toEqual({
      ldap_server_url: 'ldaps://ldap.example.com',
      ldap_bind_dn: '',
      ldap_search_base: 'ou=users,dc=example,dc=com',
      ldap_user_filter: '(sAMAccountName={username})',
      ldap_security: 'starttls',
      ldap_group_mapping: '',
      ldap_auto_provision: false,
      ldap_default_group: '',
    });
    expect(putBodies[0]).not.toHaveProperty('ldap_bind_password');
    expect(await screen.findByText('LDAP settings saved')).toBeInTheDocument();
  });

  it('includes ldap_bind_password in the payload when the field is typed', async () => {
    const user = userEvent.setup();
    const { container } = render(<LDAPSettings />);

    await user.type(
      await screen.findByPlaceholderText('ldaps://ldap.example.com:636'),
      'ldaps://ldap.example.com',
    );
    await user.type(
      screen.getByPlaceholderText('ou=users,dc=example,dc=com'),
      'ou=users,dc=example,dc=com',
    );
    // The bind-password field's placeholder is only set once a bind DN is
    // already saved, so it has no stable placeholder text here — select it
    // by input type instead.
    const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
    await user.type(passwordInput, 'secret123');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({
      ldap_server_url: 'ldaps://ldap.example.com',
      ldap_search_base: 'ou=users,dc=example,dc=com',
      ldap_bind_password: 'secret123',
    });
  });

  it('refuses to toggle LDAP when authentication is disabled', async () => {
    const user = userEvent.setup();
    render(<LDAPSettings />);

    const enableButton = await screen.findByRole('button', { name: 'Enable' });
    await user.click(enableButton);

    expect(await screen.findByText('Enable authentication first')).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it('refuses to toggle LDAP when it has not been configured yet', async () => {
    server.use(
      http.get('*/api/v1/auth/status', () =>
        HttpResponse.json({ auth_enabled: true, requires_setup: false }),
      ),
      // Neither enabled nor configured — the default from beforeEach also
      // covers this, kept explicit here since this test's assertion depends
      // on it.
      http.get('/api/v1/auth/ldap/status', () =>
        HttpResponse.json({ ldap_enabled: false, ldap_configured: false }),
      ),
    );

    const user = userEvent.setup();
    render(<LDAPSettings />);

    const enableButton = await screen.findByRole('button', { name: 'Enable' });
    await user.click(enableButton);

    expect(await screen.findByText('Save LDAP settings first')).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });
});
