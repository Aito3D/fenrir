/**
 * Tests for the UsersPage component.
 *
 * Covers the user list rendering, creating a local user, creating a user via
 * the LDAP tab, editing a user's groups and password, and the delete-user
 * confirm flow. Also pins the permission-denied branch shown when the
 * current user lacks `users:read`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { UsersPage } from '../../pages/UsersPage';
import { setAuthToken } from '../../api/client';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockGroups = [
  {
    id: 1,
    name: 'Administrators',
    description: 'Full access',
    permissions: ['printers:read', 'settings:update', 'users:create'],
    is_system: true,
    user_count: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Operators',
    description: 'Control printers',
    permissions: ['printers:read', 'printers:control'],
    is_system: true,
    user_count: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 3,
    name: 'Viewers',
    description: 'Read only',
    permissions: ['printers:read'],
    is_system: true,
    user_count: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

const mockUsers = [
  {
    id: 1,
    username: 'admin',
    email: 'admin@example.com',
    role: 'admin',
    is_active: true,
    is_admin: true,
    auth_source: 'local',
    groups: [{ id: 1, name: 'Administrators' }],
    permissions: [],
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    username: 'bob',
    email: 'bob@example.com',
    role: 'user',
    is_active: true,
    is_admin: false,
    auth_source: 'local',
    groups: [{ id: 2, name: 'Operators' }],
    permissions: [],
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 3,
    username: 'carol',
    role: 'user',
    is_active: false,
    is_admin: false,
    auth_source: 'local',
    groups: [],
    permissions: [],
    created_at: '2024-01-01T00:00:00Z',
  },
];

/**
 * The header "Create User" button and the create-modal's submit button share
 * the exact accessible name "Create User", so a bare getByRole would be
 * ambiguous once the modal is open. Scope the query to the modal card.
 */
async function findCreateModalSubmitButton() {
  const heading = await screen.findByRole('heading', { name: 'Create User' });
  const modal = heading.closest('.animate-modal-in') as HTMLElement;
  return within(modal).getByRole('button', { name: 'Create User' });
}

/**
 * The users table stays mounted behind the create/edit modal overlays, so a
 * group name like "Operators" that also appears as a table badge (bob is a
 * member) would be ambiguous for a bare getByText once the modal is open.
 * Scope the query to the open modal identified by its heading.
 */
function withinModal(headingName: string) {
  const heading = screen.getByRole('heading', { name: headingName });
  const modal = heading.closest('.animate-modal-in') as HTMLElement;
  return within(modal);
}

