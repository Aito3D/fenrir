/**
 * Tests for CreateUserAdvancedAuthModal — the create-user modal shown when
 * Advanced Authentication is enabled (email required, password
 * auto-generated), with an optional LDAP tab for provisioning directory
 * users.
 *
 * The component is a controlled form: `formData`/`setFormData` are owned by
 * the caller (UsersPage in production). These tests use a small harness that
 * mirrors that ownership so the local-tab payload shape can be pinned at the
 * moment `onCreate` fires, and the LDAP tab's own network payload is pinned
 * directly since LdapUserPicker issues that request itself.
 */

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CreateUserAdvancedAuthModal } from '../../components/CreateUserAdvancedAuthModal';
import type { Group, UserResponse } from '../../api/client';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockGroups: Group[] = [
  {
    id: 1,
    name: 'Administrators',
    description: 'Full access',
    permissions: ['printers:read'],
    is_system: true,
    user_count: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Operators',
    description: 'Control printers',
    permissions: ['printers:read'],
    is_system: false,
    user_count: 1,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

interface HarnessFormData {
  username: string;
  password?: string;
  email?: string;
  confirmPassword: string;
  role: string;
  group_ids: number[];
}

const emptyFormData: HarnessFormData = {
  username: '',
  password: '',
  email: '',
  confirmPassword: '',
  role: 'user',
  group_ids: [],
};

interface HarnessProps {
  groups?: Group[];
  onClose?: () => void;
  onCreateCalled?: (formData: HarnessFormData) => void;
  isCreating?: boolean;
  isCreateButtonDisabled?: boolean;
  ldapEnabled?: boolean;
  onLdapProvisioned?: (user: UserResponse) => void;
  initialFormData?: HarnessFormData;
}

/**
 * Controlled-form harness matching how UsersPage owns `formData`. `onCreate`
 * is a plain closure (no args, matching the real prop signature) that
 * reports the form state as of the render in which it was invoked — the
 * same snapshot the real caller would build its POST body from.
 */
function Harness({
  groups = mockGroups,
  onClose = () => {},
  onCreateCalled = () => {},
  isCreating = false,
  isCreateButtonDisabled = false,
  ldapEnabled = false,
  onLdapProvisioned,
  initialFormData = emptyFormData,
}: HarnessProps) {
  const [formData, setFormData] = useState<HarnessFormData>(initialFormData);
  return (
    <CreateUserAdvancedAuthModal
      formData={formData}
      setFormData={(data) => setFormData(data as HarnessFormData)}
      groups={groups}
      onClose={onClose}
      onCreate={() => onCreateCalled(formData)}
      isCreating={isCreating}
      isCreateButtonDisabled={isCreateButtonDisabled}
      ldapEnabled={ldapEnabled}
      onLdapProvisioned={onLdapProvisioned}
    />
  );
}

describe('CreateUserAdvancedAuthModal', () => {
  describe('local tab (default)', () => {
    it('renders the advanced-auth header, subtitle, and local form fields, with no tabs when LDAP is disabled', () => {
      render(<Harness />);

      expect(screen.getByRole('heading', { name: 'Create User' })).toBeInTheDocument();
      expect(screen.getByText('with Advanced Authentication')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('user@example.com')).toBeInTheDocument();
      expect(
        screen.getByText('A secure password will be automatically generated and emailed to the user.')
      ).toBeInTheDocument();
      // No password fields in advanced-auth mode.
      expect(screen.queryByPlaceholderText(/password/i)).not.toBeInTheDocument();
      // No tabs when ldapEnabled is false.
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    });

    it('updates formData.username and formData.email as the user types, leaving other fields untouched', async () => {
      const user = userEvent.setup();
      let captured: HarnessFormData | null = null;
      render(<Harness onCreateCalled={(fd) => { captured = fd; }} />);

      await user.type(screen.getByPlaceholderText('Enter username'), 'newuser');
      await user.type(screen.getByPlaceholderText('user@example.com'), 'newuser@example.com');
      await user.click(screen.getByRole('button', { name: 'Create User' }));

      expect(captured).toEqual({
        username: 'newuser',
        password: '',
        email: 'newuser@example.com',
        confirmPassword: '',
        role: 'user',
        group_ids: [],
      });
    });

    it('toggles a group in and out of group_ids and reflects it in the submit payload', async () => {
      const user = userEvent.setup();
      let captured: HarnessFormData | null = null;
      render(<Harness onCreateCalled={(fd) => { captured = fd; }} />);

      const operatorsCheckbox = screen.getByText('Operators').closest('label')!.querySelector('input')!;
      expect(operatorsCheckbox).not.toBeChecked();

      await user.click(operatorsCheckbox);
      expect(operatorsCheckbox).toBeChecked();

      const adminsCheckbox = screen.getByText('Administrators').closest('label')!.querySelector('input')!;
      await user.click(adminsCheckbox);

      await user.click(screen.getByRole('button', { name: 'Create User' }));
      expect(captured).not.toBeNull();
      expect(captured!.group_ids).toEqual([2, 1]);

      // Un-toggling Operators removes only that id.
      await user.click(operatorsCheckbox);
      await user.click(screen.getByRole('button', { name: 'Create User' }));
      expect(captured!.group_ids).toEqual([1]);
    });

    it('flags the system group with a "(System)" badge but not a non-system group', () => {
      render(<Harness />);

      const adminLabel = screen.getByText('Administrators').closest('label')!;
      expect(adminLabel).toHaveTextContent('(System)');
      const operatorsLabel = screen.getByText('Operators').closest('label')!;
      expect(operatorsLabel).not.toHaveTextContent('(System)');
    });

    it('shows the empty-groups message when no groups are passed', () => {
      render(<Harness groups={[]} />);

      expect(screen.getByText('No groups available')).toBeInTheDocument();
      expect(screen.queryByText('Administrators')).not.toBeInTheDocument();
    });

    it('shows a spinner and "Creating..." label while isCreating is true, and disables the button per isCreateButtonDisabled', () => {
      const { rerender } = render(<Harness isCreating={false} isCreateButtonDisabled={false} />);
      expect(screen.getByRole('button', { name: 'Create User' })).toBeEnabled();
      expect(screen.queryByText('Creating...')).not.toBeInTheDocument();

      rerender(<Harness isCreating={true} isCreateButtonDisabled={true} />);
      expect(screen.getByText('Creating...')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Creating...' })).toBeDisabled();
    });

    it('does not call onCreate when the button is disabled', async () => {
      const user = userEvent.setup();
      const onCreateCalled = vi.fn();
      render(<Harness isCreateButtonDisabled={true} onCreateCalled={onCreateCalled} />);

      await user.click(screen.getByRole('button', { name: 'Create User' }));
      expect(onCreateCalled).not.toHaveBeenCalled();
    });

    it('calls onClose when Cancel is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<Harness onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when the backdrop is clicked, but not when the card itself is clicked', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      const { container } = render(<Harness onClose={onClose} />);

      const heading = screen.getByRole('heading', { name: 'Create User' });
      await user.click(heading);
      expect(onClose).not.toHaveBeenCalled();

      const backdrop = container.querySelector('.animate-overlay-in') as HTMLElement;
      await user.click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose on Escape', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(<Harness onClose={onClose} />);

      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('tabs (ldapEnabled=true)', () => {
    it('renders a tablist with Local active by default and LDAP inactive', () => {
      render(<Harness ldapEnabled={true} />);

      const tablist = screen.getByRole('tablist', { name: 'User source' });
      expect(tablist).toBeInTheDocument();
      const localTab = screen.getByRole('tab', { name: 'Local' });
      const ldapTab = screen.getByRole('tab', { name: 'LDAP' });
      expect(localTab).toHaveAttribute('aria-selected', 'true');
      expect(ldapTab).toHaveAttribute('aria-selected', 'false');
      // Local fields still visible.
      expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    });

    it('switches to the LDAP tab: hides local fields and the local Create button, shows the LDAP search UI', async () => {
      const user = userEvent.setup();
      render(<Harness ldapEnabled={true} />);

      await user.click(screen.getByRole('tab', { name: 'LDAP' }));

      expect(screen.getByRole('tab', { name: 'LDAP' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Local' })).toHaveAttribute('aria-selected', 'false');
      expect(screen.queryByPlaceholderText('Enter username')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('user@example.com')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create User' })).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText('Type a username, name, or email...')).toBeInTheDocument();
      // Cancel remains available on every tab.
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('switching back to Local restores the fields and preserves formData entered before the switch', async () => {
      const user = userEvent.setup();
      render(<Harness ldapEnabled={true} />);

      await user.type(screen.getByPlaceholderText('Enter username'), 'preserved');
      await user.click(screen.getByRole('tab', { name: 'LDAP' }));
      await user.click(screen.getByRole('tab', { name: 'Local' }));

      expect(screen.getByPlaceholderText('Enter username')).toHaveValue('preserved');
    });
  });

  describe('LDAP tab provisioning flow', () => {
    it('searches, selects a result, and provisions with the exact request payload, reporting the created user back through onLdapProvisioned', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
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
        }),
        http.post('/api/v1/auth/ldap/provision', async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            id: 55,
            username: 'jdoe',
            email: 'jdoe@example.com',
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
      let provisionedUser: UserResponse | null = null;
      render(<Harness ldapEnabled={true} onLdapProvisioned={(u) => { provisionedUser = u; }} />);

      await user.click(screen.getByRole('tab', { name: 'LDAP' }));
      await user.type(screen.getByPlaceholderText('Type a username, name, or email...'), 'jdoe');

      await waitFor(
        () => expect(screen.getByText('Jane Doe', { exact: false })).toBeInTheDocument(),
        { timeout: 5000 }
      );

      await user.click(screen.getByRole('button', { name: /jdoe/ }));
      await user.click(screen.getByRole('button', { name: 'Provision user' }));

      await waitFor(() => expect(capturedBody).toEqual({ username: 'jdoe' }), { timeout: 5000 });
      await waitFor(() => expect(provisionedUser).not.toBeNull(), { timeout: 5000 });
      expect(provisionedUser).toEqual({
        id: 55,
        username: 'jdoe',
        email: 'jdoe@example.com',
        role: 'user',
        is_active: true,
        is_admin: false,
        auth_source: 'ldap',
        groups: [],
        permissions: [],
        created_at: '2024-01-01T00:00:00Z',
      });
    });

    it('surfaces the provisioning error message and does not call onLdapProvisioned when the request fails', async () => {
      server.use(
        http.get('/api/v1/auth/ldap/search', () =>
          HttpResponse.json([
            {
              username: 'jdoe',
              email: null,
              display_name: null,
              dn: 'cn=jdoe,dc=example,dc=com',
              already_provisioned: false,
            },
          ])
        ),
        http.post('/api/v1/auth/ldap/provision', () =>
          HttpResponse.json({ detail: 'LDAP bind failed' }, { status: 500 })
        )
      );

      const user = userEvent.setup();
      const onLdapProvisioned = vi.fn();
      render(<Harness ldapEnabled={true} onLdapProvisioned={onLdapProvisioned} />);

      await user.click(screen.getByRole('tab', { name: 'LDAP' }));
      await user.type(screen.getByPlaceholderText('Type a username, name, or email...'), 'jdoe');

      await waitFor(
        () => expect(screen.getByRole('button', { name: /jdoe/ })).toBeInTheDocument(),
        { timeout: 5000 }
      );
      await user.click(screen.getByRole('button', { name: /jdoe/ }));
      await user.click(screen.getByRole('button', { name: 'Provision user' }));

      await waitFor(
        () => expect(screen.getByText('LDAP bind failed')).toBeInTheDocument(),
        { timeout: 5000 }
      );
      expect(onLdapProvisioned).not.toHaveBeenCalled();
    });
  });
});
