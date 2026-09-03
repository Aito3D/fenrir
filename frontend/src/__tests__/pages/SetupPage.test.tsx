/**
 * Tests for the SetupPage component (initial admin creation / enabling auth).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SetupPage } from '../../pages/SetupPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import type { SetupRequest } from '../../api/client';

// Spy on navigation so we can assert the post-setup redirect target.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('SetupPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    // Default: no auth configured yet, setup required. Matches the state
    // the app is actually in when SetupPage is reachable.
    server.use(
      http.get('/api/v1/auth/status', () => {
        return HttpResponse.json({ auth_enabled: false, requires_setup: true });
      })
    );
  });

  it('renders the setup form with auth disabled by default', async () => {
    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Bambuddy Setup' })).toBeInTheDocument();
    });

    const checkbox = screen.getByLabelText('Enable Authentication') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // Admin fields are only rendered once auth is toggled on.
    expect(screen.queryByLabelText(/Admin Username/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete Setup' })).toBeInTheDocument();
  });

  it('reveals admin account fields when Enable Authentication is checked', async () => {
    const user = userEvent.setup();
    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Authentication')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Enable Authentication'));

    expect(screen.getByLabelText(/Admin Username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Admin Password/i)).toBeInTheDocument();
    // Confirm-password field only appears once a password has been typed.
    expect(screen.queryByLabelText(/Confirm Password/i)).not.toBeInTheDocument();
  });

  it('enables auth with a new admin account: sends the exact payload, shows the created-admin toast, and navigates to /login', async () => {
    const user = userEvent.setup();
    let capturedBody: SetupRequest | undefined;

    server.use(
      http.post('/api/v1/auth/setup', async ({ request }) => {
        capturedBody = (await request.json()) as SetupRequest;
        return HttpResponse.json({ auth_enabled: true, admin_created: true });
      })
    );

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Authentication')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Enable Authentication'));
    await user.type(screen.getByLabelText(/Admin Username/i), 'newadmin');
    await user.type(screen.getByLabelText(/Admin Password/i), 'securepass123');
    await user.type(screen.getByLabelText(/Confirm Password/i), 'securepass123');
    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    }, { timeout: 5000 });

    // Exact request payload — no unexpected fields, no truncation of the values.
    expect(capturedBody).toEqual({
      auth_enabled: true,
      admin_username: 'newadmin',
      admin_password: 'securepass123',
    });

    await waitFor(() => {
      expect(screen.getByText('Authentication enabled and admin user created')).toBeInTheDocument();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login');
    }, { timeout: 5000 });
  });

  it('submits with auth disabled: sends auth_enabled false with no credential fields, shows the completed toast, and navigates to /', async () => {
    const user = userEvent.setup();
    let capturedBody: SetupRequest | undefined;

    server.use(
      http.post('/api/v1/auth/setup', async ({ request }) => {
        capturedBody = (await request.json()) as SetupRequest;
        return HttpResponse.json({ auth_enabled: false });
      })
    );

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete Setup' })).toBeInTheDocument();
    });

    // Leave "Enable Authentication" unchecked and submit immediately.
    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    }, { timeout: 5000 });

    // admin_username / admin_password are `undefined` in JS, so JSON.stringify
    // drops them entirely from the wire payload.
    expect(capturedBody).toEqual({ auth_enabled: false });
    expect(capturedBody).not.toHaveProperty('admin_username');
    expect(capturedBody).not.toHaveProperty('admin_password');

    await waitFor(() => {
      expect(screen.getByText('Setup completed')).toBeInTheDocument();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    }, { timeout: 5000 });
  });

  it('admin-already-exists success path: auth_enabled true with admin_created false shows the existing-admins toast and navigates to /login', async () => {
    const user = userEvent.setup();
    let capturedBody: SetupRequest | undefined;

    server.use(
      http.post('/api/v1/auth/setup', async ({ request }) => {
        capturedBody = (await request.json()) as SetupRequest;
        return HttpResponse.json({ auth_enabled: true, admin_created: false });
      })
    );

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Authentication')).toBeInTheDocument();
    });

    // Enable auth but leave the admin fields empty — backend will fall back
    // to using existing admin accounts.
    await user.click(screen.getByLabelText('Enable Authentication'));
    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    }, { timeout: 5000 });
    expect(capturedBody?.auth_enabled).toBe(true);

    await waitFor(() => {
      expect(screen.getByText('Authentication enabled using existing admin users')).toBeInTheDocument();
    }, { timeout: 5000 });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login');
    }, { timeout: 5000 });
    // The success path — never the created-admin toast — for this response shape.
    expect(screen.queryByText('Authentication enabled and admin user created')).not.toBeInTheDocument();
  });

  describe('client-side validation', () => {
    it('shows an error toast and does not submit when password and confirmation do not match', async () => {
      const user = userEvent.setup();
      let setupCalled = false;

      server.use(
        http.post('/api/v1/auth/setup', () => {
          setupCalled = true;
          return HttpResponse.json({ auth_enabled: true, admin_created: true });
        })
      );

      render(<SetupPage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Enable Authentication')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Enable Authentication'));
      await user.type(screen.getByLabelText(/Admin Username/i), 'newadmin');
      await user.type(screen.getByLabelText(/Admin Password/i), 'securepass123');
      await user.type(screen.getByLabelText(/Confirm Password/i), 'differentpass');
      await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

      await waitFor(() => {
        expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
      }, { timeout: 5000 });

      expect(setupCalled).toBe(false);
    });

    it('shows an error toast and does not submit when only the username is provided', async () => {
      const user = userEvent.setup();
      let setupCalled = false;

      server.use(
        http.post('/api/v1/auth/setup', () => {
          setupCalled = true;
          return HttpResponse.json({ auth_enabled: true, admin_created: true });
        })
      );

      render(<SetupPage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Enable Authentication')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Enable Authentication'));
      await user.type(screen.getByLabelText(/Admin Username/i), 'newadmin');
      await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

      await waitFor(() => {
        expect(
          screen.getByText('Please enter both admin username and password, or leave both empty to use existing admin users')
        ).toBeInTheDocument();
      }, { timeout: 5000 });

      expect(setupCalled).toBe(false);
    });

    it('shows an error toast and does not submit when the password is shorter than 6 characters', async () => {
      const user = userEvent.setup();
      let setupCalled = false;

      server.use(
        http.post('/api/v1/auth/setup', () => {
          setupCalled = true;
          return HttpResponse.json({ auth_enabled: true, admin_created: true });
        })
      );

      render(<SetupPage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Enable Authentication')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Enable Authentication'));
      await user.type(screen.getByLabelText(/Admin Username/i), 'newadmin');
      await user.type(screen.getByLabelText(/Admin Password/i), 'abc');
      await user.type(screen.getByLabelText(/Confirm Password/i), 'abc');
      await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

      await waitFor(() => {
        expect(screen.getByText('Password must be at least 6 characters')).toBeInTheDocument();
      }, { timeout: 5000 });

      expect(setupCalled).toBe(false);
    });
  });

  it('shows the server error message when the setup request fails', async () => {
    const user = userEvent.setup();

    server.use(
      http.post('/api/v1/auth/setup', () => {
        return HttpResponse.json({ detail: 'Setup already completed' }, { status: 400 });
      })
    );

    render(<SetupPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete Setup' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Complete Setup' }));

    await waitFor(() => {
      expect(screen.getByText('Setup already completed')).toBeInTheDocument();
    }, { timeout: 5000 });

    // A failed setup must not navigate anywhere.
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