describe('UsersPage', () => {
  beforeEach(() => {
    // Auth enabled with an authenticated admin (id 1, matching mockUsers[0])
    // so `hasPermission('users:read')` is granted via isAdmin AND the
    // "hide delete for yourself" comparison (`user.id !== currentUser?.id`)
    // has a real currentUser to compare against — with auth disabled the
    // context's `user` stays null and that comparison is always true.
    setAuthToken('test-token', 'session');
    server.use(
      http.get('*/api/v1/auth/status', () =>
        HttpResponse.json({ auth_enabled: true, requires_setup: false })
      ),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 1,
          username: 'admin',
          email: 'admin@example.com',
          role: 'admin',
          is_active: true,
          is_admin: true,
          auth_source: 'local',
          groups: [{ id: 1, name: 'Administrators' }],
          permissions: [],
          created_at: '2024-01-01T00:00:00Z',
        })
      ),
      http.get('/api/v1/users/', () => HttpResponse.json(mockUsers)),
      http.get('/api/v1/groups/', () => HttpResponse.json(mockGroups)),
      http.get('/api/v1/auth/advanced-auth/status', () =>
        HttpResponse.json({
          advanced_auth_enabled: false,
          smtp_configured: false,
          local_login_enabled: true,
          autologin_provider_id: null,
        })
      ),
      http.get('/api/v1/auth/ldap/status', () =>
        HttpResponse.json({ ldap_enabled: false, ldap_configured: false })
      ),
      http.post('/api/v1/users/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 99,
          username: body.username,
          email: body.email ?? null,
          role: body.role ?? 'user',
          is_active: true,
          is_admin: false,
          auth_source: 'local',
          groups: [],
          permissions: [],
          created_at: '2024-01-01T00:00:00Z',
        });
      }),
      http.patch('/api/v1/users/:id', async ({ params, request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const existing = mockUsers.find((u) => u.id === Number(params.id));
        return HttpResponse.json({ ...existing, ...body });
      }),
      http.delete('/api/v1/users/:id', () => HttpResponse.json({ success: true })),
    );
  });

  afterEach(() => {
    setAuthToken(null);
  });

  describe('user list rendering', () => {
    it('renders each user\'s username, group badge, and status', async () => {
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByText('admin')).toBeInTheDocument();
      expect(screen.getByText('carol')).toBeInTheDocument();

      expect(screen.getByText('Operators')).toBeInTheDocument();
      expect(screen.getAllByText('Active')).toHaveLength(2);
      expect(screen.getByText('Inactive')).toBeInTheDocument();
      // admin is flagged via is_admin, not via a group badge
      expect(screen.getByText('Admin')).toBeInTheDocument();
    });

    it('hides the delete action for the current user but shows it for others', async () => {
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });

      const adminRow = screen.getByText('admin').closest('tr')!;
      const bobRow = screen.getByText('bob').closest('tr')!;
      expect(within(adminRow).queryByText('Delete')).not.toBeInTheDocument();
      expect(within(bobRow).getByText('Delete')).toBeInTheDocument();
    });
  });

  describe('create user - local', () => {
    it('disables Create User until username and matching 6+ char passwords are entered', async () => {
      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      await user.click(screen.getByRole('button', { name: /Create User/i }));

      const createButton = await findCreateModalSubmitButton();
      expect(createButton).toBeDisabled();

      await user.type(screen.getByPlaceholderText('Enter username'), 'newuser');
      expect(createButton).toBeDisabled();

      await user.type(screen.getByPlaceholderText('Enter password'), 'short');
      await user.type(screen.getByPlaceholderText('Confirm password'), 'short');
      expect(createButton).toBeDisabled();
    });

    it('shows a mismatch error and disables submit when confirm password differs', async () => {
      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      await user.click(screen.getByRole('button', { name: /Create User/i }));

      await user.type(screen.getByPlaceholderText('Enter username'), 'newuser');
      await user.type(screen.getByPlaceholderText('Enter password'), 'password123');
      await user.type(screen.getByPlaceholderText('Confirm password'), 'password124');

      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      expect(await findCreateModalSubmitButton()).toBeDisabled();
    });

    it('submits the exact create payload and shows the success toast', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/v1/users/', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: 99,
            username: capturedBody.username,
            role: 'user',
            is_active: true,
            is_admin: false,
            auth_source: 'local',
            groups: [],
            permissions: [],
            created_at: '2024-01-01T00:00:00Z',
          });
        })
      );

      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      await user.click(screen.getByRole('button', { name: /Create User/i }));

      await user.type(screen.getByPlaceholderText('Enter username'), 'newuser');
      await user.type(screen.getByPlaceholderText('Enter password'), 'password123');
      await user.type(screen.getByPlaceholderText('Confirm password'), 'password123');
      // Select the Operators group so group_ids is populated.
      const operatorsCheckbox = withinModal('Create User').getByText('Operators').closest('label')!.querySelector('input')!;
      await user.click(operatorsCheckbox);

      await user.click(await findCreateModalSubmitButton());

      await waitFor(() => expect(screen.getByText('User created successfully')).toBeInTheDocument(), { timeout: 5000 });

      expect(capturedBody).toEqual({
        username: 'newuser',
        password: 'password123',
        role: 'user',
        group_ids: [2],
      });

      // Modal closes on success.
      expect(screen.queryByPlaceholderText('Enter username')).not.toBeInTheDocument();
    });
  });

  describe('create user - LDAP tab', () => {
    beforeEach(() => {
      server.use(
        http.get('/api/v1/auth/ldap/status', () =>
          HttpResponse.json({ ldap_enabled: true, ldap_configured: true })
        ),
        http.get('/api/v1/auth/ldap/search', ({ request }) => {
          const url = new URL(request.url);
          const q = url.searchParams.get('q') ?? '';
          if (q !== 'jdoe') return HttpResponse.json([]);
          return HttpResponse.json([
            {
              username: 'jdoe',
              email: 'jdoe@example.com',
              display_name: 'Jane Doe',
              dn: 'cn=jdoe,dc=example,dc=com',
              already_provisioned: false,
            },
          ]);
        })
      );
    });

    it('switches to the LDAP tab and hides the local username field', async () => {
      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      await user.click(screen.getByRole('button', { name: /Create User/i }));

      expect(await screen.findByRole('tab', { name: 'Local' })).toBeInTheDocument();
      // Local tab active by default.
      expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'LDAP' }));

      expect(screen.queryByPlaceholderText('Enter username')).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText('Type a username, name, or email...')).toBeInTheDocument();
    });

    it('searches, selects, and provisions an LDAP user with the exact payload', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/v1/auth/ldap/provision', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: 55,
            username: capturedBody.username,
            role: 'user',
            is_active: true,
            is_admin: false,
            auth_source: 'ldap',
            groups: [],
            permissions: [],
            created_at: '2024-01-01T00:00:00Z',
          });
        })
      );

      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      await user.click(screen.getByRole('button', { name: /Create User/i }));
      await user.click(await screen.findByRole('tab', { name: 'LDAP' }));

      await user.type(screen.getByPlaceholderText('Type a username, name, or email...'), 'jdoe');

      await waitFor(() => expect(screen.getByText('Jane Doe', { exact: false })).toBeInTheDocument(), { timeout: 5000 });

      await user.click(screen.getByRole('button', { name: /jdoe/ }));

      await user.click(screen.getByRole('button', { name: 'Provision user' }));

      await waitFor(
        () => expect(screen.getByText('Provisioned LDAP user "jdoe"')).toBeInTheDocument(),
        { timeout: 5000 }
      );

      expect(capturedBody).toEqual({ username: 'jdoe' });
      // Modal closes on success.
      expect(screen.queryByPlaceholderText('Type a username, name, or email...')).not.toBeInTheDocument();
    });
  });

  describe('edit user', () => {
    it('prefills the edit form with the selected user\'s data', async () => {
      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      const bobRow = screen.getByText('bob').closest('tr')!;
      await user.click(within(bobRow).getByText('Edit'));

      expect(await screen.findByDisplayValue('bob')).toBeInTheDocument();
      expect(screen.getByDisplayValue('bob@example.com')).toBeInTheDocument();
      // Bob's Operators group checkbox should be pre-checked.
      const operatorsCheckbox = withinModal('Edit User').getByText('Operators').closest('label')!.querySelector('input')!;
      expect(operatorsCheckbox).toBeChecked();
    });

    it('sends the exact update payload when a group is toggled', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.patch('/api/v1/users/:id', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ...mockUsers[1], ...capturedBody });
        })
      );

      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      const bobRow = screen.getByText('bob').closest('tr')!;
      await user.click(within(bobRow).getByText('Edit'));

      await screen.findByDisplayValue('bob');
      const viewersCheckbox = screen.getByText('Viewers').closest('label')!.querySelector('input')!;
      await user.click(viewersCheckbox);

      await user.click(screen.getByRole('button', { name: 'Save Changes' }));

      await waitFor(() => expect(screen.getByText('User updated successfully')).toBeInTheDocument(), { timeout: 5000 });

      expect(capturedBody).toEqual({
        username: 'bob',
        email: 'bob@example.com',
        role: 'user',
        group_ids: [2, 3],
      });
    });

    it('rejects a mismatched new password before submit', async () => {
      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      const bobRow = screen.getByText('bob').closest('tr')!;
      await user.click(within(bobRow).getByText('Edit'));

      await screen.findByDisplayValue('bob');
      await user.type(screen.getByPlaceholderText('Enter new password'), 'newpassword1');
      await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpassword2');

      expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    });

    it('sends the new password in the update payload once confirmed', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.patch('/api/v1/users/:id', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ...mockUsers[2], ...capturedBody });
        })
      );

      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('carol')).toBeInTheDocument(), { timeout: 5000 });
      const carolRow = screen.getByText('carol').closest('tr')!;
      await user.click(within(carolRow).getByText('Edit'));

      await screen.findByDisplayValue('carol');
      await user.type(screen.getByPlaceholderText('Enter new password'), 'newpassword1');
      await user.type(screen.getByPlaceholderText('Confirm new password'), 'newpassword1');

      const saveButton = screen.getByRole('button', { name: 'Save Changes' });
      expect(saveButton).not.toBeDisabled();
      await user.click(saveButton);

      await waitFor(() => expect(screen.getByText('User updated successfully')).toBeInTheDocument(), { timeout: 5000 });

      expect(capturedBody).toEqual({
        username: 'carol',
        password: 'newpassword1',
        role: 'user',
        group_ids: [],
      });
    });
  });

  describe('delete user', () => {
    it('opens a confirm dialog and does not call DELETE on cancel', async () => {
      let deleteCalled = false;
      server.use(
        http.delete('/api/v1/users/:id', () => {
          deleteCalled = true;
          return HttpResponse.json({ success: true });
        })
      );

      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      const bobRow = screen.getByText('bob').closest('tr')!;
      await user.click(within(bobRow).getByText('Delete'));

      expect(await screen.findByText('Are you sure you want to delete this user? This action cannot be undone.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Are you sure you want to delete this user? This action cannot be undone.')).not.toBeInTheDocument();
      expect(deleteCalled).toBe(false);
    });

    it('calls DELETE with the correct user id on confirm and shows the success toast', async () => {
      let capturedId: string | null = null;
      server.use(
        http.delete('/api/v1/users/:id', ({ params }) => {
          capturedId = params.id as string;
          return HttpResponse.json({ success: true });
        })
      );

      const user = userEvent.setup();
      render(<UsersPage />);

      await waitFor(() => expect(screen.getByText('bob')).toBeInTheDocument(), { timeout: 5000 });
      const bobRow = screen.getByText('bob').closest('tr')!;
      await user.click(within(bobRow).getByText('Delete'));

      await user.click(await screen.findByRole('button', { name: 'Delete User' }));

      await waitFor(() => expect(screen.getByText('User deleted successfully')).toBeInTheDocument(), { timeout: 5000 });
      expect(capturedId).toBe('2');
    });
  });

  describe('permission denied', () => {
    it('shows the no-permission message when the user lacks users:read', async () => {
      // Override the admin auth set up in the top-level beforeEach with a
      // non-admin user that has no explicit permissions.
      server.use(
        http.get('*/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, requires_setup: false })
        ),
        http.get('*/api/v1/auth/me', () =>
          HttpResponse.json({
            id: 7,
            username: 'operator1',
            role: 'user',
            is_active: true,
            is_admin: false,
            auth_source: 'local',
            groups: [],
            permissions: [],
            created_at: '2024-01-01T00:00:00Z',
          })
        ),
      );

      render(<UsersPage />);

      expect(
        await screen.findByText('You do not have permission to access this page.', {}, { timeout: 5000 })
      ).toBeInTheDocument();
      expect(screen.queryByText('bob')).not.toBeInTheDocument();
    });
  });
});
